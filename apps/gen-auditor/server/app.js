import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes,randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context,audit } from './db.js';
import { sha256,encrypt,subjectRef,dueAt,compliance,incidentDeadlines,normalizeDomain,isPublicIP,ruleKeyFor,effectiveSeverity } from './domain.js';
import { passiveScan,verifyDNS,resolvePublic,activePlan } from './scanner.js';
import { securityReport } from './report.js';
import { verifyBridgeSignature, bridgeKeys, bridgeRouter } from './bridge.js';
const uuid=z.uuid();const text=z.string().trim().min(2).max(160);
const fail=(code,status=400)=>Object.assign(new Error(code),{status});
const allow=(db,roles)=>{if(!roles.includes(db.memberRole))throw fail('forbidden',403);};
export function createApp({pool,verifyToken,config,scan=passiveScan,verify=verifyDNS}) {
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
 app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'",config.supabaseUrl],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:config.frameAncestors||["'none'"],formAction:["'self'"]}}}));
 app.use(express.json({limit:'64kb'}));
 app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.get('/api/health',(_req,res)=>res.json({status:'ok',version:'0.1.0'}));
 app.get('/api/public-config',(_req,res)=>res.json({supabaseUrl:config.supabaseUrl,publishableKey:config.publishableKey,requireMfa:config.requireMfa,activeScanner:config.activeScannerEnabled===true,arcopPanelUrl:config.arcopPanelUrl||null}));
 app.use('/api/v1',async(req,res,next)=>{
  try {
   if(req.get('origin')&&req.get('origin')!==config.appOrigin)throw fail('origin_forbidden',403);
   const token=req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];if(!token)throw fail('unauthenticated',401);
   req.identity=await verifyToken(token);uuid.parse(req.identity.sub);
   if(config.requireMfa&&req.identity.aal!=='aal2')throw fail('mfa_required',403);
   next();
  }catch(e){next(e.status?e:fail('invalid_token',401));}
 });
 app.use('/api/v1',rateLimit({windowMs:60000,limit:120,keyGenerator:req=>req.identity.sub,standardHeaders:'draft-8',legacyHeaders:false}));
 app.get('/api/v1/tenants',async(req,res)=>res.json(await context(pool,req.identity.sub,null,async db=>(await db.query('SELECT gen_auditor.my_tenants() AS tenants')).rows[0].tenants)));
 const endpoint=(method,url,fn)=>app[method]('/api/v1'+url,async(req,res)=>{
   const tenant=uuid.parse(req.get('x-tenant-id'));
   const out=await context(pool,req.identity.sub,tenant,async db=>{
     const result=await fn({db,tenant,actor:req.identity.sub,req});
     if(method==='get')await audit(db,'access.read',null,{resource:url});return result;
   });
   if(out?.pdf){res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="gen-auditor.pdf"'}).send(out.pdf);}else res.json(out);
 });
 const rows=async(db,sql,values=[])=>(await db.query(sql,values)).rows;
 endpoint('get','/dashboard',async({db})=>{
  const [controls,risks,findings,requests,incidents,events,members,anomalies,integrity]=await Promise.all([
   rows(db,'SELECT * FROM gen_auditor.controls ORDER BY framework,reference'),rows(db,"SELECT * FROM gen_auditor.risks WHERE status='open'"),
   rows(db,"SELECT id,severity,due_at FROM gen_auditor.vulnerabilities WHERE status IN ('open','in_progress')"),
   rows(db,"SELECT id,due_at FROM gen_auditor.arco_requests WHERE state<>'closed_external'"),rows(db,'SELECT * FROM gen_auditor.incidents ORDER BY created_at DESC LIMIT 50'),
   rows(db,'SELECT count(*)::int AS count FROM gen_auditor.audit_logs'),rows(db,"SELECT count(DISTINCT actor_id)::int AS count FROM gen_auditor.audit_logs WHERE occurred_at>now()-interval '30 days'"),
   rows(db,"SELECT count(*)::int AS count FROM gen_auditor.anomalies WHERE status='open'"),rows(db,'SELECT gen_auditor.verify_audit() AS valid')]);
  const due=[...findings,...requests,...risks].filter(x=>x.due_at&&new Date(x.due_at)>=new Date()&&new Date(x.due_at)<=new Date(Date.now()+60*86400000)).length;
  return {compliance:compliance(controls.filter(x=>x.framework==='ISO27001:2022')),risks:risks.length,findings:findings.length,due60:due,events:events[0].count,activeUsers:members[0].count,anomalies:anomalies[0].count,integrity:integrity[0].valid,controls,incidents:incidents.map(x=>({...x,deadlines:incidentDeadlines(x)}))};
 });
 endpoint('get','/clients',async({db})=>rows(db,`SELECT c.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'hostname',d.hostname,'verified_at',d.verified_at,'score',(SELECT s.score FROM gen_auditor.scans s WHERE s.domain_id=d.id AND s.status='completed' AND s.kind='passive' ORDER BY started_at DESC LIMIT 1))) FROM gen_auditor.domains d WHERE d.client_id=c.id),'[]') AS domains FROM gen_auditor.clients c ORDER BY c.created_at DESC`));
 endpoint('post','/clients',async({db,tenant,actor,req})=>{allow(db,['owner','security']);const b=z.object({name:text,product:z.string().max(120).default('')}).strict().parse(req.body);const [r]=await rows(db,'INSERT INTO gen_auditor.clients(tenant_id,name,product) VALUES($1,$2,$3) RETURNING *',[tenant,b.name,b.product]);await audit(db,'client.created',r.id);return r;});
 endpoint('post','/domains',async({db,tenant,req})=>{
  allow(db,['owner','security']);const b=z.object({client_id:uuid,hostname:z.string().max(253)}).strict().parse(req.body);const hostname=normalizeDomain(b.hostname),token='ga-verify-'+randomBytes(24).toString('hex');
  const [r]=await rows(db,"INSERT INTO gen_auditor.domains(tenant_id,client_id,hostname,verification_token_hash,verification_expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id,hostname",[tenant,b.client_id,hostname,sha256(token)]);await audit(db,'domain.created',r.id);return {...r,dns_name:'_gen-auditor.'+hostname,dns_value:token};
 });
 endpoint('post','/domains/:id/verify',async({db,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);const [d]=await rows(db,'SELECT * FROM gen_auditor.domains WHERE id=$1',[id]);if(!d)throw fail('not_found',404);if(new Date(d.verification_expires_at)<new Date())throw fail('challenge_expired');if(!await verify(d.hostname,d.verification_token_hash))throw fail('dns_not_verified');await db.query('UPDATE gen_auditor.domains SET verified_at=now() WHERE id=$1',[id]);await audit(db,'domain.verified',id);return {verified:true};});

 endpoint('post','/scan-authorizations',async({db,tenant,actor,req})=>{
  allow(db,['owner','security']);const b=z.object({domain_id:uuid,authorization_sha256:z.string().regex(/^[a-f0-9]{64}$/),approved_ips:z.array(z.string().refine(isPublicIP)).min(1).max(4),expires_at:z.iso.datetime()}).strict().parse(req.body);
  const [d]=await rows(db,'SELECT * FROM gen_auditor.domains WHERE id=$1',[b.domain_id]);if(!d||!d.verified_at)throw fail('verified_domain_required',409);
  const end=new Date(b.expires_at);if(end<=new Date()||end>new Date(Date.now()+7*86400000))throw fail('invalid_scope_window');
  const [r]=await rows(db,"INSERT INTO gen_auditor.scan_authorizations(tenant_id,domain_id,approved_by,authorization_sha256,approved_ips,allowed_tools,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,ARRAY['nmap'],now(),$6) RETURNING id",[tenant,d.id,actor,b.authorization_sha256,b.approved_ips,b.expires_at]);await audit(db,'scan.authorization_recorded',r.id,{document_sha256:b.authorization_sha256});return r;
 });
 endpoint('post','/scan-authorizations/:id/revoke',async({db,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);const updated=await rows(db,'UPDATE gen_auditor.scan_authorizations SET revoked_at=now() WHERE id=$1 RETURNING id',[id]);if(!updated.length)throw fail('not_found',404);await audit(db,'scan.authorization_revoked',id);return {id,revoked:true,notice:'Impide nuevas ejecuciones; una comprobación en curso puede continuar hasta su timeout.'};});
 endpoint('get','/findings',async({db})=>rows(db,`SELECT v.*,d.hostname,a.name AS asset_name FROM gen_auditor.vulnerabilities v
   JOIN gen_auditor.scans s ON s.id=v.scan_id JOIN gen_auditor.domains d ON d.id=s.domain_id
   LEFT JOIN gen_auditor.assets a ON a.id=v.asset_id ORDER BY v.detected_at DESC LIMIT 250`));
 endpoint('post','/scans',async({db,tenant,req})=>{
  allow(db,['owner','security']);const b=z.object({domain_id:uuid,kind:z.enum(['passive','active']),authorization_id:uuid.optional()}).strict().parse(req.body);
  if(b.kind==='active'&&!config.activeScannerEnabled)throw fail('active_runner_not_deployed',409);
  const [d]=await rows(db,'SELECT * FROM gen_auditor.domains WHERE id=$1',[b.domain_id]);if(!d)throw fail('not_found',404);if(!d.verified_at||new Date(d.verified_at)<new Date(Date.now()-86400000))throw fail('verification_required',409);
  if(b.kind==='active'){
   if(!b.authorization_id)throw fail('authorization_required',409);
   const [authorization]=await rows(db,'SELECT * FROM gen_auditor.scan_authorizations WHERE id=$1',[b.authorization_id]);
   const addresses=await resolvePublic(d.hostname);if(addresses.length>4)throw fail('too_many_targets',409);activePlan({domain:d,authorization,tool:'nmap',ips:addresses.map(x=>x.address)});
   const [queued]=await rows(db,"INSERT INTO gen_auditor.scans(tenant_id,domain_id,kind,status,authorization_id) VALUES($1,$2,'active','queued',$3) RETURNING id",[tenant,d.id,b.authorization_id]);await audit(db,'scan.active_queued',queued.id);return {...queued,status:'queued',notice:'En cola para el worker autorizado; todavía no es un escaneo completado.'};
  }
  const recent=await rows(db,"SELECT id FROM gen_auditor.scans WHERE domain_id=$1 AND started_at>now()-interval '1 minute'",[d.id]);if(recent.length)throw fail('scan_rate_limited',429);
  const [s]=await rows(db,"INSERT INTO gen_auditor.scans(tenant_id,domain_id,kind,status) VALUES($1,$2,'passive','running') RETURNING id",[tenant,d.id]);
  let result;try{result=await scan(d.hostname);}catch(e){await db.query("UPDATE gen_auditor.scans SET status='failed',finished_at=now(),error_code='probe_failed' WHERE id=$1",[s.id]);await audit(db,'scan.failed',s.id);return {id:s.id,status:'failed',reason:'No se pudo completar HTTPS. Revisar DNS, TLS, estado HTTP o redirección; no se asigna score.'};}
  await db.query("UPDATE gen_auditor.scans SET status='completed',finished_at=now(),score=$2,evidence=$3 WHERE id=$1",[s.id,result.score,JSON.stringify(result)]);
  // El registro, la deduplicación por huella y la severidad efectiva los
  // resuelve gen_auditor.record_finding(): la base es dueña del índice único
  // parcial y `severity` no es escribible por el rol de aplicación.
  const linked=await rows(db,`SELECT e.asset_id,a.criticality FROM gen_auditor.asset_endpoints e
    JOIN gen_auditor.assets a ON a.tenant_id=e.tenant_id AND a.id=e.asset_id WHERE e.domain_id=$1 AND a.retired_at IS NULL`,[d.id]);
  const targets=linked.length?linked:[{asset_id:null,criticality:'low'}];
  for(const f of result.findings)for(const target of targets){
   if(!target.asset_id){await db.query('INSERT INTO gen_auditor.vulnerabilities(tenant_id,scan_id,title,severity,recommendation,code_example,due_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [tenant,s.id,f.title,effectiveSeverity(f.severity,'low'),f.recommendation,f.code,dueAt(effectiveSeverity(f.severity,'low'))]);continue;}
   await db.query(`SELECT gen_auditor.record_finding($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
     [s.id,target.asset_id,f.title,f.severity,target.criticality,f.recommendation,f.code,ruleKeyFor(f.title),d.hostname]);
  }
  await audit(db,'scan.completed',s.id,{kind:'passive',score:result.score});return {id:s.id,status:'completed',...result};
 });
 // ── Inventario de activos ────────────────────────────────────────────────
 const assetBody=z.object({client_id:uuid,name:text,kind:z.enum(['web_app','api','host','network_segment','database','cloud_resource','saas','mobile_app','ci_cd','repository','other']),
  criticality:z.enum(['critical','high','medium','low']),confidentiality:z.coerce.number().int().min(1).max(3),
  integrity:z.coerce.number().int().min(1).max(3),availability:z.coerce.number().int().min(1).max(3),
  data_class:z.enum(['public','internal','confidential','restricted_personal','restricted_secret']).default('internal'),
  exposure:z.enum(['internet','vpn','internal','isolated']).default('internal'),
  environment:z.enum(['production','staging','development','sandbox']).default('production'),
  inventory_source:z.enum(['manual','imported','discovered','attested']).default('manual'),
  owner_ref:z.string().max(120).default(''),criticality_justification:z.string().max(2000).default(''),notes:z.string().max(2000).default('')}).strict();
 endpoint('get','/assets',async({db})=>rows(db,`SELECT v.*,c.name AS client_name,
   (SELECT count(*) FROM gen_auditor.asset_endpoints e JOIN gen_auditor.domains d ON d.tenant_id=e.tenant_id AND d.id=e.domain_id
     WHERE e.tenant_id=v.tenant_id AND e.asset_id=v.asset_id AND d.verified_at IS NOT NULL) AS verified_endpoints,
   gen_auditor.asset_is_scannable(v.asset_id) AS scannable
   FROM gen_auditor.v_asset_exposure v JOIN gen_auditor.clients c ON c.id=v.client_id ORDER BY v.criticality DESC, v.name`));
 endpoint('get','/assets/:id',async({db,req})=>{const id=uuid.parse(req.params.id);
  const [asset]=await rows(db,`SELECT * FROM gen_auditor.assets WHERE id=$1`,[id]);if(!asset)throw fail('not_found',404);
  return {...asset,scannable:(await rows(db,'SELECT gen_auditor.asset_is_scannable($1) AS s',[id]))[0].s,
   endpoints:await rows(db,`SELECT e.domain_id,d.hostname,d.verified_at FROM gen_auditor.asset_endpoints e JOIN gen_auditor.domains d ON d.tenant_id=e.tenant_id AND d.id=e.domain_id WHERE e.asset_id=$1`,[id]),
   findings:await rows(db,`SELECT id,title,severity,status,fingerprint,occurrence_count,attempt_count,first_detected_at,last_detected_at,source,
     gen_auditor.sla_due_at(severity,first_detected_at) AS due_at FROM gen_auditor.vulnerabilities WHERE asset_id=$1 ORDER BY status,severity`,[id])};});
 endpoint('post','/assets',async({db,tenant,actor,req})=>{allow(db,['owner','security']);const b=assetBody.parse(req.body);
  const [c]=await rows(db,'SELECT id FROM gen_auditor.clients WHERE id=$1',[b.client_id]);if(!c)throw fail('not_found',404);
  const [r]=await rows(db,`INSERT INTO gen_auditor.assets(tenant_id,client_id,name,kind,criticality,confidentiality,integrity,availability,data_class,exposure,environment,inventory_source,owner_ref,criticality_justification,notes,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[tenant,b.client_id,b.name,b.kind,b.criticality,b.confidentiality,b.integrity,b.availability,b.data_class,b.exposure,b.environment,b.inventory_source,b.owner_ref,b.criticality_justification,b.notes,actor]);
  await audit(db,'asset.created',r.id,{criticality:b.criticality,kind:b.kind});return r;});
 endpoint('post','/assets/:id/endpoints',async({db,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id),b=z.object({domain_id:uuid,path_prefix:z.string().max(200).default('')}).strict().parse(req.body);
  const [d]=await rows(db,`SELECT id FROM gen_auditor.domains WHERE id=$1`,[b.domain_id]);if(!d)throw fail('not_found',404);
  const [r]=await rows(db,`INSERT INTO gen_auditor.asset_endpoints(tenant_id,asset_id,domain_id,path_prefix) VALUES(gen_auditor.tenant_id(),$1,$2,$3)
    ON CONFLICT (tenant_id,asset_id,domain_id) DO UPDATE SET path_prefix=EXCLUDED.path_prefix RETURNING *`,[id,b.domain_id,b.path_prefix]);
  await audit(db,'asset.endpoint_linked',id,{domain_id:b.domain_id});return {notice:'El activo hereda la autorización del dominio: enlazarlo no habilita escanear.'};});
 endpoint('post','/assets/:id/retire',async({db,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id),b=z.object({reason:z.string().min(10).max(2000)}).strict().parse(req.body);
  const [r]=await rows(db,`UPDATE gen_auditor.assets SET retired_at=now(),last_verified_at=now(),notes=left($2,2000) WHERE id=$1 RETURNING id`,[id,b.reason]);
  if(!r.length)throw fail('not_found',404);await audit(db,'asset.retired',id,{reason_sha256:sha256(b.reason)});return {id,retired:true,notice:'Un activo retirado deja de ser escaneable. Los hallazgos abiertos NO se cierran solos.'};});

 // ── Ciclo de remediación ──────────────────────────────────────────────────
 endpoint('get','/remediation/backlog',async({db})=>({
  board:await rows(db,`SELECT * FROM gen_auditor.v_finding_backlog ORDER BY
      CASE status WHEN 'awaiting_verification' THEN 0 WHEN 'reopened' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, due_at NULLS LAST LIMIT 300`),
  summary:(await rows(db,`SELECT
    count(*) FILTER (WHERE status NOT IN ('closed','accepted','false_positive'))::int AS active,
    count(*) FILTER (WHERE overdue AND status NOT IN ('closed','accepted','false_positive'))::int AS overdue,
    count(*) FILTER (WHERE plan_status='submitted_for_verification')::int AS awaiting_verification,
    count(*) FILTER (WHERE plan_paused)::int AS paused,
    count(*) FILTER (WHERE attempt_count>=3 AND status NOT IN ('closed','accepted'))::int AS escalated,
    count(*) FILTER (WHERE status='closed')::int AS closed
    FROM gen_auditor.v_finding_backlog`))[0],
  sla_note:'SLA interno de Gen-Auditor. No es un plazo normativo ni de reporte de incidentes.'}));

 endpoint('post','/findings/:id/advance',async({db,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  const b=z.object({action:z.enum(['start','accept','false_positive']),reason:z.string().max(2000).default('')}).strict().parse(req.body);
  const head=await rows(db,'SELECT gen_auditor.advance_finding($1,$2,$3) AS head',[id,b.action,b.reason]);
  await audit(db,'vulnerability.advanced',id,{action:b.action});return {id,head:head[0].head,
   notice:'Un hallazgo sólo se cierra con verificación posterior revisada por otra persona.'};});

 endpoint('post','/findings/:id/plan',async({db,tenant,actor,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  const b=z.object({summary:z.string().min(10).max(400),technical_approach:z.string().max(4000).default(''),code_example:z.string().max(20000).default(''),
   change_ticket_ref:z.string().max(120).default(''),owner_id:uuid.optional(),steps:z.array(z.object({description:z.string().min(3).max(600)})).max(60).default([])}).strict().parse(req.body);
  const [f]=await rows(db,'SELECT asset_id,severity FROM gen_auditor.vulnerabilities WHERE id=$1',[id]);if(!f)throw fail('not_found',404);
  if(!f.asset_id)throw fail('asset_required',409);
  const [plan]=await rows(db,`INSERT INTO gen_auditor.remediation_plans(tenant_id,finding_id,asset_id,summary,technical_approach,code_example,change_ticket_ref,owner_id,due_at,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,gen_auditor.sla_due_at($9,$10),$11) RETURNING *`,
    [tenant,id,f.asset_id,b.summary,b.technical_approach,b.code_example,b.change_ticket_ref,b.owner_id||actor,f.severity,(await rows(db,'SELECT first_detected_at FROM gen_auditor.vulnerabilities WHERE id=$1',[id]))[0].first_detected_at,actor]);
  for(const [i,step] of b.steps.entries())await db.query(`INSERT INTO gen_auditor.remediation_steps(tenant_id,plan_id,position,description) VALUES($1,$2,$3,$4)`,[tenant,plan.id,i+1,step.description]);
  await audit(db,'remediation.planned',plan.id,{finding_id:id});return {...plan,code_example_note:'Fragmento propuesto por el auditor: no es un parche aplicado.'};});

 endpoint('patch','/plans/:id',async({db,actor,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  // Cada acción valida su propio cuerpo con esquema estricto: no se aceptan
  // claves desconocidas, pero tampoco se rechaza una carga legítima por usar
  // un único esquema para todas las acciones.
  const action=z.object({action:z.enum(['approve','start','pause','resume'])}).passthrough().parse(req.body).action;
  const [p]=await rows(db,'SELECT * FROM gen_auditor.remediation_plans WHERE id=$1',[id]);if(!p)throw fail('not_found',404);
  if(action==='pause'){const q=z.object({action:z.literal('pause'),reason:z.string().min(10).max(2000),approved_by:uuid}).strict().parse(req.body);
   await db.query(`UPDATE gen_auditor.remediation_plans SET paused_at=now(),pause_reason=$2,pause_approved_by=$3,status='in_progress' WHERE id=$1`,[id,q.reason,q.approved_by]);
   await audit(db,'remediation.paused',id,{reason_sha256:sha256(q.reason)});return {id,paused:true,notice:'Se pausa el reloj, no el riesgo: el hallazgo sigue abierto.'};}
  z.object({action:z.enum(['approve','start','resume'])}).strict().parse(req.body);
  if(action==='resume'){await db.query(`UPDATE gen_auditor.remediation_plans SET paused_at=NULL,pause_reason='',pause_approved_by=NULL WHERE id=$1`,[id]);
   await audit(db,'remediation.resumed',id);return {id,resumed:true};}
  const next=action==='approve'?'approved':'in_progress';
  if(p.status!=='draft'&&p.status!=='approved')throw fail('invalid_transition',409);
  await db.query('UPDATE gen_auditor.remediation_plans SET status=$2,updated_at=now() WHERE id=$1',[id,next]);
  await audit(db,'remediation.'+action+'d',id);return {id,status:next};});

 endpoint('post','/plans/:id/submit',async({db,actor,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  const [p]=await rows(db,'SELECT * FROM gen_auditor.remediation_plans WHERE id=$1',[id]);if(!p)throw fail('not_found',404);
  if(!['approved','in_progress'].includes(p.status))throw fail('invalid_transition',409);
  const pending=(await rows(db,'SELECT count(*)::int AS n FROM gen_auditor.remediation_steps WHERE plan_id=$1 AND completed_at IS NULL',[id]))[0].n;
  if(pending)throw fail('steps_incomplete',409);
  await db.query(`UPDATE gen_auditor.remediation_plans SET status='submitted_for_verification',submitted_at=now(),submitted_by=$2,updated_at=now() WHERE id=$1`,[id,actor]);
  // El estado del hallazgo lo mueve la base, no la aplicación: `status` no es
  // escribible por el rol de aplicación a propósito.
  await db.query('SELECT gen_auditor.mark_awaiting_verification($1)',[p.finding_id]);
  await audit(db,'remediation.submitted',id,{finding_id:p.finding_id});
  return {id,status:'submitted_for_verification',notice:'Otra persona debe verificar el cierre. Quien entrega no puede certificar su propio trabajo.'};});

 endpoint('post','/plans/:id/verify',async({db,actor,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  const b=z.object({outcome:z.enum(['clean','still_present','inconclusive']),notes:z.string().max(4000).default(''),method:z.enum(['rescan','manual_review','config_diff','external_attestation']).default('rescan'),
   evidence:z.record(z.string(),z.unknown()).default({}),scan_id:uuid.optional()}).strict().parse(req.body);
  const [p]=await rows(db,'SELECT * FROM gen_auditor.remediation_plans WHERE id=$1',[id]);if(!p)throw fail('not_found',404);
  if(p.status!=='submitted_for_verification')throw fail('invalid_transition',409);
  if(p.submitted_by===actor)throw fail('separation_of_duties',409);
  if(b.scan_id)await db.query('SELECT gen_auditor.assert_scan_authorized($1)',[b.scan_id]);
  if(['still_present','inconclusive'].includes(b.outcome)&&b.notes.trim().length<10)throw fail('notes_required',422);
  const [v]=await rows(db,`INSERT INTO gen_auditor.verification_runs(tenant_id,finding_id,plan_id,scan_id,requested_by,completed_at,outcome,method,evidence,reviewed_by,reviewed_at,notes)
    VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8::jsonb,$5,now(),$9) RETURNING *`,[p.tenant_id,p.finding_id,id,b.scan_id||null,actor,b.outcome,b.method,JSON.stringify(b.evidence),b.notes]);
  const head=b.outcome==='clean'
   ? (await rows(db,'SELECT gen_auditor.close_finding($1,$2,$3) AS head',[p.finding_id,v.id,b.notes]))[0].head
   : (await rows(db,'SELECT gen_auditor.reopen_finding($1,$2,$3) AS head',[p.finding_id,v.id,b.notes]))[0].head;
  return {verification_id:v.id,finding_id:p.finding_id,outcome:b.outcome,
   closed:b.outcome==='clean',
   notice:b.outcome==='clean'?'Cerrado con verificación posterior revisada.'
    :b.outcome==='inconclusive'?'Una verificación inconclusa NO cierra nada: el hallazgo sigue abierto con el motivo registrado.'
    :'Reabierto: el problema sigue presente tras el retest.'};});

 endpoint('get','/findings/:id/verifications',async({db,req})=>rows(db,`SELECT v.*,p.submitted_by FROM gen_auditor.verification_runs v
   LEFT JOIN gen_auditor.remediation_plans p ON p.tenant_id=v.tenant_id AND p.id=v.plan_id WHERE v.finding_id=$1 ORDER BY v.requested_at DESC`,[uuid.parse(req.params.id)]));
 endpoint('post','/findings/:id/accept-risk',async({db,tenant,actor,req})=>{allow(db,['owner','security']);const id=uuid.parse(req.params.id);
  const b=z.object({justification:z.string().min(20).max(4000),compensating_controls:z.string().max(2000).default(''),review_due_at:z.iso.datetime(),requested_by:uuid.optional()}).strict().parse(req.body);
  const [r]=await rows(db,`INSERT INTO gen_auditor.risk_acceptances(tenant_id,finding_id,justification,compensating_controls,approved_by,requested_by,review_due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[tenant,id,b.justification,b.compensating_controls,actor,b.requested_by||actor,b.review_due_at]);
  await audit(db,'risk.accepted',id,{review_due_at:b.review_due_at});return {...r,notice:'La aceptación tiene fecha de revisión: sin ella, el hallazgo queda silenciado.'};});

 // ── Reportes y anclaje ────────────────────────────────────────────────────
 endpoint('get','/reports',async({db})=>rows(db,`SELECT r.id,r.report_code,r.created_at,r.created_by,r.key_ref,r.anchor_seq,c.name AS client_name,
   jsonb_array_length(r.sections) AS section_count,octet_length(r.pdf) AS pdf_bytes,r.signature FROM gen_auditor.reports r JOIN gen_auditor.clients c ON c.id=r.client_id ORDER BY r.created_at DESC LIMIT 100`));
 endpoint('post','/audit/anchor',async({db,req})=>{allow(db,['owner','security']);
  const b=z.object({anchor_receipt:z.string().min(16).max(4000),store_ref:z.string().min(3).max(400),key_id:z.string().max(120)}).strict().parse(req.body);
  const [r]=await rows(db,'SELECT gen_auditor.anchor_current($1,$2,$3) AS id',[b.anchor_receipt,b.store_ref,b.key_id]);
  await audit(db,'audit.anchored',r.id,{key_id:b.key_id});
  return {id:r.id,notice:'Ancla externa registrada. Sin ella, el propietario de la base puede reescribir la cadena completa.'};});
 endpoint('post','/compliance/snapshot',async({db,tenant,req})=>{allow(db,['owner','auditor']);
  const b=z.object({framework:text,version:text}).strict().parse(req.body);
  const [m]=await rows(db,`SELECT count(*)::int AS total,count(*) FILTER (WHERE status='verified')::int AS verified
    FROM gen_auditor.controls WHERE framework=$1 AND status<>'not_applicable'`,[b.framework]);
  const [head]=await rows(db,'SELECT head_hash FROM gen_auditor.audit_heads WHERE tenant_id=$1',[tenant]);
  const open=(await rows(db,`SELECT count(*)::int AS n FROM gen_auditor.vulnerabilities WHERE status NOT IN ('closed','accepted','false_positive')`))[0].n;
  const [r]=await rows(db,`INSERT INTO gen_auditor.compliance_snapshots(tenant_id,framework,version,applicable_controls,verified_controls,percent,measured,open_findings,audit_head_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[tenant,b.framework,b.version,m.total,m.verified,
    m.total?Math.round(m.verified/m.total*10000)/100:null,m.total>0,open,head?.head_hash||'']);
  await audit(db,'compliance.snapshot_taken',r.id,{framework:b.framework,measured:r.measured});
  return {...r,note:r.measured?null:'Sin medición: el catálogo no declara controles aplicables. No se informa 100 %.'};});
 endpoint('get','/consents',async({db})=>rows(db,'SELECT c.id,c.client_id,cl.name AS client_name,c.subject_ref,c.purpose,c.legal_version,c.legal_sha256,c.accepted_at,EXISTS(SELECT 1 FROM gen_auditor.consent_events e WHERE e.consent_id=c.id AND e.event=\'withdrawn\') AS withdrawn FROM gen_auditor.consents c JOIN gen_auditor.clients cl ON cl.id=c.client_id ORDER BY accepted_at DESC LIMIT 250'));
 endpoint('post','/consents',async({db,tenant,actor,req})=>{allow(db,['owner','privacy']);const b=z.object({client_id:uuid,identity:z.string().min(3).max(100),purpose:z.string().min(3).max(500),legal_text:z.string().min(20).max(15000),legal_version:text}).strict().parse(req.body);const id=randomUUID(),hash=sha256(b.legal_text);
  await db.query('INSERT INTO gen_auditor.consents(id,tenant_id,client_id,subject_ref,identity_ciphertext,purpose,legal_text,legal_version,legal_sha256,ip_ciphertext,user_agent_ciphertext,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,tenant,b.client_id,subjectRef(tenant,b.identity,config.subjectKey),encrypt(b.identity,tenant,config.piiKey),b.purpose,b.legal_text,b.legal_version,hash,encrypt(req.ip||'',tenant,config.piiKey),encrypt((req.get('user-agent')||'').slice(0,1000),tenant,config.piiKey),actor]);await audit(db,'consent.recorded',id,{legal_sha256:hash});return {id,legal_sha256:hash};});
 endpoint('post','/consents/:id/withdraw',async({db,tenant,req})=>{allow(db,['owner','privacy']);const id=uuid.parse(req.params.id);await db.query("INSERT INTO gen_auditor.consent_events(tenant_id,consent_id,event) VALUES($1,$2,'withdrawn')",[tenant,id]);await audit(db,'consent.withdrawn',id);return {withdrawn:true,notice:'Debe propagarse el cese mediante el sistema responsable; registrar aquí no detiene tratamientos externos.'};});
 endpoint('get','/arco-requests',async({db})=>rows(db,'SELECT id,client_id,subject_ref,right_type,state,legal_regime,due_at,upstream_request_id,created_at FROM gen_auditor.arco_requests ORDER BY created_at DESC LIMIT 250'));
 endpoint('post','/arco-requests',async()=>{throw fail('use_independent_arcop_service',409);});
 for(const [table,fields] of Object.entries({eipds:['title','processing_purpose','risk_summary'],anonymization_plans:['title','dataset_ref','method']})){
  const route=table.replaceAll('_','-');endpoint('get','/'+route,async({db})=>rows(db,`SELECT * FROM gen_auditor.${table} ORDER BY created_at DESC LIMIT 100`));
  endpoint('post','/'+route,async({db,tenant,req})=>{allow(db,['owner','privacy']);const shape=Object.fromEntries(fields.map(f=>[f,z.string().min(3).max(2000)]));const b=z.object(shape).strict().parse(req.body);const [r]=await rows(db,`INSERT INTO gen_auditor.${table}(tenant_id,${fields.join(',')}) VALUES($1,${fields.map((_,i)=>'$'+(i+2)).join(',')}) RETURNING *`,[tenant,...fields.map(f=>b[f])]);await audit(db,table+'.created',r.id);return r;});
 }
 endpoint('post','/controls',async({db,tenant,req})=>{allow(db,['owner','security']);const b=z.object({framework:z.enum(['ISO27001:2022','CL-21663','CL-21719']),reference:text,title:text,evidence_ref:z.string().max(500).default('')}).strict().parse(req.body);const [r]=await rows(db,'INSERT INTO gen_auditor.controls(tenant_id,framework,reference,title,evidence_ref,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[tenant,b.framework,b.reference,b.title,b.evidence_ref,b.evidence_ref?'evidence':'pending',req.identity.sub]);await audit(db,'control.created',r.id);return r;});
 endpoint('post','/incidents',async({db,tenant,req})=>{allow(db,['owner','security']);const b=z.object({title:text,known_at:z.iso.datetime(),obligated:z.boolean(),oiv:z.boolean(),essential_affected:z.boolean()}).strict().parse(req.body);const [r]=await rows(db,'INSERT INTO gen_auditor.incidents(tenant_id,title,known_at,obligated,oiv,essential_affected) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[tenant,b.title,b.known_at,b.obligated,b.oiv,b.essential_affected]);await audit(db,'incident.recorded',r.id);return {...r,deadlines:incidentDeadlines(r)};});

 endpoint('patch','/controls/:id',async({db,actor,req})=>{allow(db,['owner','security','auditor']);const b=z.object({status:z.enum(['pending','evidence','verified','not_applicable']),evidence_ref:z.string().min(10).max(500)}).strict().parse(req.body);const [c]=await rows(db,'SELECT * FROM gen_auditor.controls WHERE id=$1',[uuid.parse(req.params.id)]);if(!c)throw fail('not_found',404);if(b.status==='verified'&&c.created_by===actor)throw fail('independent_review_required',409);await db.query('UPDATE gen_auditor.controls SET status=$2,evidence_ref=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1',[c.id,b.status,b.evidence_ref,actor]);await audit(db,'control.reviewed',c.id,{status:b.status,evidence_sha256:sha256(b.evidence_ref)});return {id:c.id,status:b.status};});
 endpoint('post','/risks',async({db,tenant,req})=>{allow(db,['owner','security']);const b=z.object({title:text,severity:z.enum(['critical','high','medium','low']),due_at:z.iso.datetime().optional()}).strict().parse(req.body);const [r]=await rows(db,'INSERT INTO gen_auditor.risks(tenant_id,title,severity,due_at) VALUES($1,$2,$3,$4) RETURNING *',[tenant,b.title,b.severity,b.due_at||null]);await audit(db,'risk.registered',r.id);return r;});
 endpoint('get','/risks',async({db})=>rows(db,'SELECT * FROM gen_auditor.risks ORDER BY due_at NULLS LAST LIMIT 100'));
 endpoint('patch','/incidents/:id',async({db,req})=>{allow(db,['owner','security']);const b=z.object({stage:z.enum(['early','update','final','resolved']),at:z.iso.datetime(),receipt_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);const [i]=await rows(db,'SELECT * FROM gen_auditor.incidents WHERE id=$1',[uuid.parse(req.params.id)]);if(!i)throw fail('not_found',404);if(b.stage==='final'&&!i.early_sent_at)throw fail('early_report_required',409);const field={early:'early_sent_at',update:'update_sent_at',final:'final_sent_at',resolved:'resolved_at'}[b.stage];await db.query(`UPDATE gen_auditor.incidents SET ${field}=$2 WHERE id=$1`,[i.id,b.at]);await audit(db,'incident.stage_recorded',i.id,{stage:b.stage,receipt_sha256:b.receipt_sha256});return {id:i.id,notice:'Registro manual de evidencia. No se realizó un envío a ANCI.'};});
 endpoint('get','/audit',async({db})=>({integrity:(await rows(db,'SELECT gen_auditor.verify_audit() AS valid'))[0].valid,events:await rows(db,'SELECT seq,action,entity_id,occurred_at,previous_hash,entry_hash FROM gen_auditor.audit_logs ORDER BY seq DESC LIMIT 100')}));
 endpoint('post','/reports',async({db,tenant,actor,req})=>{allow(db,['owner','security']);if(!config.reportPrivateKey)throw fail('report_signing_key_required',503);const b=z.object({client_id:uuid}).strict().parse(req.body);const [client]=await rows(db,'SELECT * FROM gen_auditor.clients WHERE id=$1',[b.client_id]);if(!client)throw fail('not_found',404);const domains=await rows(db,'SELECT * FROM gen_auditor.domains WHERE client_id=$1',[client.id]);const findings=await rows(db,"SELECT v.* FROM gen_auditor.vulnerabilities v JOIN gen_auditor.scans s ON s.id=v.scan_id JOIN gen_auditor.domains d ON d.id=s.domain_id WHERE d.client_id=$1 AND v.status IN ('open','in_progress')",[client.id]);const integrity=(await rows(db,'SELECT gen_auditor.verify_audit() AS valid'))[0].valid;
  const r=await securityReport({client,domains,findings,integrity,privateKey:config.reportPrivateKey,keyId:config.reportKeyId});await db.query('INSERT INTO gen_auditor.reports(id,tenant_id,client_id,report_code,pdf,manifest,signature,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,tenant,client.id,r.code,r.pdf,JSON.stringify(r.manifest),r.signature,actor]);await audit(db,'report.generated',r.id,{pdf_sha256:r.manifest.sha256});return {id:r.id,code:r.code};});
 endpoint('get','/reports/:id/pdf',async({db,req})=>{const [r]=await rows(db,'SELECT pdf FROM gen_auditor.reports WHERE id=$1',[uuid.parse(req.params.id)]);if(!r)throw fail('not_found',404);return r;});
 endpoint('get','/reports/:id/manifest',async({db,req})=>{const [r]=await rows(db,'SELECT manifest,signature FROM gen_auditor.reports WHERE id=$1',[uuid.parse(req.params.id)]);if(!r)throw fail('not_found',404);return r;});
 // Receptor del puente ARCOP. Vive fuera de /api/v1 a propósito: no hay
 // sesión ni CORS; la autenticidad la porta la firma Ed25519 del cuerpo.
 app.all('/internal/arcop/events',express.json({limit:'256kb',verify:(r,_res,buf)=>{r.rawBody=buf;}}),
  bridgeRouter({pool,keys:bridgeKeys(config.env||process.env)}));

 app.use('/api',(_req,_res,next)=>next(fail('not_found',404)));
 const dist=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');app.use(express.static(dist,{index:false}));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
 app.use((err,req,res,_next)=>{const id=randomUUID();let status=err.status||500,code=err.message;
  if(err instanceof z.ZodError){status=422;code='invalid_input';}else if(['23505','23503','23514','42501'].includes(err.code)){status=409;code='conflict_or_forbidden';}
  if(status>=500){code='internal_error';console.error(JSON.stringify({request_id:id,error_code:err.code||'unknown'}));}
  res.status(status).json({error:code,request_id:id});
 });return app;
}
