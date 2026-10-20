import {readFileSync} from 'node:fs';import {verifyReport} from '../server/report.js';
if(process.argv.length!==5)throw new Error('Usage: node scripts/verify-report.mjs REPORT.pdf MANIFEST.json TRUSTED_PUBLIC_KEY.pem');
const [pdfFile,manifestFile,keyFile]=process.argv.slice(2);const {manifest,signature}=JSON.parse(readFileSync(manifestFile,'utf8'));if(!verifyReport(readFileSync(pdfFile),manifest,signature,readFileSync(keyFile,'utf8'))){console.error('Invalid report or signature');process.exit(1);}console.log('PDF hash and signature verified against supplied trusted key.');
