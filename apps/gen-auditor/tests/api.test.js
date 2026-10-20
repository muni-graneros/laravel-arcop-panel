import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {once} from 'node:events';import {PGlite} from '@electric-sql/pglite';import {createApp} from '../server/app.js';
const T='11111111-1111-4111-8111-111111111111',U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',V='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('HTTP API: authentication, role isolation, ciphertext privacy, real writes and separate ARCOP',async()=>{
 const db=new PGlite();await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');await db.exec(await readFile(new URL('../sql/001_gen_auditor.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../sql/002_runtime_role.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO auth.users VALUES('${U}'),('${V}');INSERT INTO gen_auditor.tenants(id,name) VALUES('${T}','Test tenant');INSERT INTO gen_auditor.tenant_members VALUES('${T}','${U}','owner',true),('${T}','${V}','reader',true);SET ROLE gen_auditor_api;`);
 const client={query:(...a)=>db.query(...a),release(){}};const pool={connect:async()=>client};const config={supabaseUrl:'https://example.supabase.co',publishableKey:'public-demo',appOrigin:'https://gen.example.org',requireMfa:true,piiKey:'ab'.repeat(32),subjectKey:'cd'.repeat(32)};
 const server=createApp({pool,config,verifyToken:async token=>{if(!['owner','reader'].includes(token))throw new Error('invalid');return {sub:token==='owner'?U:V,aal:'aal2'};}}).listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const request=(url,{token='owner',tenant=T,body,method='GET'}={})=>fetch(base+'/api/v1'+url,{method,headers:{Authorization:'Bearer '+token,'X-Tenant-ID':tenant,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 try{
 assert.equal((await request('/clients',{token:'invalid'})).status,401);assert.equal((await request('/clients',{tenant:'22222222-2222-4222-8222-222222222222'})).status,403);
 assert.equal((await request('/clients',{token:'reader',method:'POST',body:{name:'Forbidden'}})).status,403);
 const created=await request('/clients',{method:'POST',body:{name:'Real test client',product:'Test'}});assert.equal(created.status,200);const c=await created.json();assert.equal((await (await request('/clients')).json())[0].id,c.id);
 const consent=await request('/consents',{method:'POST',body:{client_id:c.id,identity:'12345678-9',purpose:'A test purpose',legal_version:'v1',legal_text:'A sufficiently long legal text for a unit test.'}});assert.equal(consent.status,200);
 const listed=await (await request('/consents')).text();assert(!listed.includes('12345678-9'));assert(!listed.includes('ciphertext'));
 const dashboard=await (await request('/dashboard')).json();assert.equal(dashboard.integrity,true);assert.equal(dashboard.compliance.percent,null);
 assert.equal((await request('/arco-requests',{method:'POST',body:{}})).status,409);
 assert.equal((await request('/scans',{method:'POST',body:{domain_id:c.id,kind:'active'}})).status,409);
 assert.equal((await request('/reports',{method:'POST',body:{client_id:c.id}})).status,503);
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
