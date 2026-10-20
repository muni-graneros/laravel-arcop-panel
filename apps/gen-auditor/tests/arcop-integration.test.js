import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {once} from 'node:events';import {createService} from '../../../packages/arcop-open/src/service.js';
const T='11111111-1111-4111-8111-111111111111';
test('independent ARCOP: generic OIDC subject, RLS, idempotency, separation and execution receipt',async()=>{
 const db=new PGlite();await db.exec(await readFile(new URL('../../../packages/arcop-open/sql/schema.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO arcop.tenants VALUES('${T}','Test tenant');INSERT INTO arcop.members VALUES('${T}','external|receiver','receiver',true),('${T}','external|resolver','resolver',true),('${T}','external|reader','auditor',true);SET ROLE arcop_api;`);
 const client={query:(...args)=>db.query(...args),release(){}},pool={connect:async()=>client};
 const server=createService({pool,verifyToken:async token=>({sub:'external|'+token,aal:'aal2'}),config:{piiKey:'ab'.repeat(32),hmacKey:'cd'.repeat(32),requireMfa:true,embedOrigins:['https://host.example.org'],policyReviewed:true,approvedProfiles:['test-reviewed']}}).listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port,key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const call=(path,{actor='receiver',method='GET',body}={})=>fetch(base+'/v1'+path,{method,headers:{Authorization:'Bearer '+actor,'X-Tenant-ID':T,'Idempotency-Key':key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 try{
  const body={product:'Test product',identity:'12345678-9',description:'A sufficiently long request description.',right_type:'access',legal_profile:'test-reviewed'};
  const response=await call('/requests',{method:'POST',body});assert.equal(response.status,200);const created=await response.json();
  const replay=await(await call('/requests',{method:'POST',body})).json();assert.equal(replay.id,created.id);assert.equal(replay.replayed,true);
  assert.equal((await call('/requests',{method:'POST',body:{...body,description:'Different description should fail idempotency.'}})).status,409);
  const list=await(await call('/requests')).text();assert(!list.includes(body.identity));assert(!list.includes('ciphertext'));
  const evidence_sha256='f'.repeat(64),url='/requests/'+created.id+'/transitions';
  assert.equal((await call(url,{method:'POST',body:{action:'verify_identity',evidence_sha256}})).status,200);
  assert.equal((await call(url,{method:'POST',body:{action:'approve',evidence_sha256,legal_basis:'Reviewed legal basis',reason:'Reviewed decision reason'}})).status,409);
  assert.equal((await call(url,{actor:'resolver',method:'POST',body:{action:'approve',evidence_sha256,legal_basis:'Reviewed legal basis',reason:'Reviewed decision reason'}})).status,200);
  assert.equal((await call(url,{actor:'resolver',method:'POST',body:{action:'complete',evidence_sha256}})).status,409);
  assert.equal((await call(url,{actor:'resolver',method:'POST',body:{action:'complete',evidence_sha256,receipt_ref:'host-receipt-123'}})).status,200);
  const log=await(await call('/requests/'+created.id+'/events')).json();assert.equal(log.integrity,true);assert.equal(log.items.length,4);
  assert.equal((await call('/requests',{actor:'reader',method:'POST',body})).status,403);
  await assert.rejects(db.exec("UPDATE arcop.events SET action='tamper'"));
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
