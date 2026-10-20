import pg from 'pg';
import { readFileSync } from 'node:fs';
export function makePool(env=process.env) {
  const url=new URL(env.DATABASE_URL);if(url.search)throw new Error('DATABASE_URL must not contain TLS query overrides');
  return new pg.Pool({connectionString:env.DATABASE_URL,max:5,ssl:{rejectUnauthorized:true,ca:readFileSync(env.DATABASE_CA_PATH,'utf8')},
    connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:10000,application_name:'gen-auditor-api'});
}
export async function context(pool,actor,tenant,fn) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');await db.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true),set_config('TimeZone','UTC',true)",[actor,tenant||'']);
    if(tenant){const {rows}=await db.query('SELECT role FROM gen_auditor.tenant_members WHERE tenant_id=$1 AND user_id=$2 AND active',[tenant,actor]);if(!rows.length)throw Object.assign(new Error('tenant_forbidden'),{status:403});db.memberRole=rows[0].role;}
    const result=await fn(db);await db.query('COMMIT');return result;
  } catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
export async function audit(db,action,id=null,metadata={}) {await db.query('SELECT gen_auditor.append_audit($1,$2,$3::jsonb)',[action,id,JSON.stringify(metadata)]);}
