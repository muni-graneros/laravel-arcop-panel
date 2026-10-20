import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {randomBytes,generateKeyPairSync} from 'node:crypto';
if(existsSync('.env')||existsSync('secrets/report-private.pem'))throw new Error('Refusing to replace existing secrets');
const env=readFileSync('.env.example','utf8').replace('PII_KEY=GENERAR','PII_KEY='+randomBytes(32).toString('hex')).replace('SUBJECT_HMAC_KEY=GENERAR','SUBJECT_HMAC_KEY='+randomBytes(32).toString('hex'));
mkdirSync('secrets',{recursive:true,mode:0o700});mkdirSync('certs',{recursive:true});const {privateKey,publicKey}=generateKeyPairSync('ed25519');
writeFileSync('.env',env,{mode:0o600,flag:'wx'});writeFileSync('secrets/report-private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});writeFileSync('secrets/report-public.pem',publicKey.export({type:'spki',format:'pem'}),{mode:0o644,flag:'wx'});console.log('Generated .env and signing keys; edit endpoint values and retain encrypted backup. No secrets printed.');
