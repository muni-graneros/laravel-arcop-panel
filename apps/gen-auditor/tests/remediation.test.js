import test from 'node:test';import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const sql = name => readFile(new URL(`../sql/${name}`, import.meta.url), 'utf8');
const h = s => createHash('sha256').update(s).digest('hex');
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Base con 001+002+004 y fixtures mínimos: un tenant, un cliente y contexto RLS.
async function boot({members=true}={}){
  const db = new PGlite();
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await db.exec(await sql('001_gen_auditor.sql'));
  await db.exec(await sql('002_runtime_role.sql'));
  await db.exec(await sql('004_assets_remediation.sql'));
  await db.exec(`INSERT INTO auth.users VALUES('${U1}'),('${U2}');
    INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant Uno');
    INSERT INTO gen_auditor.clients(tenant_id,name) VALUES('${T1}','Cliente Uno');`);
  if(members) await db.exec(`INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true),('${T1}','${U2}','security',true);`);
  await actor(db,U1,T1);
  return db;
}
const actor = (db,uid,tid) => db.exec(`SELECT set_config('app.actor_id','${uid}',false),set_config('app.tenant_id','${tid}',false)`);

async function seedFinding(db,{severity='high',fingerprint='fp-1',hostname='a.example.com'}={}){
  const [client] = (await db.query(`SELECT id FROM gen_auditor.clients WHERE tenant_id='${T1}'`)).rows;
  const [asset] = (await db.query(
    `INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,created_by)
     VALUES('${T1}','${client.id}','Portal Web','web_app','high',2,2,2,'${U1}') RETURNING id`)).rows;
  const [domain] = (await db.query(
    `INSERT INTO gen_auditor.domains(tenant_id,client_id,hostname) VALUES('${T1}','${client.id}','${hostname}') RETURNING id`)).rows;
  const [scan] = (await db.query(
    `INSERT INTO gen_auditor.scans(tenant_id,domain_id,kind,status) VALUES('${T1}','${domain.id}','passive','completed') RETURNING id`)).rows;
  const [finding] = (await db.query(
    `INSERT INTO gen_auditor.vulnerabilities(tenant_id,scan_id,asset_id,title,severity,recommendation,fingerprint,due_at)
     VALUES('${T1}','${scan.id}','${asset.id}','Cabecera de seguridad ausente',$1,'corregir',$2,now()+interval '7 days') RETURNING id`,
    [severity,fingerprint])).rows;
  return {client,asset,domain,scan,finding};
}

test('004 se aplica sobre 001+002 y expone el esquema de remediación',async()=>{
  const db = await boot();try{
    assert.equal((await db.query("SELECT gen_auditor.sla_due_at('critical','2026-10-16T12:00:00Z'::timestamptz) AS d")).rows[0].d.toISOString(),'2026-10-18T12:00:00.000Z');
    assert.equal((await db.query("SELECT gen_auditor.sla_due_at('low','2026-10-01T00:00:00Z'::timestamptz) AS d")).rows[0].d.toISOString(),'2026-10-31T00:00:00.000Z');
    assert.equal((await db.query("SELECT gen_auditor.sla_hours('info') AS x")).rows[0].x,null);
    // La criticidad del activo nunca aligera la severidad.
    assert.equal((await db.query("SELECT gen_auditor.effective_severity('medium','critical') AS s")).rows[0].s,'high');
    assert.equal((await db.query("SELECT gen_auditor.effective_severity('high','low') AS s")).rows[0].s,'high');
    assert.equal((await db.query("SELECT gen_auditor.effective_severity('info','critical') AS s")).rows[0].s,'high');
    const tables=(await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='gen_auditor'")).rows[0].n;
    assert.ok(tables>=32,`esperaba >=32 tablas, obtuve ${tables}`);
  }finally{await db.close();}
});

test('inventario: criticidad crítica descubierta exige justificación y no habilita escaneo',async()=>{
  const db = await boot();try{
    const [client]=(await db.query(`SELECT id FROM gen_auditor.clients WHERE tenant_id='${T1}'`)).rows;
    // Descubierto + crítico sin justificación → rechazado por CHECK
    await assert.rejects(db.query(
      `INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,inventory_source,created_by)
       VALUES('${T1}','${client.id}','Descubierto','web_app','critical',3,3,3,'discovered','${U1}')`));
    const [asset]=(await db.query(
      `INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,created_by,criticality_justification)
       VALUES('${T1}','${client.id}','Gateway','web_app','critical',3,3,3,'${U1}','puerta de entrada') RETURNING id`)).rows;
    // Sin dominio verificado + autorización, el activo NO es escaneable.
    assert.equal((await db.query('SELECT gen_auditor.asset_is_scannable($1) AS ok',[asset.id])).rows[0].ok,false);
    assert.equal((await db.query("SELECT gen_auditor.suggested_criticality(3::smallint,3::smallint,1::smallint) AS s")).rows[0].s,'critical');
    assert.equal((await db.query("SELECT gen_auditor.suggested_criticality(1::smallint,1::smallint,1::smallint) AS s")).rows[0].s,'low');
    // Verificar el dominio sin autorización sigue sin habilitar el escaneo.
    const [domain]=(await db.query(`INSERT INTO gen_auditor.domains(tenant_id,client_id,hostname) VALUES('${T1}','${client.id}','g.example.com') RETURNING id`)).rows;
    await db.query(`INSERT INTO gen_auditor.asset_endpoints(tenant_id,asset_id,domain_id) VALUES('${T1}','${asset.id}','${domain.id}')`);
    await db.query(`UPDATE gen_auditor.domains SET verified_at=now() WHERE id='${domain.id}'`);
    assert.equal((await db.query('SELECT gen_auditor.asset_is_scannable($1) AS ok',[asset.id])).rows[0].ok,false);
    // Con autorización vigente, sí.
    await db.query(`INSERT INTO gen_auditor.scan_authorizations(tenant_id,domain_id,approved_by,authorization_sha256,approved_ips,allowed_tools,starts_at,expires_at)
      VALUES('${T1}','${domain.id}','${U1}','${h('doc')}','{8.8.8.8}'::inet[],ARRAY['nmap'],now(),now()+interval '2 days')`);
    assert.equal((await db.query('SELECT gen_auditor.asset_is_scannable($1) AS ok',[asset.id])).rows[0].ok,true);
  }finally{await db.close();}
});

test('un hallazgo NO se cierra con UPDATE directo: sólo con verificación revisada',async()=>{
  const db = await boot();try{
    const {finding:f} = await seedFinding(db,{fingerprint:h('hsts')});

    // 1) Con el rol runtime real, el UPDATE directo a closed está REVOCADO.
    //    Esto es la brecha que se cierra: antes el endpoint PATCH lo permitía.
    await db.exec('SET ROLE gen_auditor_api');
    await actor(db,U1,T1);
    await assert.rejects(db.query("UPDATE gen_auditor.vulnerabilities SET status='closed' WHERE id=$1",[f.id]));
    await assert.rejects(db.query("UPDATE gen_auditor.vulnerabilities SET status='closed',closed_by_verification=gen_random_uuid() WHERE id=$1",[f.id]));
    await db.exec('RESET ROLE');
    await actor(db,U1,T1);
    // 2) Ni el propietario de la base puede marcar cerrado sin señalar una
    //    verificación: el CHECK lo impide. (El DBA sí puede saltarse RLS y
    //    GRANTs — límite conocido y documentado en SEGURIDAD.md.)
    await assert.rejects(db.query("UPDATE gen_auditor.vulnerabilities SET status='closed' WHERE id=$1",[f.id]));

    // 3) close_finding sin plan entregado → no_submitted_plan
    await assert.rejects(db.query('SELECT gen_auditor.close_finding($1,gen_random_uuid())',[f.id]),/no_submitted_plan/);

    const [plan]=(await db.query(
      `INSERT INTO gen_auditor.remediation_plans(tenant_id,finding_id,asset_id,summary,owner_id,due_at,created_by)
       VALUES('${T1}','${f.id}','${(await db.query('SELECT asset_id FROM gen_auditor.vulnerabilities WHERE id=$1',[f.id])).rows[0].asset_id}',
               'Validar HTTPS en subdominios y activar HSTS','${U2}',now()+interval '7 days','${U1}') RETURNING id`)).rows;

    // 4) Plan en borrador: la verificación no cierra nada.
    await assert.rejects(db.query('SELECT gen_auditor.close_finding($1,gen_random_uuid())',[f.id]),/no_submitted_plan/);

    // 5) U2 entrega y U2 intenta verificar su propio trabajo → separación de funciones.
    await db.query(`UPDATE gen_auditor.remediation_plans SET status='submitted_for_verification',submitted_at=now(),submitted_by='${U2}' WHERE id='${plan.id}'`);
    await db.query(`UPDATE gen_auditor.vulnerabilities SET status='awaiting_verification' WHERE id='${f.id}'`);
    const [selfVerified]=(await db.query(
      `INSERT INTO gen_auditor.verification_runs(tenant_id,finding_id,plan_id,requested_by,completed_at,outcome,reviewed_by,reviewed_at)
       VALUES('${T1}','${f.id}','${plan.id}','${U2}',now()+interval '1 second','clean','${U2}',now()+interval '1 second') RETURNING id`)).rows;
    await assert.rejects(db.query('SELECT gen_auditor.close_finding($1,$2)',[f.id,selfVerified.id]),/separation_of_duties/);

    // 6) U1 revisa: cierre válido y sellado en la bitácora.
    const [reviewed]=(await db.query(
      `INSERT INTO gen_auditor.verification_runs(tenant_id,finding_id,plan_id,requested_by,completed_at,outcome,reviewed_by,reviewed_at)
       VALUES('${T1}','${f.id}','${plan.id}','${U1}',now()+interval '2 seconds','clean','${U1}',now()+interval '2 seconds') RETURNING id`)).rows;
    await db.query('SELECT gen_auditor.close_finding($1,$2,$3)',[f.id,reviewed.id,'retest limpio']);
    const closed=(await db.query('SELECT status,closed_by_verification FROM gen_auditor.vulnerabilities WHERE id=$1',[f.id])).rows[0];
    assert.equal(closed.status,'closed');
    assert.equal(closed.closed_by_verification,reviewed.id);
    assert.equal((await db.query('SELECT status FROM gen_auditor.remediation_plans WHERE id=$1',[plan.id])).rows[0].status,'verified');
    assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,true);
    const actions=(await db.query('SELECT action FROM gen_auditor.audit_logs')).rows.map(r=>r.action);
    assert.ok(actions.includes('vulnerability.closed'));
  }finally{await db.close();}
});

test('una verificación inconclusa reabre y al tercer intento escala',async()=>{
  const db = await boot();try{
    const {asset,finding:f} = await seedFinding(db,{severity:'medium',fingerprint:h('csp')});
    const [plan]=(await db.query(
      `INSERT INTO gen_auditor.remediation_plans(tenant_id,finding_id,asset_id,summary,due_at,created_by)
       VALUES('${T1}','${f.id}','${asset.id}','Desplegar politica CSP en Report-Only',now()+interval '15 days','${U1}') RETURNING id`)).rows;

    await db.query(`UPDATE gen_auditor.remediation_plans SET status='submitted_for_verification',submitted_at=now(),submitted_by='${U2}' WHERE id='${plan.id}'`);
    await assert.rejects(db.query('SELECT gen_auditor.reopen_finding($1,gen_random_uuid(),$2)',[f.id,'corto']),/reason_required/);

    for(let i=0;i<3;i++){
      await db.query(`UPDATE gen_auditor.remediation_plans SET status='submitted_for_verification',submitted_at=now(),submitted_by='${U2}',rejected_reason='' WHERE id='${plan.id}'`);
      await db.query(`UPDATE gen_auditor.vulnerabilities SET status='awaiting_verification' WHERE id='${f.id}'`);
      const [v]=(await db.query(
        `INSERT INTO gen_auditor.verification_runs(tenant_id,finding_id,plan_id,requested_by,completed_at,outcome,reviewed_by,reviewed_at,notes)
         VALUES('${T1}','${f.id}','${plan.id}','${U1}',now(),'still_present','${U1}',now(),'el problema continua presente tras el retest') RETURNING id`)).rows;
      await db.query('SELECT gen_auditor.reopen_finding($1,$2,$3)',[f.id,v.id,'el problema continua presente tras retest']);
      await db.query(`UPDATE gen_auditor.vulnerabilities SET status='in_progress' WHERE id='${f.id}'`);
    }
    const row=(await db.query('SELECT status,attempt_count FROM gen_auditor.vulnerabilities WHERE id=$1',[f.id])).rows[0];
    assert.equal(row.attempt_count,3);
    assert.equal(row.status,'in_progress');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gen_auditor.audit_logs WHERE action='remediation.escalation_required'")).rows[0].n,1);
  }finally{await db.close();}
});

test('la aceptación de riesgo exige aprobador distinto y fecha de revisión',async()=>{
  const db = await boot();try{
    const {finding:f} = await seedFinding(db,{severity:'low',fingerprint:h('referrer')});
    await assert.rejects(db.query(
      `INSERT INTO gen_auditor.risk_acceptances(tenant_id,finding_id,justification,approved_by,requested_by,review_due_at)
       VALUES('${T1}','${f.id}','Riesgo aceptado por condicion tecnica','${U1}','${U1}',now()+interval '30 days')`));
    const [a]=(await db.query(
      `INSERT INTO gen_auditor.risk_acceptances(tenant_id,finding_id,justification,approved_by,requested_by,review_due_at)
       VALUES('${T1}','${f.id}','Riesgo aceptado por condicion tecnica y funcional','${U1}','${U2}',now()+interval '30 days') RETURNING id`)).rows;
    assert.ok(a.id);
  }finally{await db.close();}
});

test('la huella evita duplicar hallazgos y libera los ya cerrados',async()=>{
  const db = await boot();try{
    const {asset,domain,finding} = await seedFinding(db,{severity:'low',fingerprint:h('stable')});
    const ins = async () => {
      const [scan]=(await db.query(`INSERT INTO gen_auditor.scans(tenant_id,domain_id,kind,status) VALUES('${T1}','${domain.id}','passive','completed') RETURNING id`)).rows;
      return (await db.query(
        `INSERT INTO gen_auditor.vulnerabilities(tenant_id,scan_id,asset_id,title,severity,recommendation,fingerprint,due_at)
         VALUES('${T1}','${scan.id}','${asset.id}','Repetido','low','corregir',$1,now()+interval '30 days') RETURNING id`,[h('stable')])).rows[0].id;
    };
    // Misma huella con otro scan_id → conflicto por el índice único, no un hallazgo nuevo.
    const [otherScan]=(await db.query(`INSERT INTO gen_auditor.scans(tenant_id,domain_id,kind,status) VALUES('${T1}','${domain.id}','passive','completed') RETURNING id`)).rows;
    await assert.rejects(db.query(
      `INSERT INTO gen_auditor.vulnerabilities(tenant_id,scan_id,asset_id,title,severity,recommendation,fingerprint,due_at)
       VALUES('${T1}','${otherScan.id}','${asset.id}','Repetido','low','corregir',$1,now()+interval '30 days')`,[h('stable')]));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.vulnerabilities')).rows[0].n,1);
    // Aceptado → la huella queda libre para una re-detección legítima.
    await db.query(`UPDATE gen_auditor.vulnerabilities SET status='accepted' WHERE id='${finding.id}'`);
    assert.ok(await ins());
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.vulnerabilities')).rows[0].n,2);
  }finally{await db.close();}
});

test('RLS: privacy no gestiona activos y cada tenant sólo ve lo suyo',async()=>{
  const db = new PGlite();try{
    await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    await db.exec(await sql('001_gen_auditor.sql'));
    await db.exec(await sql('002_runtime_role.sql'));
    await db.exec(await sql('004_assets_remediation.sql'));
    await db.exec(`INSERT INTO auth.users VALUES('${U1}'),('${U2}');
      INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant A'),('${T2}','Tenant B');
      INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true),('${T2}','${U2}','privacy',true);`);
    // El cliente lo crea el owner: privacy no puede ni dar de alta clientes.
    await db.exec(`SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
    await db.query(`INSERT INTO gen_auditor.clients(tenant_id,name) VALUES('${T1}','Cliente Owner'),('${T2}','Cliente Privado')`);
    await db.exec(`SET ROLE gen_auditor_api; SELECT set_config('app.actor_id','${U2}',false),set_config('app.tenant_id','${T2}',false)`);
    await assert.rejects(db.query(
      `INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,created_by)
       SELECT '${T2}',id,'Api Web','web_app','high',2,2,2,'${U2}' FROM gen_auditor.clients`));
    // Y no ve nada del otro tenant.
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.assets')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.remediation_plans')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.clients')).rows[0].n,1);
  }finally{await db.close();}
});

test('las vistas respetan RLS: sin security_invoker filtrarían entre tenants',async()=>{
  const db = new PGlite();try{
    await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    await db.exec(await sql('001_gen_auditor.sql'));
    await db.exec(await sql('002_runtime_role.sql'));
    await db.exec(await sql('004_assets_remediation.sql'));
    await db.exec(`INSERT INTO auth.users VALUES('${U1}'),('${U2}');
      INSERT INTO gen_auditor.tenants(id,name) VALUES('${T1}','Tenant A'),('${T2}','Tenant B');
      INSERT INTO gen_auditor.tenant_members VALUES('${T1}','${U1}','owner',true),('${T2}','${U2}','security',true);`);
    for(const [tid,uid,nombre] of [[T1,U1,'Cliente A'],[T2,U2,'Cliente B']]){
      await db.exec(`SELECT set_config('app.actor_id','${uid}',false),set_config('app.tenant_id','${tid}',false)`);
      const [c]=(await db.query(`INSERT INTO gen_auditor.clients(tenant_id,name) VALUES($1,$2) RETURNING id`,[tid,nombre])).rows;
      await db.query(`INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,created_by)
        VALUES($1,$2,'Portal Web','web_app','high',2,2,2,$3)`,[tid,c.id,uid]);
    }
    await db.exec('SET ROLE gen_auditor_api');
    await db.exec(`SELECT set_config('app.actor_id','${U1}',false),set_config('app.tenant_id','${T1}',false)`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.assets')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.v_asset_exposure')).rows[0].n,1);
    // Actor de un tenant observing el de otro: sin membresía, nada visible.
    await db.exec(`SELECT set_config('app.tenant_id','${T2}',false)`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.v_asset_exposure')).rows[0].n,0);
    // Y su propio actor sí ve su activo, y sólo el suyo.
    await db.exec(`SELECT set_config('app.actor_id','${U2}',false),set_config('app.tenant_id','${T2}',false)`);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gen_auditor.v_asset_exposure')).rows[0].n,1);
    assert.equal((await db.query(`SELECT name FROM gen_auditor.v_asset_exposure`)).rows[0].name,'Portal Web');
  }finally{await db.close();}
});

test('el anclaje externo exige una cabeza que exista en la cadena',async()=>{
  const db = await boot();try{
    await db.query("SELECT gen_auditor.append_audit('client.created',NULL,'{}')");
    const anchor=(await db.query(`SELECT gen_auditor.anchor_current('receipt-kms-firmado-0001','worm://bucket/gen/head-1','kms-key-2026') AS id`)).rows[0].id;
    assert.ok(anchor);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gen_auditor.audit_anchors")).rows[0].n,1);
    // Un ancla no es reescribible.
    await assert.rejects(db.query(`UPDATE gen_auditor.audit_anchors SET store_ref='otro' WHERE tenant_id='${T1}'`));
    assert.equal((await db.query('SELECT gen_auditor.verify_audit() AS ok')).rows[0].ok,true);
  }finally{await db.close();}
});