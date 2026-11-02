'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite'); // SQLite incluido en Node 22.13+ (sin compilar nada)

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'finora.db');
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (PROD) { console.error('Falta JWT_SECRET en producción.'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[aviso] JWT_SECRET no definido: se usa uno temporal (las sesiones se pierden al reiniciar).');
}

/* ---------- Base de datos ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// Las cuentas existentes se consideran verificadas al migrar, sin bloquear el acceso.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
if (!userColumns.has('auth_version')) db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS password_resets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);`);
const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT id,email,nombre,apellido,email_verified,auth_version FROM users WHERE id = ?'),
  insert: db.prepare('INSERT INTO users (email,nombre,apellido,password_hash,email_verified) VALUES (?,?,?,?,0)'),
  getState: db.prepare('SELECT state_json FROM user_state WHERE user_id = ?'),
  putState: db.prepare(`INSERT INTO user_state (user_id,state_json,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setVerification: db.prepare(`INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at`),
  getVerification: db.prepare('SELECT user_id FROM email_verifications WHERE token_hash=? AND expires_at>?'),
  delVerification: db.prepare('DELETE FROM email_verifications WHERE user_id=?'),
  verifyUser: db.prepare('UPDATE users SET email_verified=1 WHERE id=?'),
  setReset: db.prepare(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at`),
  getReset: db.prepare('SELECT user_id FROM password_resets WHERE token_hash=? AND expires_at>?'),
  delReset: db.prepare('DELETE FROM password_resets WHERE user_id=?'),
  changePassword: db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?'),
};

/* ---------- App ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
// CSP desactivada porque el frontend usa manejadores inline (onclick=...). Ver README.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {          // anti-CSRF básico: si envían cuerpo, debe ser JSON
  const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && hasBody && !req.is('application/json'))
    return res.status(415).json({ error: 'Content-Type debe ser application/json.' });
  next();
});
app.use(express.json({ limit: '1mb' }));

const COOKIE = 'finora_token';
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 24 * 3600 * 1000, path: '/' };
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12); // evita filtrar si el correo existe por tiempo de respuesta
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const makeToken = () => crypto.randomBytes(32).toString('base64url');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function baseUrlFor(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  if (PROD) throw new Error('APP_BASE_URL_NOT_CONFIGURED');
  const host = req.get('host') || 'localhost:3000';
  const match = host.match(/^([^:]+)(:\d{1,5})?$/);
  const name = match?.[1] || '';
  const parts = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIp = parts && parts.every((part) => part >= 0 && part <= 255) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (!/^(localhost|\[::1\])$/i.test(name) && !privateIp) throw new Error('APP_BASE_URL_NOT_CONFIGURED');
  return `http://${host}`;
}
async function sendTransactionalEmail(to, subject, html, text) {
  if (!RESEND_API_KEY || !EMAIL_FROM) throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    console.error('[email] El proveedor rechazó el envío. HTTP', response.status);
    throw new Error('EMAIL_DELIVERY_FAILED');
  }
}
function emailActionMarkup(title, intro, url, action) {
  const safeUrl = escapeHtml(url);
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;padding:32px;border:1px solid #e8eaf0;border-radius:20px;color:#17192b"><div style="font-size:24px;font-weight:800;color:#059669">Finora</div><h1 style="font-size:22px;margin:24px 0 10px">${escapeHtml(title)}</h1><p style="line-height:1.6;color:#696e82">${escapeHtml(intro)}</p><p style="margin:28px 0"><a href="${safeUrl}" style="background:#059669;color:#fff;padding:13px 20px;border-radius:12px;text-decoration:none;font-weight:700">${escapeHtml(action)}</a></p><p style="font-size:12px;color:#8b90a2">Si el botón no funciona, copia este enlace:<br><a href="${safeUrl}">${safeUrl}</a></p><p style="font-size:12px;color:#8b90a2">Si no solicitaste esto, puedes ignorar este mensaje.</p></div>`;
}
async function sendVerificationEmail(req, user) {
  const token = makeToken();
  q.setVerification.run(user.id, tokenHash(token), Date.now() + 24 * 60 * 60 * 1000);
  const url = `${baseUrlFor(req)}/api/verify-email?token=${encodeURIComponent(token)}`;
  const intro = 'Confirma que tienes acceso a esta dirección para activar tu cuenta de Finora.';
  await sendTransactionalEmail(user.email, 'Verifica tu cuenta de Finora', emailActionMarkup('Verifica tu correo', intro, url, 'Verificar mi cuenta'), intro);
}

function auth(req, res, next) {
  try {
    const { sub, ver = 0 } = jwt.verify(req.cookies[COOKIE] || '', SECRET);
    const user = q.byId.get(sub);
    if (!user || user.email_verified !== 1 || ver !== user.auth_version) throw new Error('invalid session');
    req.user = user; next();
  } catch { res.status(401).json({ error: 'No autenticado.' }); }
}

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const nombre = clean(req.body.nombre, 60), apellido = clean(req.body.apellido, 60);
    const email = clean(req.body.email, 120).toLowerCase();
    const password = String(req.body.password ?? '');
    if (!nombre || !apellido) return res.status(400).json({ error: 'Escribe tu nombre y apellido.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ingresa un correo electrónico válido.' });
    if (password.length < 8 || Buffer.byteLength(password) > 72)
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 72 caracteres.' });
    let user = q.byEmail.get(email);
    if (user?.email_verified) return res.status(409).json({ error: 'Ya existe una cuenta verificada con ese correo.' });
    if (!user) {
      const hash = await bcrypt.hash(password, 12);
      try {
        const result = q.insert.run(email, nombre, apellido, hash);
        user = q.byId.get(Number(result.lastInsertRowid));
      } catch (e) {
        if (e.errcode === 2067 || e.errcode === 1555 || /UNIQUE constraint failed/i.test(String(e.message)))
          return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
        throw e;
      }
    }
    try { await sendVerificationEmail(req, user); }
    catch (e) {
      const message = e.message === 'EMAIL_PROVIDER_NOT_CONFIGURED'
        ? 'El envío de correo aún no está configurado. Configura RESEND_API_KEY y EMAIL_FROM en .env.'
        : 'No se pudo enviar el correo de verificación. Revisa el servicio de correo e inténtalo de nuevo.';
      return res.status(503).json({ error: message });
    }
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.redirect('/?verified=invalid');
  const record = q.getVerification.get(tokenHash(token), Date.now());
  if (!record) return res.redirect('/?verified=expired');
  q.verifyUser.run(record.user_id);
  q.delVerification.run(record.user_id);
  res.redirect('/?verified=1');
});

app.post('/api/password/forgot', authLimiter, async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ingresa un correo electrónico válido.' });
  if (!RESEND_API_KEY || !EMAIL_FROM) return res.status(503).json({ error: 'La recuperación por correo aún no está configurada.' });
  const user = q.byEmail.get(email);
  if (user?.email_verified) {
    try {
      const token = makeToken();
      q.setReset.run(user.id, tokenHash(token), Date.now() + 60 * 60 * 1000);
      const url = `${baseUrlFor(req)}/?reset=${encodeURIComponent(token)}`;
      const intro = 'El enlace para recuperar tu contraseña vence en una hora.';
      await sendTransactionalEmail(user.email, 'Recupera tu contraseña de Finora', emailActionMarkup('Recupera tu contraseña', intro, url, 'Crear contraseña nueva'), intro);
    } catch (e) {
      console.error('[email] No se pudo enviar la recuperación:', e.message);
      return res.status(503).json({ error: 'No se pudo enviar el correo. Intenta más tarde.' });
    }
  }
  res.json({ ok: true });
});

app.post('/api/password/reset', authLimiter, async (req, res, next) => {
  try {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return res.status(400).json({ error: 'El enlace no es válido o venció.' });
    if (password.length < 8 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 72 caracteres.' });
    const record = q.getReset.get(tokenHash(token), Date.now());
    if (!record) return res.status(400).json({ error: 'El enlace no es válido o venció.' });
    const hash = await bcrypt.hash(password, 12);
    q.changePassword.run(hash, record.user_id);
    q.delReset.run(record.user_id);
    q.delVerification.run(record.user_id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/password/change', auth, async (req, res, next) => {
  try {
    const current = String(req.body.currentPassword || '');
    const password = String(req.body.password || '');
    if (password.length < 8 || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'La nueva contraseña debe tener entre 8 y 72 caracteres.' });
    const row = q.byEmail.get(req.user.email);
    if (!(await bcrypt.compare(current, row.password_hash))) return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
    if (await bcrypt.compare(password, row.password_hash)) return res.status(400).json({ error: 'La nueva contraseña debe ser diferente a la actual.' });
    const hash = await bcrypt.hash(password, 12);
    q.changePassword.run(hash, row.id);
    const token = jwt.sign({ sub: row.id, ver: row.auth_version + 1 }, SECRET, { expiresIn: '7d' });
    res.cookie(COOKIE, token, cookieOpts);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const email = clean(req.body.email, 120).toLowerCase();
    const password = String(req.body.password ?? '');
    const row = q.byEmail.get(email);
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    if (!row.email_verified) return res.status(403).json({ error: 'Debes verificar tu correo con el enlace que enviamos antes de iniciar sesión.' });
    const token = jwt.sign({ sub: row.id, ver: row.auth_version }, SECRET, { expiresIn: '7d' });
    res.cookie(COOKIE, token, cookieOpts);
    res.json({ user: { email: row.email, nombre: row.nombre, apellido: row.apellido, emailVerified: true } });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ user: { email: req.user.email, nombre: req.user.nombre, apellido: req.user.apellido, emailVerified: true } }));

const assistantLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Espera un momento antes de volver a preguntarle a Finora.' } });
app.get('/api/assistant/status', auth, (req, res) => res.json({ enabled: Boolean(GROQ_API_KEY), model: GROQ_MODEL }));
app.post('/api/assistant', auth, assistantLimiter, async (req, res) => {
  if (!GROQ_API_KEY) return res.status(503).json({ error: 'La IA no está configurada. Añade GROQ_API_KEY al archivo .env y reinicia Finora.' });
  const messages = req.body?.messages;
  const tools = req.body?.tools;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20 ||
      messages.some(m => !m || !['system','user','assistant','tool'].includes(m.role) ||
        (m.content != null && (typeof m.content !== 'string' || m.content.length > 12000)) ||
        (m.role !== 'assistant' && typeof m.content !== 'string')) ||
      messages.reduce((n,m)=>n+(typeof m.content==='string'?m.content.length:0),0) > 45000)
    return res.status(400).json({ error: 'La conversación es demasiado larga o tiene un formato inválido.' });
  const safeMessages = messages.map(m => ({ ...m, content: m.content ?? '' }));
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > 12 || tools.some(t => t?.type !== 'function' || !/^[a-z0-9_]{1,64}$/.test(t.function?.name || '') || !t.function.parameters || typeof t.function.parameters !== 'object')))
    return res.status(400).json({ error: 'Las acciones disponibles tienen un formato inválido.' });
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, messages: safeMessages, ...(tools?.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}), max_tokens: 1200 }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      if (upstream.status === 429) return res.status(429).json({ error: 'Se alcanzó el límite gratuito de la IA. Intenta más tarde.' });
      console.error('[assistant] Groq respondió HTTP', upstream.status, data?.error?.message || '');
      return res.status(502).json({ error: 'La IA no pudo responder en este momento. Intenta de nuevo.' });
    }
    const message = data?.choices?.[0]?.message;
    if (!message) return res.status(502).json({ error: 'La IA devolvió una respuesta vacía. Intenta de nuevo.' });
    res.json({ message });
  } catch (e) {
    console.error('[assistant] No se pudo conectar con Groq:', e.name);
    res.status(502).json({ error: 'No se pudo conectar con la IA. Revisa la conexión e intenta de nuevo.' });
  }
});

app.get('/api/state', auth, (req, res) => {
  const row = q.getState.get(req.user.id);
  res.json({ state: row ? JSON.parse(row.state_json) : null });
});
app.put('/api/state', auth, (req, res) => {
  const s = req.body && req.body.state;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return res.status(400).json({ error: 'Estado inválido.' });
  const safeState = { ...s, perfil: { ...(s.perfil || {}), email: req.user.email } };
  q.putState.run(req.user.id, JSON.stringify(safeState));
  res.json({ ok: true });
});
app.delete('/api/account', auth, async (req, res, next) => {   // borrar cuenta y todos sus datos
  try {
    const row = q.byEmail.get(req.user.email);
    if (!(await bcrypt.compare(String(req.body.password ?? ''), row.password_hash)))
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    q.delUser.run(req.user.id);
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {                              // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Datos demasiado grandes.' });
  console.error(err); res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) app.listen(PORT, () => console.log(`Finora en http://localhost:${PORT}`));
module.exports = app;
