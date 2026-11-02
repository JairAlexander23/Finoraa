@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo No se encontro Node.js ni winget. Abriendo descarga de Node.js LTS...
    start "" "https://nodejs.org/en/download"
    echo Instala Node.js 22.13 o superior y vuelve a abrir este archivo.
    pause
    exit /b 1
  )
  echo Instalando Node.js LTS, necesario para Finora...
  winget install --id OpenJS.NodeJS.LTS --exact --scope user --silent --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo No se pudo instalar Node.js automaticamente. Instala Node.js 22.13 o superior desde nodejs.org.
    pause
    exit /b 1
  )
  echo Node.js instalado. Cierra esta ventana y abre Iniciar-Finora.bat otra vez.
  pause
  exit /b 0
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Finora necesita Node.js 22.13 o superior. Abriendo la descarga...
  start "" "https://nodejs.org/en/download"
  echo Actualiza Node.js y vuelve a abrir Iniciar-Finora.bat.
  pause
  exit /b 1
)
node setup-env.js
if errorlevel 1 (
  echo No se pudo preparar .env. Instala Node.js 22.13 o superior y vuelve a intentarlo.
  pause
  exit /b 1
)
node -e "for(const p of ['dotenv','express','bcryptjs','cookie-parser','express-rate-limit','helmet','jsonwebtoken'])require.resolve(p)" >nul 2>nul
if errorlevel 1 (
  echo Instalando dependencias de Finora (solo la primera vez)...
  call npm ci
  if errorlevel 1 (
    echo Fallo la instalacion de dependencias. Revisa tu conexion a internet.
    pause
    exit /b 1
  )
)
echo Iniciando el servidor de Finora...
start "Finora - servidor" /D "%~dp0" cmd /k "npm start"

echo Esperando a que Finora responda...
set /a intentos=0
:esperar_finora
curl.exe --silent --fail http://localhost:3000/ >nul 2>nul
if not errorlevel 1 goto abrir_finora
set /a intentos+=1
if %intentos% geq 90 goto error_finora
timeout /t 1 /nobreak >nul
goto esperar_finora

:error_finora
echo Finora no respondio despues de 90 segundos. Revisa la ventana "Finora - servidor" para ver el error.
pause
exit /b 1

:abrir_finora
start "" "microsoft-edge:http://localhost:3000"
echo Finora esta lista en http://localhost:3000.
endlocal
exit /b 0
