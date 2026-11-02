'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dependencies = Object.keys(packageJson.dependencies || {});

const envSetup = spawnSync(process.execPath, [path.join(root, 'setup-env.js')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
if (envSetup.error || envSetup.status !== 0) {
  console.error(`No se pudo preparar .env${envSetup.error ? `: ${envSetup.error.message}` : '.'}`);
  process.exit(typeof envSetup.status === 'number' ? envSetup.status : 1);
}

const missing = dependencies.filter((name) => {
  try {
    require.resolve(name, { paths: [root] });
    return false;
  } catch {
    return true;
  }
});

if (missing.length === 0) process.exit(0);

if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
  console.error('Falta package-lock.json; no se pueden instalar las dependencias de forma segura.');
  process.exit(1);
}

console.log(`Faltan dependencias (${missing.join(', ')}). Instalando con npm ci; se necesita internet...`);
const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: true
});

if (result.error) {
  console.error(`No se pudo ejecutar npm ci: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('No se pudieron instalar las dependencias. Revisa la conexion a internet y vuelve a ejecutar npm start.');
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

console.log('Dependencias instaladas. Continuando con Finora...');
