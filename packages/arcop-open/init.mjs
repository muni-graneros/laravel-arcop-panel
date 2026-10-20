import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {randomBytes} from 'node:crypto';
const env=readFileSync('.env.example','utf8').replace('PII_KEY=GENERAR','PII_KEY='+randomBytes(32).toString('hex')).replace('SUBJECT_HMAC_KEY=GENERAR','SUBJECT_HMAC_KEY='+randomBytes(32).toString('hex'));
writeFileSync('.env',env,{flag:'wx',mode:0o600});mkdirSync('certs',{recursive:true});console.log('Created .env without overwriting; configure database, OIDC and embedding origins.');
