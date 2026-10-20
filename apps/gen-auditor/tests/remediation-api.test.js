import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';import {createApp} from '../server/app.js';import {ruleKeyFor} from '../server/domain.js';

const T='11111111-1111-4111-8111-111111111111';
const OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENGINEER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVIEWER='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const READER='dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// El escáner se inyecta: este test no toca la red. Comprueba el ciclo de
// remediación, no la visibilidad de un dominio real.
const fakeScan = async () => ({
  score: 60,
  findings: [
    {title:'HSTS no observado',severity:'medium',recommendation:'Validar HTTPS y activar HSTS.',code:'Strict-Transport-Security: max-age=31536000'},
    {title:'X-Content-Type-Options no observado',severity:'low',recommendation:'Servir tipos MIME correctos y añadir nosniff.',code:'X-Content-Type-Options: nosniff'},
  ],
  limitations:'Índice de higiene de cabeceras, no score integral de vulnerabilidades.',
});

test('ciclo completo por HTTP: activo → hallazgo → plan → entrega → verificación → cierre',async()=>{
  const db=new PGlite();
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
  await db.exec(await readFile(new URL('../sql/001_gen_auditor.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../sql/002_runtime_role.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../sql/004_assets_remediation.sql',import.meta.url),'utf8'));
  await db.exec(`INSERT INTO auth.users VALUES('${OWNER}'),('${ENGINEER}'),('${REVIEWER}'),('${READER}');
    INSERT INTO gen_auditor.tenants(id,name) VALUES('${T}','Tenant Uno');
    INSERT INTO gen_auditor.tenant_members VALUES('${T}','${OWNER}','owner',true),('${T}','${ENGINEER}','security',true),
      ('${T}','${REVIEWER}','security',true),('${T}','${READER}','reader',true);`);

  const client={query:(...a)=>db.query(...a),release(){}};
  const pool={connect:async()=>client};
  const config={supabaseUrl:'https://example.supabase.co',publishableKey:'public-demo',
    appOrigin:'https://gen.example.org',requireMfa:false,piiKey:'ab'.repeat(32),subjectKey:'cd'.repeat(32)};
  const tokens={owner:OWNER,engineer:ENGINEER,reviewer:REVIEWER,reader:READER};
  const app=createApp({pool,config,scan:fakeScan,
    verifyToken:async t=>{if(!tokens[t])throw new Error('invalid');return {sub:tokens[t],aal:'aal2'};}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const call=(url,{as='owner',body,method='GET'}={})=>fetch(base+'/api/v1'+url,{method,
    headers:{Authorization:'Bearer '+as,'X-Tenant-ID':T,...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});

  try{
    // ── 1. Inventario ──────────────────────────────────────────────────────
    const clientRes=await call('/clients',{method:'POST',body:{name:'Gen-Store',product:'Comercio'}});
    assert.equal(clientRes.status,200);
    const {id:clientId}=await clientRes.json();

    const assetRes=await call('/assets',{method:'POST',body:{
      client_id:clientId,name:'Portal Web',kind:'web_app',criticality:'high',
      confidentiality:2,integrity:2,availability:3,exposure:'internet',environment:'production'}});
    assert.equal(assetRes.status,200);
    const asset=await assetRes.json();
    assert.equal(asset.criticality,'high');

    // Un lector no gestiona activos.
    assert.equal((await call('/assets',{as:'reader',method:'POST',body:{
      client_id:clientId,name:'Intruso',kind:'host',criticality:'low',confidentiality:1,integrity:1,availability:1}})).status,403);

    // ── 2. Superficie verificada y escaneo ─────────────────────────────────
    const [domain]=(await db.query(`INSERT INTO gen_auditor.domains(tenant_id,client_id,hostname,verified_at)
      VALUES($1,$2,'portal.example.com',now()) RETURNING id`,[T,clientId])).rows;
    await db.query(`INSERT INTO gen_auditor.asset_endpoints(tenant_id,asset_id,domain_id) VALUES($1,$2,$3)`,[T,asset.id,domain.id]);
    await db.exec('SET ROLE gen_auditor_api');
    // Contexto de sesión para las consultas directas de este test: la API usa
    // set_config(...,true) dentro de una transacción que se revierte al cerrar.
    await db.exec(`SELECT set_config('app.actor_id','${OWNER}',false),set_config('app.tenant_id','${T}',false)`);

    const scan=await call('/scans',{method:'POST',body:{domain_id:domain.id,kind:'passive'}});
    assert.equal(scan.status,200);
    const scanBody=await scan.json();
    assert.equal(scanBody.findings.length,2);

    // Los hallazgos quedan anclados al activo y con huella estable.
    const assets=await (await call('/assets')).json();
    assert.equal(assets[0].open_findings,2);
    assert.equal(assets[0].asset_id,asset.id);
    const findings=(await db.query('SELECT * FROM gen_auditor.vulnerabilities ORDER BY severity')).rows;
    assert.equal(findings.length,2);
    assert.ok(findings.every(f=>f.asset_id===asset.id));
    assert.ok(findings.every(f=>/^[a-f0-9]{64}$/.test(f.fingerprint)),'todo hallazgo activo lleva huella');

    // Un segundo escaneo inmediato se limita a uno por minuto (protección real).
    assert.equal((await call('/scans',{method:'POST',body:{domain_id:domain.id,kind:'passive'}})).status,429);

    // Pero una nueva observación del MISMO problema actualiza el hallazgo:
    // la huella evita que un re-escaneo genere duplicados que nadie cierra.
    const hstsRow=(await db.query(`SELECT id,fingerprint,occurrence_count FROM gen_auditor.vulnerabilities WHERE title LIKE 'HSTS%'`)).rows[0];
    await db.query('SELECT gen_auditor.record_finding($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [(await db.query(`SELECT id FROM gen_auditor.scans ORDER BY started_at DESC LIMIT 1`)).rows[0].id,
       asset.id,'HSTS no observado','medium','high','Validar HTTPS y activar HSTS.',
       'Strict-Transport-Security: max-age=31536000',ruleKeyFor('HSTS no observado'),'portal.example.com']);
    const again=(await db.query('SELECT id,occurrence_count FROM gen_auditor.vulnerabilities ORDER BY title')).rows;
    assert.equal(again.length,2,'la re-observación no crea un hallazgo nuevo');
    assert.equal(again.find(f=>f.id===hstsRow.id).occurrence_count,hstsRow.occurrence_count+1);
    assert.ok(again.every(f=>f.occurrence_count>=1));

    // ── 3. El endpoint antiguo de cierre libre ya no existe ────────────────
    const hsts=(await db.query(`SELECT id FROM gen_auditor.vulnerabilities WHERE title LIKE 'HSTS%' LIMIT 1`)).rows[0];
    assert.equal((await call('/findings/'+hsts.id,{method:'PATCH',body:{status:'resolved',reason:'lo arreglo yo'}})).status,404);

    // ── 4. Tablero de remediación ──────────────────────────────────────────
    const backlogRes=await call('/remediation/backlog');
    const backlogText=await backlogRes.text();
    assert.equal(backlogRes.status,200,`backlog respondió: ${backlogText}`);
    const backlog=JSON.parse(backlogText);
    assert.equal(backlog.board.length,2);
    assert.equal(backlog.summary.active,2,`summary: ${JSON.stringify(backlog.summary)}`);
    assert.ok(backlog.sla_note.includes('No es un plazo normativo'));
    assert.ok(backlog.board[0].asset_name==='Portal Web');

    // ── 5. Plan de remediación ─────────────────────────────────────────────
    const planRes=await call('/findings/'+hsts.id+'/plan',{as:'engineer',method:'POST',body:{
      summary:'Validar HTTPS en subdominios y activar HSTS con max-age',
      technical_approach:'Verificar cobertura TLS y desplegar la cabecera en el borde.',
      code_example:'Strict-Transport-Security: max-age=31536000; includeSubDomains',
      change_ticket_ref:'CHG-1042',
      steps:[{description:'Validar HTTPS en todos los subdominios'},{description:'Desplegar la cabecera en el borde'}]}});
    assert.equal(planRes.status,200);
    const plan=await planRes.json();
    assert.ok(plan.due_at,'el plan hereda el SLA del hallazgo');

    // Aprobar y arrancar.
    assert.equal((await call('/plans/'+plan.id,{method:'PATCH',body:{action:'approve'}})).status,200);
    assert.equal((await call('/plans/'+plan.id,{method:'PATCH',body:{action:'start'}})).status,200);

    // ── 6. Pausa de SLA: exige motivo y aprobador ─────────────────────────
    assert.equal((await call('/plans/'+plan.id,{method:'PATCH',body:{action:'pause',reason:'corto'}})).status,422);
    const paused=await call('/plans/'+plan.id,{method:'PATCH',body:{action:'pause',reason:'Ventana de cambio coordinada con operaciones',approved_by:OWNER}});
    assert.equal(paused.status,200);
    assert.match((await paused.json()).notice,/no el riesgo/);
    assert.equal((await call('/plans/'+plan.id,{method:'PATCH',body:{action:'resume'}})).status,200);

    // ── 7. Entrega: con pasos pendientes no se entrega ────────────────────
    assert.equal((await call('/plans/'+plan.id+'/submit',{method:'POST',body:{}})).status,409);

    // Cerrar sin verificación sigue sin ser una vía: advance no conoce 'close'.
    assert.equal((await call('/findings/'+hsts.id+'/advance',{method:'POST',body:{action:'cerrar'}})).status,422);

    await db.query(`UPDATE gen_auditor.remediation_steps SET completed_at=now(),completed_by=$1 WHERE plan_id=$2`,[ENGINEER,plan.id]);
    const submit=await call('/plans/'+plan.id+'/submit',{as:'engineer',method:'POST',body:{}});
    assert.equal(submit.status,200,`submit: ${await submit.clone().text()}`);
    assert.match((await submit.json()).notice,/Otra persona debe verificar/);

    // ── 8. Verificación: quien entrega no puede certificar su cierre ──────
    const selfVerify=await call('/plans/'+plan.id+'/verify',{as:'engineer',method:'POST',body:{outcome:'clean',notes:'Todo listo'}});
    assert.equal(selfVerify.status,409);
    assert.equal((await selfVerify.json()).error,'separation_of_duties');

    // Una verificación inconclusa tampoco cierra.
    const inconclusive=await call('/plans/'+plan.id+'/verify',{as:'reviewer',method:'POST',body:{outcome:'inconclusive',notes:'No se pudo completar el retest'}});
    assert.equal(inconclusive.status,200);
    assert.equal((await inconclusive.json()).closed,false);
    assert.equal((await db.query('SELECT status FROM gen_auditor.vulnerabilities WHERE id=$1',[hsts.id])).rows[0].status,'reopened');

    // ── 9. Segundo ciclo: retest limpio, revisado por otra persona ────────
    const plan2Res=await call('/findings/'+hsts.id+'/plan',{as:'engineer',method:'POST',body:{
      summary:'Reintento: desplegar HSTS ya validado en el borde'}});
    const plan2Text=await plan2Res.text();
    assert.equal(plan2Res.status,200,`segundo plan: ${plan2Text}`);
    const plan2=JSON.parse(plan2Text);
    await call('/plans/'+plan2.id,{method:'PATCH',body:{action:'approve'}});
    await call('/plans/'+plan2.id,{method:'PATCH',body:{action:'start'}});
    await db.query(`UPDATE gen_auditor.remediation_steps SET completed_at=now(),completed_by=$1 WHERE plan_id=$2`,[ENGINEER,plan2.id]);
    await call('/plans/'+plan2.id+'/submit',{as:'engineer',method:'POST',body:{}});

    const closed=await call('/plans/'+plan2.id+'/verify',{as:'reviewer',method:'POST',
      body:{outcome:'clean',notes:'Retest posterior confirma la cabecera HSTS presente',method:'rescan'}});
    assert.equal(closed.status,200);
    const closedBody=await closed.json();
    assert.equal(closedBody.closed,true);

    const row=(await db.query('SELECT status,closed_by_verification,resolved_at FROM gen_auditor.vulnerabilities WHERE id=$1',[hsts.id])).rows[0];
    assert.equal(row.status,'closed');
    assert.ok(row.closed_by_verification,'el cierre apunta a su verificación');
    assert.ok(row.resolved_at);
    assert.equal((await db.query('SELECT status FROM gen_auditor.remediation_plans WHERE id=$1',[plan2.id])).rows[0].status,'verified');

    // ── 10. Evidencia encadenada y superficie de seguridad ────────────────
    const acts=(await db.query('SELECT action FROM gen_auditor.audit_logs')).rows.map(r=>r.action);
    assert.ok(acts.includes('vulnerability.reopened'));
    assert.ok(acts.includes('vulnerability.closed'));
    assert.ok(acts.includes('remediation.submitted'));
    assert.equal((await (await call('/audit')).json()).integrity,true);

    // El resumen refleja el cierre.
    const finalBoard=await (await call('/remediation/backlog')).json();
    assert.equal(finalBoard.summary.closed,1);

    // ── 11. Reportes y anclaje externo ────────────────────────────────────
    assert.equal((await call('/reports',{method:'POST',body:{client_id:clientId}})).status,503);
    assert.equal((await call('/reports')).status,200);
    const anchor=await call('/audit/anchor',{method:'POST',body:{
      anchor_receipt:'recibo-firmado-por-kms-0001',store_ref:'worm://gen-auditor/heads/tenant-1',key_id:'kms-2026'}});
    assert.equal(anchor.status,200);
    assert.match((await anchor.json()).notice,/reescribir la cadena completa/);

    // ── 12. Aceptación de riesgo: exige aprobador y fecha ─────────────────
    const nosniff=(await db.query(`SELECT id FROM gen_auditor.vulnerabilities WHERE title LIKE 'X-Content%' LIMIT 1`)).rows[0];
    assert.equal((await call('/findings/'+nosniff.id+'/accept-risk',{method:'POST',body:{
      justification:'corto',review_due_at:new Date(Date.now()+86400000).toISOString()}})).status,422);
    const accepted=await call('/findings/'+nosniff.id+'/accept-risk',{method:'POST',body:{
      justification:'El sitio es una landing estática sin formularios ni datos personales',
      review_due_at:new Date(Date.now()+30*86400000).toISOString(),requested_by:ENGINEER}});
    assert.equal(accepted.status,200);
    assert.match((await accepted.json()).notice,/queda silenciado/);

  }finally{await new Promise(r=>server.close(r));await db.close();}
});