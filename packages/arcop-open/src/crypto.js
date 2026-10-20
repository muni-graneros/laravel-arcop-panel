import {createCipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const reference=(tenant,subject,key)=>createHmac('sha256',key).update(tenant+'\0'+subject).digest('hex');
export function seal(text,tenant,key){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAAD(Buffer.from(tenant));const bytes=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),bytes.toString('base64')].join('.');}
