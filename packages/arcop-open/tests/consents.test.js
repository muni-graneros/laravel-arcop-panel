import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
import * as consents from '../src/consents.js';import {hash} from '../src/crypto.js';
const TENANT='11111111-1111-4111-8111-111111111111',DEF='11111111-1111-4111-8111-111111111112',SHA0='0'.repeat(64);
const config={piiKey:'a'.repeat(64),hmacKey:'b'.repeat(64)};
const schema=readFileSync(new URL('../sql/schema.sql',import.meta.url),'utf8'),mig=readFileSync(new URL('../sql/002_consents_evidencia.sql',import.meta.url),'utf8');
const TEXT='Autorizo el tratamiento de mis datos para las finalidades descritas en esta versión publicada del texto, con los límites indicados.';
const key=(n=1)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const GRANT={definition_code:'marketing_email',subject_identity:'titular@ejemplo.cl',ip:'203.0.113.7',user_agent:'Mozilla/5.0',capture_method:'arcop_capture'};
async function fresh(){
 const pg=new PGlite();await pg.exec(schema);await pg.exec(mig);
 const db={query:(sql,params)=>pg.query(sql,params)};
 await pg.exec(`INSERT INTO arcop.tenants(id,name) VALUES('${TENANT}','acme');INSERT INTO arcop.members(tenant_id,subject,role) VALUES('${TENANT}','admin','admin'),('${TENANT}','auditor','auditor'),('${TENANT}','reclutador','receiver');INSERT INTO arcop.consent_definitions(id,tenant_id,code,purpose) VALUES('${DEF}','${TENANT}','marketing_email','Comercialización');`);
 const as=sub=>pg.query("SELECT set_config('app.actor_id',$1,false),set_config('app.tenant_id',$2,false)",[sub,TENANT]);
 await as('admin');
 return {...db,pg,as,grant:(over={},k=1)=>consents.register(db,{tenant:TENANT},config,{...GRANT,...over},key(k)),publish:()=>consents.publishText(db,'marketing_email',{version:1,locale:'es',body:TEXT})};
}
test('el hash se sella desde el texto publicado, nunca desde el enviado por el cliente',async()=>{
 const db=await fresh();
 // Sin versión publicada no hay registro: un texto enviado por el cliente no habilita el consentimiento.
 await assert.rejects(db.grant(),/legal_text_not_published/);
 const published=await db.publish();
 assert.equal(published.legal_sha256,hash(TEXT));
 const r=await db.grant();
 assert.equal(r.legal_sha256,hash(TEXT));assert.equal(r.legal_version,1);
 const row=(await db.query('SELECT legal_sha256,legal_text_snapshot FROM arcop.consents WHERE id=$1',[r.id])).rows[0];
 assert.equal(row.legal_sha256,hash(TEXT));assert.equal(row.legal_text_snapshot,TEXT);
 // El texto publicado y su sello son inmutables: nadie reescribe lo que se juró.
 await assert.rejects(db.query('UPDATE arcop.consent_texts SET legal_sha256=$1 WHERE id=$2',[hash('texto manipulado'),published.id]),/texto_publicado_inmutable/);
 await assert.rejects(db.query('UPDATE arcop.consent_texts SET body=$1 WHERE id=$2',['otro texto',published.id]),/texto_publicado_inmutable/);
 // Publicar una versión nueva retira la anterior; el consentimiento conserva el texto con el que se|Giố.
 const v2=await consents.publishText(db,'marketing_email',{version:2,locale:'es',body:TEXT+' Versión 2.'});
 assert.equal(v2.legal_sha256,hash(TEXT+' Versión 2.'));
 assert.equal((await db.query('SELECT status FROM arcop.consent_texts WHERE id=$1',[published.id])).rows[0].status,'retired');
 assert.equal((await db.query('SELECT legal_sha256 FROM arcop.consents WHERE id=$1',[r.id])).rows[0].legal_sha256,hash(TEXT));
 await db.pg.close();
});
test('retirar no reescribe el grant: el registro original sigue intacto',async()=>{
 const db=await fresh();await db.publish();
 await db.grant();
 const before=(await db.query('SELECT * FROM arcop.consents')).rows[0];
 const out=await consents.change(db,before.id,'withdrawn',{reason:'El titular lo solicitó por correo',evidence_sha256:'c'.repeat(64)});
 assert.equal(out.status,'withdrawn');
 assert.deepEqual((await db.query('SELECT * FROM arcop.consents WHERE id=$1',[before.id])).rows[0],before);
 assert.equal((await db.query('SELECT status FROM arcop.consent_state WHERE id=$1',[before.id])).rows[0].status,'withdrawn');
 assert.equal((await db.query('SELECT count(*)::int n FROM arcop.consent_actions')).rows[0].n,1);
 // La retirada es un evento: no se vuelve a retirar ni a reescribir el grant.
 await assert.rejects(consents.change(db,before.id,'withdrawn',{reason:'Segunda petición del titular'}),/consent_withdrawn/);
 await db.pg.close();
});
test('la cadena verifica OK y localiza el truncamiento de cola',async()=>{
 const db=await fresh();await db.publish();
 const id=(await db.grant()).id;
 await consents.change(db,id,'restricted',{reason:'Restricción solicitada por el titular'});
 const ok=(await consents.chain(db,{tenant:TENANT},id)).integrity;
 assert.equal(ok.ok,true);assert.equal(ok.broken_at,null);assert.equal(ok.reason,null);
 assert.deepEqual(ok.entries.map(e=>e.action),['consent_granted','restricted']);
 // Truncamiento de cola: el atacante borra el último eslabón desde el almacenamiento.
 await db.pg.exec('ALTER TABLE arcop.evidence_events DISABLE TRIGGER evidence_immutable');
 await db.query('DELETE FROM arcop.evidence_events WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 AND seq=2',[TENANT,'consent',id]);
 const truncada=(await consents.chain(db,{tenant:TENANT},id)).integrity;
 assert.equal(truncada.ok,false);assert.equal(truncada.reason,'cadena_incompleta');assert.equal(truncada.broken_at,2);
 await db.pg.close();
});
test('la cadena detecta la sustitución de un eslabón intermedio',async()=>{
 const db=await fresh();await db.publish();
 const id=(await db.grant()).id;
 await consents.change(db,id,'restricted',{reason:'Restricción solicitada por el titular'});
 await db.query('SELECT arcop.append_evidence($1,$2,$3,$4)',['consent',id,'note_appended',JSON.stringify({nota:'sello posterior'})]);
 assert.equal((await consents.chain(db,{tenant:TENANT},id)).integrity.ok,true);
 await db.pg.exec('ALTER TABLE arcop.evidence_events DISABLE TRIGGER evidence_immutable');
 await db.query("UPDATE arcop.evidence_events SET metadata=jsonb_build_object('capture_method','operator_entered') WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 AND seq=1",[TENANT,'consent',id]);
 const rota=(await consents.chain(db,{tenant:TENANT},id)).integrity;
 assert.equal(rota.ok,false);assert.equal(rota.reason,'metadatos_alterados');assert.equal(rota.broken_at,1);
 await db.pg.close();
});
test('la bitácora es de solo anexado: UPDATE, DELETE y TRUNCATE fallan',async()=>{
 const db=await fresh();await db.publish();
 const id=(await db.grant()).id;
 await consents.change(db,id,'restricted',{reason:'Restricción solicitada por el titular'});
 await assert.rejects(db.query('UPDATE arcop.evidence_events SET action=$1',['manipulado']),/append_only/);
 await assert.rejects(db.query('DELETE FROM arcop.evidence_events'),/append_only/);
 await assert.rejects(db.pg.exec('TRUNCATE arcop.evidence_events'),/append_only/);
 await assert.rejects(db.query('UPDATE arcop.consents SET capture_method=$1',['host_asserted']),/append_only/);
 await assert.rejects(db.query('UPDATE arcop.consent_actions SET action=$1',['withdrawn']),/append_only/);
 await assert.rejects(db.query('DELETE FROM arcop.consent_actions'),/append_only/);
 assert.equal((await consents.chain(db,{tenant:TENANT},id)).integrity.ok,true);
 await db.pg.close();
});
test('capture_method se conserva y separa la evidencia medida de la declarada',async()=>{
 const db=await fresh();await db.publish();
 const medida=await db.grant();
 assert.equal(medida.capture_method,'arcop_capture');assert.equal(medida.evidence_strength,'strong');
 for(const [n,method] of ['host_forwarded','host_asserted','operator_entered'].entries()){
  const declarada=await db.grant({subject_identity:`titular${n}@ejemplo.cl`,ip:n===2?undefined:'198.51.100.9',user_agent:n===2?undefined:'Mozilla/5.0',capture_method:method},10+n);
  assert.equal(declarada.capture_method,method);assert.equal(declarada.evidence_strength,'declared');
  const row=(await db.query('SELECT capture_method,evidence_strength FROM arcop.consent_state WHERE id=$1',[declarada.id])).rows[0];
  assert.deepEqual([row.capture_method,row.evidence_strength],[method,'declared']);
 }
 // La IP de un operador no es la del titular: no se admite.
 await assert.rejects(db.grant({subject_identity:'otro@ejemplo.cl',ip:'198.51.100.9',capture_method:'operator_entered'},20),/ip_de_operador_no_es_del_titular/);
 // capture_method es obligatorio y la fuerza de la evidencia es derivada, no declarable.
 await assert.rejects(consents.register(db,{tenant:TENANT},config,{definition_code:'marketing_email',subject_identity:'otro@ejemplo.cl'},key(21)),/capture_method/);
 await assert.rejects(consents.register(db,{tenant:TENANT},config,{...GRANT,subject_identity:'otro@ejemplo.cl',evidence_strength:'strong'},key(22)),/[Uu]nrecognized/);
 await db.pg.close();
});
test('una acción de bloqueo no queda completed sin comprobante del anfitrión',async()=>{
 const db=await fresh();
 await db.query("INSERT INTO arcop.host_adapters(id,tenant_id,code,kind,endpoint_url,auth_ref) VALUES(gen_random_uuid(),$1,'crm_block','block','https://crm.ejemplo.cl/api','vault://crm/token')",[TENANT]);
 await db.query("INSERT INTO arcop.subject_systems(id,tenant_id,code,adapter_id,system_type) SELECT gen_random_uuid(),$1,'crm',id,'crm' FROM arcop.host_adapters WHERE code='crm_block'",[TENANT]);
 const action=(cols,values,params=[])=>db.query(`INSERT INTO arcop.subject_actions(tenant_id,adapter_id,subject_system_id,entity_type,entity_id,operation,legal_profile,status,ordered_by,completed_by${cols}) SELECT $1,a.id,s.id,'consent',gen_random_uuid(),'block','perfil.review','completed','admin','admin'${values} FROM arcop.host_adapters a JOIN arcop.subject_systems s ON s.adapter_id=a.id WHERE a.code='crm_block'`,[TENANT,...params]);
 await assert.rejects(action('',''),/violates check constraint/);
 await action(',receipt_sha256,receipt_ref',',$2,$3',[SHA0,'crm-9911']);
 const row=(await db.query('SELECT status,receipt_sha256,receipt_ref FROM arcop.subject_actions')).rows[0];
 assert.equal(row.status,'completed');assert.equal(row.receipt_sha256,SHA0);assert.equal(row.receipt_ref,'crm-9911');
 await db.pg.close();
});
test('ordenar una acción exige perfil legal aprobado y vigente',async()=>{
 const db=await fresh();
 await db.query("INSERT INTO arcop.host_adapters(id,tenant_id,code,kind,endpoint_url,auth_ref) VALUES(gen_random_uuid(),$1,'crm_block','block','https://crm.ejemplo.cl/api','vault://crm/token')",[TENANT]);
 await db.query("INSERT INTO arcop.subject_systems(id,tenant_id,code,adapter_id,system_type) SELECT gen_random_uuid(),$1,'crm',id,'crm' FROM arcop.host_adapters WHERE code='crm_block'",[TENANT]);
 const sys=(await db.query('SELECT id,adapter_id FROM arcop.subject_systems')).rows[0];
 const order=()=>db.query('SELECT arcop.order_subject_action($1,$2,$3,$4,$5,$6,$7,gen_random_uuid(),$8,$9) AS r',['perfil.review',sys.id,sys.adapter_id,'block',null,null,'consent',SHA0,JSON.stringify({motivo:'Solicitud del titular'})]);
 await assert.rejects(order(),/legal_profile_not_reviewed/);
 await db.query("INSERT INTO arcop.legal_profiles(id,tenant_id,code,version,jurisdiction,summary,status,approved_by,approved_at) VALUES(gen_random_uuid(),$1,'perfil.review',1,'CL','Perfil de revisión inicial aprobado por el área legal.','active','legal',now())",[TENANT]);
 await assert.rejects(order(),/legal_profile_without_rules/);
 await db.query("INSERT INTO arcop.legal_profile_rules(profile_id,rule_key,rule_value) SELECT id,'plazo_respuesta','{\"dias\":30}'::jsonb FROM arcop.legal_profiles WHERE code='perfil.review'");
 const r=(await order()).rows[0].r;
 assert.equal(r.status,'ordered');
 // La acción ordenada abre su propia cadena de evidencia, de tipo execution.
 assert.equal((await db.query("SELECT arcop.verify_evidence_chain('execution',$1) AS v",[r.id])).rows[0].v.ok,true);
 // Al retirar la aprobación vigente, la ejecución se vuelve a bloquear.
 await db.query("UPDATE arcop.legal_profiles SET status='draft',approved_by=NULL WHERE code='perfil.review'");
 await assert.rejects(order(),/legal_profile_not_reviewed/);
 await db.pg.close();
});
test('la anonimización no puede quedar accepted sin informe de reidentificación y revisor',async()=>{
 const db=await fresh();
 await assert.rejects(db.query("INSERT INTO arcop.anonymization_jobs(tenant_id,subject_ref,strategy,systems,created_by,status) VALUES($1,$2,'pseudonymize','crm','admin','accepted')",[TENANT,'e'.repeat(64)]),/violates check constraint/);
 await assert.rejects(db.query("INSERT INTO arcop.anonymization_jobs(tenant_id,subject_ref,strategy,systems,created_by,status,reident_report_sha256) VALUES($1,$2,'pseudonymize','crm','admin','accepted',$3)",[TENANT,'e'.repeat(64),'a'.repeat(64)]),/violates check constraint/);
 await db.query("INSERT INTO arcop.anonymization_jobs(tenant_id,subject_ref,strategy,systems,created_by,status,reident_report_sha256,reviewed_by,reviewed_at) VALUES($1,$2,'pseudonymize','crm','admin','accepted',$3,'legal',now())",[TENANT,'e'.repeat(64),'a'.repeat(64)]);
 assert.equal((await db.query('SELECT status FROM arcop.anonymization_jobs')).rows[0].status,'accepted');
 // La misma regla aplica a la acción de anonimización que ejecuta el sistema anfitrión.
 await db.query("INSERT INTO arcop.host_adapters(id,tenant_id,code,kind,endpoint_url,auth_ref) VALUES(gen_random_uuid(),$1,'crm_anon','anonymize','https://crm.ejemplo.cl/api','vault://crm/token')",[TENANT]);
 await db.query("INSERT INTO arcop.subject_systems(id,tenant_id,code,adapter_id,system_type) SELECT gen_random_uuid(),$1,'crm',id,'crm' FROM arcop.host_adapters WHERE code='crm_anon'",[TENANT]);
 await assert.rejects(db.query("INSERT INTO arcop.subject_actions(tenant_id,adapter_id,subject_system_id,entity_type,entity_id,operation,legal_profile,status,ordered_by) SELECT $1,a.id,s.id,'consent',gen_random_uuid(),'anonymize','perfil.review','accepted','admin' FROM arcop.host_adapters a JOIN arcop.subject_systems s ON s.adapter_id=a.id WHERE a.code='crm_anon'",[TENANT]),/violates check constraint/);
 await db.pg.close();
});
test('el listado no expone PII, la idempotencia es estable y el auditor sólo verifica',async()=>{
 const db=await fresh();await db.publish();
 const r=await db.grant();
 const replay=await db.grant();
 assert.equal(replay.replayed,true);assert.equal(replay.id,r.id);
 await assert.rejects(db.grant({subject_identity:'otro@ejemplo.cl'},1),/idempotency_conflict/);
 const {items}=await consents.list(db,{tenant:TENANT},{});
 assert.equal(items.length,1);
 const serialized=JSON.stringify(items[0]);
 assert.ok(!serialized.includes('203.0.113.7')&&!serialized.includes('titular@ejemplo.cl')&&!serialized.includes('v1.'));
 assert.match(items[0].subject_ref,/^[a-f0-9]{64}$/);
 await db.as('auditor');
 assert.equal((await consents.chain(db,{tenant:TENANT},r.id)).integrity.ok,true);
 await assert.rejects(db.grant({subject_identity:'intento@ejemplo.cl'},2),/forbidden/);
 await db.pg.close();
});