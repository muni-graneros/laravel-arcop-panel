// Optional one-tenant worker. No Docker socket, shell, NSE or user-provided flags.
import {promisify} from 'node:util';import {execFile} from 'node:child_process';import {makePool,context,audit} from './db.js';import {resolvePublic,activePlan} from './scanner.js';import {sha256} from './domain.js';import {z} from 'zod';
const run=promisify(execFile);
if(process.env.ACTIVE_SCANNER_ENABLED!=='true')throw new Error('Active runner disabled');
const tenant=z.uuid().parse(process.env.SCANNER_TENANT_ID),actor=z.uuid().parse(process.env.SCANNER_ACTOR_ID),pool=makePool();
const {rows}=await pool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');if(rows[0]?.current_user!=='gen_auditor_scanner'||rows[0]?.rolsuper||rows[0]?.rolbypassrls)throw new Error('Dedicated scanner role required');
async function tick(){const job=await context(pool,actor,tenant,async db=>{const {rows}=await db.query("SELECT * FROM gen_auditor.scans WHERE kind='active' AND status='queued' ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1");if(!rows.length)return null;await db.query("UPDATE gen_auditor.scans SET status='running' WHERE id=$1",[rows[0].id]);return rows[0];});if(!job)return false;
 try{
  const scope=await context(pool,actor,tenant,async db=>{const domain=(await db.query('SELECT * FROM gen_auditor.domains WHERE id=$1',[job.domain_id])).rows[0];const authorization=(await db.query('SELECT * FROM gen_auditor.scan_authorizations WHERE id=$1',[job.authorization_id])).rows[0];return {domain,authorization};});
  const records=await resolvePublic(scope.domain.hostname);if(records.length>4)throw new Error('too_many_targets');const outputs=[];
  for(const {address} of records){scope.authorization=await context(pool,actor,tenant,async db=>(await db.query('SELECT * FROM gen_auditor.scan_authorizations WHERE id=$1',[job.authorization_id])).rows[0]);const p=activePlan({...scope,tool:'nmap',ips:[address]});const {stdout}=await run(p.binary,p.args,{shell:false,timeout:p.timeout,maxBuffer:p.maxBuffer,env:{PATH:'/usr/bin:/bin',HOME:'/tmp'},killSignal:'SIGKILL'});outputs.push({ip:address,sha256:sha256(stdout),output:stdout.slice(0,64000)});}
  await context(pool,actor,tenant,async db=>{await db.query("UPDATE gen_auditor.scans SET status='completed',finished_at=now(),evidence=$2 WHERE id=$1 AND status='running'",[job.id,JSON.stringify({tool:'nmap',scope:'TCP connect 80/443 only; inventory, not a complete pentest',outputs})]);await audit(db,'scan.active_completed',job.id,{tool:'nmap',targets:records.length});});
 }catch{await context(pool,actor,tenant,async db=>{await db.query("UPDATE gen_auditor.scans SET status='failed',finished_at=now(),error_code='active_scope_or_execution_failed' WHERE id=$1",[job.id]);await audit(db,'scan.active_failed',job.id);});}return true;}
let stopping=false;for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopping=true;});
while(!stopping){await tick();await new Promise(r=>setTimeout(r,2000));}await pool.end();
