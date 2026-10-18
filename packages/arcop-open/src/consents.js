import {z} from 'zod';import {hash,reference,seal} from './crypto.js';
export const CAPTURE_METHODS=['arcop_capture','host_forwarded','host_asserted','operator_entered'];
// La fuerza de la evidencia es derivada del método de captura: sólo ARCOP midió al titular.
// host_forwarded y host_asserted son afirmaciones del anfitrión; operator_entered no acredita IP del titular.
export const captureStrength=method=>method==='arcop_capture'?'strong':'declared';
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{status});};
const code=z.string().min(2).max(80).regex(/^[a-z0-9_.]+$/);
const grant=z.object({
 definition_code:code,
 subject_identity:z.string().min(3).max(255),
 ip:z.string().min(3).max(64).optional(),
 user_agent:z.string().min(3).max(512).optional(),
 granted_at:z.iso.datetime({offset:true}).optional(),
 capture_method:z.enum(CAPTURE_METHODS),
}).strict();
// El texto legal y su hash nunca viajan en el cuerpo: se toman de consent_texts publicado.
export async function register(db,{tenant},config,input,key){
 const b=grant.parse(input);
 if(b.capture_method==='operator_entered'&&(b.ip||b.user_agent))fail('ip_de_operador_no_es_del_titular');
 if(b.capture_method==='arcop_capture'&&(!b.ip||!b.user_agent))fail('captura_arcop_requiere_ip_y_agente');
 const sref=reference(tenant,b.subject_identity,config.hmacKey);
 const fingerprint=reference(tenant,JSON.stringify({definition_code:b.definition_code,subject_ref:sref,capture_method:b.capture_method,granted_at:b.granted_at??null}),config.hmacKey);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':'+key]);
 const prior=(await db.query('SELECT id,legal_version,legal_sha256,capture_method,evidence_strength,request_fingerprint FROM arcop.consents WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key])).rows;
 if(prior.length){if(prior[0].request_fingerprint!==fingerprint)fail('idempotency_conflict');const {request_fingerprint:_f,...rest}=prior[0];return {...rest,replayed:true};}
 // La identidad, la IP y el user-agent viajan cifrados: la base nunca ve texto claro de PII.
 const {rows}=await db.query('SELECT arcop.register_consent($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::uuid,$9) AS r',[b.definition_code,sref,seal(b.subject_identity,tenant,config.piiKey),b.ip?seal(b.ip,tenant,config.piiKey):null,b.user_agent?seal(b.user_agent,tenant,config.piiKey):null,b.granted_at??null,b.capture_method,key,fingerprint]);
 return rows[0].r;
}
// Retirada o restricción: evento adicional. El grant original queda intacto (append-only).
export async function change(db,id,kind,input){
 if(!['withdrawn','restricted'].includes(kind))fail('invalid_action');
 const b=z.object({scope:z.string().min(2).max(500).optional(),reason:z.string().min(10).max(2000).optional(),evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),host_ref:z.string().min(3).max(255).optional()}).strict().parse(input??{});
 const data={...(b.evidence_sha256?{evidence_sha256:b.evidence_sha256}:{}),...(b.reason?{reason_sha256:hash(b.reason)}:{}),...(b.host_ref?{host_ref_sha256:hash(b.host_ref)}:{})};
 const {rows}=await db.query('SELECT arcop.record_consent_action($1,$2,$3,$4,$5) AS r',[id,kind,b.scope??null,b.reason??null,JSON.stringify(data)]);
 return rows[0].r;
}
// Verificación de integridad: devuelve el eslabón roto, no un sí/no.
export async function chain(db,{tenant},id){
 const consent=(await db.query('SELECT id,subject_ref,legal_version,legal_sha256,legal_text_snapshot,granted_at,capture_method,evidence_strength,registered_by,status FROM arcop.consent_state WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
 if(!consent)fail('not_found',404);
 const integrity=(await db.query('SELECT arcop.verify_evidence_chain($1,$2) AS v',['consent',id])).rows[0].v;
 return {consent,integrity};
}
// Listado sin PII descifrada: sólo metadatos y el sello del texto.
export async function list(db,{tenant},{limit=25,offset=0}={}){
 const l=Math.min(Math.max(Number(limit)||25,1),100),o=Math.max(Number(offset)||0,0);
 const {rows}=await db.query('SELECT c.id,d.code AS definition_code,c.subject_ref,c.legal_version,c.legal_sha256,c.granted_at,c.capture_method,c.evidence_strength,c.registered_by,c.status FROM arcop.consent_state c JOIN arcop.consent_definitions d ON d.id=c.definition_id WHERE c.tenant_id=$1 ORDER BY c.granted_at DESC,c.id DESC LIMIT $2 OFFSET $3',[tenant,l,o]);
 return {items:rows,limit:l,offset:o};
}
// Publicar una versión del texto legal. El hash lo calcula la base sobre los bytes almacenados.
export async function publishText(db,definition,input){
 const b=z.object({version:z.number().int().min(1).max(999),locale:z.string().min(2).max(10).default('es'),body:z.string().min(50).max(20000)}).strict().parse(input);
 const {rows}=await db.query('SELECT arcop.publish_consent_text($1,$2,$3,$4) AS r',[definition,b.version,b.locale,b.body]);
 return rows[0].r;
}
export async function resolveDefinition(db,{tenant},id){
 // {id} admite el id de un consentimiento o el de su definición, para publicar la primera versión.
 const {rows}=await db.query('SELECT d.code FROM arcop.consent_definitions d WHERE d.tenant_id=$1 AND d.id=$2',[tenant,id]);
 if(rows.length)return rows[0].code;
 const c=(await db.query('SELECT d.code FROM arcop.consents c JOIN arcop.consent_definitions d ON d.id=c.definition_id WHERE c.tenant_id=$1 AND c.id=$2',[tenant,id])).rows[0];
 if(!c)fail('not_found',404);
 return c.code;
}