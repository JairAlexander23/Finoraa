'use strict';
const fs=require('fs');
const crypto=require('crypto');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13)){console.error('Finora necesita Node.js 22.13 o superior. Instala Node.js LTS y vuelve a abrir Iniciar-Finora.bat.');process.exit(1);}
if(!fs.existsSync('.env')){
  let env=fs.readFileSync('.env.example','utf8');
  env=env.replace(/^JWT_SECRET=.*$/m,`JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`);
  fs.writeFileSync('.env',env,{flag:'wx'});
  console.log('Se cre? .env con un JWT_SECRET aleatorio.');
} else {
  console.log('Ya existe .env; se conserv? sin cambios.');
}
