import test from 'node:test';import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const sql = name => readFile(new URL(`../sql/${name}`, import.meta.url), 'utf8');
const h = s => createHash('sha256').update(s).digest('hex');
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

async function boot(){
  const db = new PGlite();
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await db.exec(await sql('001_gen_auditor.sql'));
  await db.exec(await sql('002_runtime_role.sql'));
  await db.exec(await sql('004_assets_remediation.sql'));
  await db.exec(await sql('006b_bridge_gen_auditor_side.sql'));
  await db.exec(`INSERT INTO auth.users VALUES('${U1}');
    INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant Uno'),('${T2}','Tenant Dos');
    INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true);
    INSERT INTO gen_auditor.tenant_members VALUES('${T2}','${U1}','privacy',true);
    INSERT INTO integration.trusted_signers(name,public_key,fingerprint) VALUES('arcop-prod',decode('00','hex'),'abcdef0123456789');`);
  await db.exec(`SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
  return db;
}

const event = (seq,over={}) => ({
  v:1, entity_type:'request', entity_id:REQ, tenant_id:T1, seq,
  actor:'receiver-1', action:over.action||'request.received', at:'2026-10-16T12:00:00.000000Z',
  metadata:{_hash:h(`evt-${seq}`),product:'Municipal',right_type:'access',status:over.status||'identity_pending',due_at:null,...over.metadata},
});

const apply = (db,payload,verified=true) =>
  db.query('SELECT integration.apply_arcop_event($1,$2,$3,$4) AS status',
    ['arcop-prod', JSON.stringify(payload), verified, 'arcop-key-2026']);

test('el receptor aplica un evento y proyecta el estado de ARCOP',async()=>{
  const db = await boot();try{
    assert.equal((await apply(db,event(1))).rows[0].status,'applied');
    const p=(await db.query('SELECT * FROM integration.arcop_request_projections WHERE source_request_id=$1',[REQ])).rows[0];
    assert.equal(p.status,'identity_pending');
    assert.equal(p.product,'Municipal');
    assert.equal(p.last_seq,1);
    assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,true);
    const acts=(await db.query("SELECT action FROM gen_auditor.audit_logs WHERE action='arcop.projection_applied'")).rows;
    assert.equal(acts.length,1);
  }finally{await db.close();}
});

test('el mismo evento dos veces no duplica la proyección',async()=>{
  const db = await boot();try{
    assert.equal((await apply(db,event(1))).rows[0].status,'applied');
    assert.equal((await apply(db,event(1))).rows[0].status,'duplicate');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.arcop_request_projections')).rows[0].n,1);
  }finally{await db.close();}
});

test('un evento antiguo (seq menor) se rechaza como replay',async()=>{
  const db = await boot();try{
    await apply(db,event(5));
    // Payload distinto con secuencia menor → anti-replay por cursor.
    assert.equal((await apply(db,event(3))).rows[0].status,'replayed');
    // Reenviar el MISMO evento → dedup por hash. Distinto motivo, misma protección.
    assert.equal((await apply(db,event(5))).rows[0].status,'duplicate');
    // Y otro payload con secuencia igual también es replay, no una segunda aplicación.
    assert.equal((await apply(db,{...event(5),metadata:{...event(5).metadata,_hash:h('otro')}})).rows[0].status,'replayed');
    const receipt=(await db.query("SELECT outcome FROM integration.webhook_receipts WHERE event_hash=$1",[h('evt-3')])).rows[0];
    assert.equal(receipt.outcome,'replayed');
    // Un solo registro por evento: el duplicado no crea una segunda fila.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.webhook_receipts WHERE event_hash=$1',[h('evt-5')])).rows[0].n,1);
  }finally{await db.close();}
});

test('sin firma verificada no se escribe nada',async()=>{
  const db = await boot();try{
    assert.equal((await apply(db,event(1),false)).rows[0].status,'invalid_signature');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.arcop_request_projections')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.webhook_receipts')).rows[0].n,0);
  }finally{await db.close();}
});

test('un emisor revocado no puede escribir aunque la firma sea válida',async()=>{
  const db = await boot();try{
    await db.query(`UPDATE integration.trusted_signers SET revoked_at=now() WHERE name='arcop-prod'`);
    assert.equal((await apply(db,event(1))).rows[0].status,'invalid_signature');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.arcop_request_projections')).rows[0].n,0);
  }finally{await db.close();}
});

test('un tenant desconocido se pone en cuarentena, no se crea',async()=>{
  const db = await boot();try{
    const bogus = event(1); bogus.tenant_id = '99999999-9999-4999-8999-999999999999';
    assert.equal((await apply(db,bogus)).rows[0].status,'quarantined');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.arcop_request_projections')).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM integration.webhook_receipts WHERE outcome='stale_tenant'")).rows[0].n,1);
  }finally{await db.close();}
});

test('un payload incompleto no revienta la función ni se pierde en silencio',async()=>{
  const db = await boot();try{
    assert.equal((await apply(db,{v:1,entity_type:'request'})).rows[0].status,'malformed');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM integration.webhook_receipts WHERE outcome='malformed'")).rows[0].n,1);
    // Tipo de entidad desconocido: se registra, no se descarta.
    const other = event(1); other.entity_type='inventado';
    assert.equal((await apply(db,other)).rows[0].status,'unknown_type');
  }finally{await db.close();}
});

test('los consentimientos proyectan estado y evidencia de captura',async()=>{
  const db = await boot();try{
    const ev = {v:1,entity_type:'consent',entity_id:CON,tenant_id:T1,seq:1,actor:'host',action:'consent.granted',
      at:'2026-10-16T12:00:00.000000Z',
      metadata:{_hash:h('consent-1'),product:'Municipal',purpose:'Comunicaciones',legal_version:'2026.1',
        legal_sha256:h('texto'),granted_at:'2026-10-16T12:00:00Z',capture_method:'host_asserted',
        evidence_strength:'asserted_by_host'}};
    assert.equal((await apply(db,ev)).rows[0].status,'applied');
    const p=(await db.query('SELECT * FROM integration.consent_projections WHERE source_consent_id=$1',[CON])).rows[0];
    assert.equal(p.state,'active');
    assert.equal(p.capture_method,'host_asserted');
    assert.equal(p.legal_sha256,h('texto'));

    // El retiro es un evento posterior, no una reescritura del grant.
    const ev2 = {...ev,seq:2,action:'consent.withdrawn',metadata:{...ev.metadata,_hash:h('consent-2')}};
    assert.equal((await apply(db,ev2)).rows[0].status,'applied');
    assert.equal((await db.query('SELECT state FROM integration.consent_projections WHERE source_consent_id=$1',[CON])).rows[0].state,'withdrawn');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.consent_projections')).rows[0].n,1);
  }finally{await db.close();}
});

test('cada tenant sólo ve sus propias proyecciones y la correlación es privada',async()=>{
  const db = new PGlite();try{
    await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    await db.exec(await sql('001_gen_auditor.sql'));
    await db.exec(await sql('002_runtime_role.sql'));
    await db.exec(await sql('004_assets_remediation.sql'));
    await db.exec(await sql('006b_bridge_gen_auditor_side.sql'));
    await db.exec(`INSERT INTO auth.users VALUES('${U1}');
      INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant Uno'),('${T2}','Tenant Dos');
      INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true),('${T2}','${U1}','owner',true);`);
    await db.exec(`SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
    await apply(db,event(1));
    // Cambio de contexto al segundo tenant.
    await db.exec(`SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T2}',false)`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM integration.arcop_request_projections')).rows[0].n,0);
    // La correlación de sujeto es inalcanzable para el rol de API: no tiene
    // USAGE sobre el esquema, así que ni siquiera puede listar la tabla.
    await db.exec(`SET ROLE gen_auditor_api; SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
    await assert.rejects(db.query('SELECT count(*) FROM integration.subject_correlation'),/permission denied for schema integration/);
    await assert.rejects(db.query('SELECT count(*) FROM integration.webhook_receipts'),/permission denied for schema integration/);
  }finally{await db.close();}
});