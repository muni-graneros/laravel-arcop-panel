import express from 'express';import helmet from 'helmet';import {rateLimit} from 'express-rate-limit';import {z} from 'zod';import {randomUUID} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {RIGHTS,transition} from './workflow.js';import {hash,reference,seal} from './crypto.js';import * as consents from './consents.js';
export function createService({pool,verifyToken,config}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);app.use(helmet({frameguard:false,contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],connectSrc:["'self'"],objectSrc:["'none'"],baseUri:["'none'"],frameAncestors:config.embedOrigins.length?config.embedOrigins:["'none'"]}}}));app.use(express.json({limit:'32kb'}));
 app.get('/health',(_req,res)=>res.json({status:'ok'}));app.get('/panel-config',(_req,res)=>res.json({embedOrigins:config.embedOrigins}));
 app.use('/v1',async(req,_res,next)=>{try{const token=req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];if(!token)throw Object.assign(new Error('unauthenticated'),{status:401});req.actor=await verifyToken(token);z.string().min(1).max(255).parse(req.actor.sub);req.tenant=z.uuid().parse(req.get('x-tenant-id'));if(config.requireMfa&&req.actor.aal!=='aal2')throw Object.assign(new Error('mfa_required'),{status:403});next();}catch(e){next(e.status?e:Object.assign(new Error('invalid_token'),{status:401}));}});
 app.use('/v1',rateLimit({windowMs:60000,limit:60,keyGenerator:req=>req.actor.sub,standardHeaders:'draft-8',legacyHeaders:false}));
 const route=(method,url,handler)=>app[method]('/v1'+url,async(req,res)=>{
  const db=await pool.connect();try{await db.query('BEGIN');await db.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true)",[req.actor.sub,req.tenant]);const {rows}=await db.query('SELECT role,active FROM arcop.members WHERE tenant_id=$1 AND subject=$2 AND active',[req.tenant,req.actor.sub]);if(!rows.length)throw Object.assign(new Error('forbidden'),{status:403});req.actor={...req.actor,...rows[0]};const result=await handler(db,req);await db.query('COMMIT');res.set('Cache-Control','no-store').json(result);}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 });
 route('get','/session',async(_db,req)=>({subject:req.actor.sub,tenant:req.tenant,role:req.actor.role}));
 route('get','/requests',async(db)=>({items:(await db.query('SELECT id,product,subject_ref,right_type,legal_profile,status,created_at,due_at,head_hash FROM arcop.requests ORDER BY created_at DESC LIMIT 100')).rows}));
 route('post','/requests',async(db,req)=>{
  if(!['admin','receiver'].includes(req.actor.role))throw Object.assign(new Error('forbidden'),{status:403});
  const b=z.object({product:z.string().min(2).max(120),identity:z.string().min(3).max(255),right_type:z.enum(RIGHTS),description:z.string().min(10).max(4000),legal_profile:z.string().min(2).max(80).default('review_required')}).strict().parse(req.body),key=z.uuid().parse(req.get('idempotency-key'));
  const ref=reference(req.tenant,b.identity,config.hmacKey),fingerprint=reference(req.tenant,JSON.stringify(b),config.hmacKey);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[req.tenant+':'+key]);
  const existing=await db.query('SELECT id,status,product,subject_ref,right_type,request_fingerprint FROM arcop.requests WHERE tenant_id=$1 AND idempotency_key=$2',[req.tenant,key]);
  if(existing.rows.length){const r=existing.rows[0];if(r.request_fingerprint!==fingerprint)throw Object.assign(new Error('idempotency_conflict'),{status:409});return {id:r.id,status:r.status,replayed:true};}
  const id=randomUUID();await db.query('INSERT INTO arcop.requests(id,tenant_id,product,subject_ref,identity_ciphertext,description_ciphertext,right_type,legal_profile,created_by,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,req.tenant,b.product,ref,seal(b.identity,req.tenant,config.piiKey),seal(b.description,req.tenant,config.piiKey),b.right_type,b.legal_profile,req.actor.sub,key,fingerprint]);await db.query("SELECT arcop.append_event($1,'received',$2)",[id,JSON.stringify({right:b.right_type,identity:'pending'})]);return {id,status:'identity_pending'};
 });
 route('get','/requests/:id/events',async(db,req)=>{const id=z.uuid().parse(req.params.id);const {rows}=await db.query('SELECT seq,action,actor,occurred_at,metadata,previous_hash,event_hash,canonical FROM arcop.events WHERE request_id=$1 ORDER BY seq',[id]);const verified=(await db.query('SELECT arcop.verify_chain($1) AS valid',[id])).rows[0].valid;return {items:rows,integrity:verified};});
 route('post','/requests/:id/transitions',async(db,req)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({action:z.enum(['verify_identity','approve','reject','complete']),evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/),legal_basis:z.string().min(10).max(2000).optional(),reason:z.string().min(10).max(2000).optional(),receipt_ref:z.string().min(5).max(255).optional()}).strict().parse(req.body);
  const {rows}=await db.query('SELECT * FROM arcop.requests WHERE id=$1 FOR UPDATE',[id]);if(!rows.length)throw Object.assign(new Error('not_found'),{status:404});const next=transition(rows[0],b.action,req.actor,b,{policyReviewed:config.policyReviewed&&config.approvedProfiles.includes(rows[0].legal_profile)});
  await db.query('UPDATE arcop.requests SET status=$2 WHERE id=$1',[id,next.status]);const metadata={status:next.status,evidence_sha256:b.evidence_sha256,...(b.reason?{reason_sha256:hash(b.reason),legal_basis_sha256:hash(b.legal_basis)}:{}),...(b.receipt_ref?{receipt_sha256:hash(b.receipt_ref)}:{})};
  // The legal decision document must be retained by the host; only its evidence hash is logged here.
  await db.query('SELECT arcop.append_event($1,$2,$3)',[id,b.action,JSON.stringify(metadata)]);return {id,...next};
 });
 route('get','/consents',async(db,req)=>consents.list(db,req,{limit:req.query.limit,offset:req.query.offset}));
 route('post','/consents',async(db,req)=>{
  if(!['admin','receiver'].includes(req.actor.role))throw Object.assign(new Error('forbidden'),{status:403});
  const key=z.uuid().parse(req.get('idempotency-key'));
  return consents.register(db,req,config,req.body,key);
 });
 route('post','/consents/:id/withdraw',async(db,req)=>{const id=z.uuid().parse(req.params.id);return consents.change(db,id,'withdrawn',req.body);});
 route('post','/consents/:id/restrict',async(db,req)=>{const id=z.uuid().parse(req.params.id);return consents.change(db,id,'restricted',req.body);});
 route('get','/consents/:id/chain',async(db,req)=>consents.chain(db,req,z.uuid().parse(req.params.id)));
 route('post','/consents/:id/texts',async(db,req)=>{
  if(req.actor.role!=='admin')throw Object.assign(new Error('forbidden'),{status:403});
  const id=z.uuid().parse(req.params.id);
  return consents.publishText(db,await consents.resolveDefinition(db,req,id),req.body);
 });
 app.use('/v1',(_req,res)=>res.status(404).json({error:'not_found'}));const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web');app.use(express.static(web));
 app.use((e,_req,res,_next)=>{const sql=e.code==='P0001'?({forbidden:403,not_found:404}[e.message]??409):null;const status=e instanceof z.ZodError?422:e.status||sql||(['23505','23503','42501'].includes(e.code)?409:500);if(status>=500)console.error('arcop_error',e.code||'internal');res.status(status).json({error:status>=500?'internal_error':e instanceof z.ZodError?'invalid_input':e.message});});return app;
}
