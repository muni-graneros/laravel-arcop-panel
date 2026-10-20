import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';import { PGlite } from '@electric-sql/pglite';
const T1='11111111-1111-4111-8111-111111111111',T2='22222222-2222-4222-8222-222222222222',U1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',U2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('PostgreSQL schema: RLS, FK isolation, immutable events and tamper detection',async()=>{
 const db=new PGlite();try{
 await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
 await db.exec(await readFile(new URL('../sql/001_gen_auditor.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../sql/002_runtime_role.sql',import.meta.url),'utf8'));
 await db.exec(`INSERT INTO auth.users VALUES('${U1}'),('${U2}');INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant A'),('${T2}','Tenant B');INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true),('${T2}','${U2}','owner',true);`);
 await db.exec(`SET ROLE gen_auditor_api; SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false);`);
 const [{id:client}]=(await db.query(`INSERT INTO gen_auditor.clients(tenant_id,name) VALUES('${T1}','Client A') RETURNING id`)).rows;
 await assert.rejects(db.query(`INSERT INTO gen_auditor.clients(tenant_id,name) VALUES('${T2}','Cross tenant')`));
 await assert.rejects(db.query(`INSERT INTO gen_auditor.domains(tenant_id,client_id,hostname) VALUES('${T2}','${client}','example.org')`));
 await db.query("SELECT gen_auditor.append_audit('client.created',$1,'{}')",[client]);await db.query("SELECT gen_auditor.append_audit('access.read',NULL,'{}')");
 assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,true);
 await db.exec("SET TIME ZONE 'America/Santiago'");assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,true);
 await assert.rejects(db.exec("UPDATE gen_auditor.audit_logs SET action='tampered'"));await assert.rejects(db.exec('TRUNCATE gen_auditor.audit_logs'));
 await db.exec(`SELECT set_config('app.actor_id','${U2}',false),set_config('app.tenant_id','${T2}',false)`);
 assert.equal((await db.query('SELECT * FROM gen_auditor.clients')).rows.length,0);assert.equal((await db.query('SELECT * FROM gen_auditor.audit_logs')).rows.length,0);
 await db.exec(`RESET ROLE; ALTER TABLE gen_auditor.audit_logs DISABLE TRIGGER immutable_row; UPDATE gen_auditor.audit_logs SET action='tampered' WHERE tenant_id='${T1}' AND seq=1; ALTER TABLE gen_auditor.audit_logs ENABLE TRIGGER immutable_row; SET ROLE gen_auditor_api; SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
 assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,false);
 }finally{await db.close();}
});
