import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function normalizeDomain(value) {
  const name = domainToASCII(value.trim().toLowerCase().replace(/\.$/,''));
  if (!name || name.length>253 || isIP(name) || !name.includes('.') || /[:/@?#\\\s]/.test(name)
      || !name.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))
      || /\.(localhost|local|internal|test|invalid|example|onion)$/.test(name)) throw new Error('invalid_domain');
  return name;
}
export function isPublicIP(value) {
  try { const ip=ipaddr.process(value); return ip.range()==='unicast'; } catch {return false;}
}
export function dueAt(severity, detectedAt=new Date()) {
  const hours={critical:48,high:168,medium:360,low:720,info:null}[severity];
  if (hours===undefined) throw new Error('invalid_severity');
  return hours===null ? null : new Date(new Date(detectedAt).getTime()+hours*3600000).toISOString();
}

// Huella estable de un hallazgo. Deliberadamente EXCLUYE severidad y scan_id:
// la severidad se recalcula y el escaneo cambia en cada corrida. Con esta
// definición, un re-escaneo actualiza el hallazgo existente en lugar de crear
// uno nuevo que nadie va a cerrar.
export function fingerprint(assetId, ruleKey, location='') {
  if(!assetId) throw new Error('asset_required');
  if(typeof ruleKey!=='string'||ruleKey.length<2) throw new Error('rule_key_required');
  return sha256(`${assetId}|${ruleKey}|${location}`);
}

// Regla clave canónica de una observación de cabeceras, derivable del título.
export const ruleKeyFor = title => String(title).toLowerCase()
  .replace(/\s+no observad[ao]s?$/,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

// La criticidad del activo NUNCA aligera la severidad: sólo la puede subir.
export function effectiveSeverity(severity, criticality) {
  if(severity==='critical') return 'critical';
  if(criticality==='critical'&&['medium','low','info'].includes(severity)) return 'high';
  if(criticality==='high'&&severity==='info') return 'low';
  return severity;
}

// Qué puede hacer una acción siguiente según el estado actual del hallazgo.
export const NEXT_ACTIONS = {
  open:['start','accept','false_positive'],
  triaged:['start','accept','false_positive'],
  reopened:['start','accept','false_positive'],
  in_progress:['accept','false_positive'],
  awaiting_verification:['verify','reopen'],
  closed:[], accepted:['revoke_acceptance'], false_positive:[]
};
export const canAct = (status,action) => (NEXT_ACTIONS[status]||[]).includes(action);
export function incidentDeadlines(i) {
  if (!i.obligated) return {applicability:'not_obligated',early:null,update:null,action_plan:null,final:null};
  const plus=(date,h)=>date?new Date(new Date(date).getTime()+h*3600000).toISOString():null;
  return {applicability:'review_required',early:plus(i.known_at,3),update:plus(i.known_at,i.oiv&&i.essential_affected?24:72),
    action_plan:i.oiv?plus(i.known_at,168):null,final:plus(i.resolved_at||i.early_sent_at,360)};
}
export function compliance(controls) {
  const applicable=controls.filter(x=>x.status!=='not_applicable');
  return {verified:applicable.filter(x=>x.status==='verified').length,total:applicable.length,
    percent:applicable.length?Math.round(applicable.filter(x=>x.status==='verified').length/applicable.length*100):null};
}
export function subjectRef(tenant,identity,key) {return createHmac('sha256',key).update(tenant+'\0'+identity.trim().toUpperCase()).digest('hex');}
export function encrypt(value,tenant,key) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAAD(Buffer.from(tenant));
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');
}
export function decrypt(value,tenant,key) {
  const [v,iv,tag,data]=value.split('.');if(v!=='v1')throw new Error('unknown_key_version');
  const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(tenant));cipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}
export const remediations = {
  hsts:{title:'HSTS no observado',severity:'medium',recommendation:'Tras validar HTTPS en todos los subdominios afectados, configurar HSTS. No activar preload sin revisar su alcance.',code:'Strict-Transport-Security: max-age=31536000'},
  csp:{title:'Content-Security-Policy no observada',severity:'medium',recommendation:'Inventariar recursos y desplegar una política específica primero en Report-Only. Una cabecera presente no acredita que sea robusta.',code:"Content-Security-Policy-Report-Only: default-src 'self'; object-src 'none'; base-uri 'self'"},
  nosniff:{title:'X-Content-Type-Options no observado',severity:'low',recommendation:'Servir los tipos MIME correctos y añadir nosniff.',code:'X-Content-Type-Options: nosniff'},
  referrer:{title:'Referrer-Policy no observada',severity:'low',recommendation:'Reducir exposición del origen de navegación según la funcionalidad del sitio.',code:'Referrer-Policy: strict-origin-when-cross-origin'},
};
export function evaluateHeaders(headers) {
  const fields={hsts:'strict-transport-security',csp:'content-security-policy',nosniff:'x-content-type-options',referrer:'referrer-policy'};
  const findings=Object.entries(fields).filter(([,header])=>!headers[header]).map(([key])=>remediations[key]);
  return {score:Math.max(0,100-findings.reduce((n,f)=>n+(f.severity==='medium'?20:10),0)),findings,
    limitations:'Índice de higiene de cabeceras, no score integral de vulnerabilidades ni certificación. No se siguen redirecciones.'};
}
