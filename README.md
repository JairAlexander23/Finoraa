# Finora

Proyecto web de finanzas personales con servidor Node.js/Express y base de datos SQLite.

## Archivos que se suben a GitHub

La carpeta contiene el código, `package.json` y `package-lock.json`, el sitio de `public/`, el archivo `render.yaml` y los archivos para iniciar Finora localmente. No contiene `.env`, `node_modules` ni la base de datos local. El `.gitignore` también los excluye.

## Subir con GitHub Desktop

1. Instala y abre [GitHub Desktop](https://desktop.github.com/) e inicia sesión en GitHub.
2. Selecciona **File > Add Local Repository** y elige esta carpeta (`finora-github`). Si indica que aún no es repositorio, elige la opción para crear uno en esa carpeta.
3. Revisa la lista de archivos y confirma que no aparezcan `.env`, `node_modules` ni `data/`.
4. Escribe un mensaje de commit, pulsa **Commit to main** y después **Publish repository**. Puedes dejarlo privado.

## Ejecutar localmente

Instala Node.js 22.13 o superior y ejecuta `npm start` en esta carpeta, o abre `Iniciar-Finora.bat` en Windows.

Para configurar secretos locales, copia `.env.example` como `.env` y rellena allí las variables. No subas `.env` a GitHub.

## Desplegar en Render

El archivo `render.yaml` describe el servicio de Finora. En Render crea un **Blueprint** desde el repositorio de GitHub o crea un **Web Service** conectado al repositorio. Render puede construir y ejecutar la app con `npm ci` y `npm start`.

La configuración incluida solicita un servicio Starter con un disco persistente en `/var/data` para conservar SQLite. Revisa el precio del plan en Render antes de confirmar la creación del servicio.

En el panel del servicio configura `RESEND_API_KEY`, `EMAIL_FROM` y `APP_BASE_URL`. Para que el enlace de verificación vuelva a la app, `APP_BASE_URL` debe ser la URL pública HTTPS asignada por Render. Resend exige un dominio remitente verificado para enviar a usuarios en general; el remitente de prueba solo sirve para la dirección asociada a la cuenta Resend.
