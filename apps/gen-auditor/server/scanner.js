import dns from 'node:dns/promises';
import https from 'node:https';
import { normalizeDomain,isPublicIP,sha256,evaluateHeaders } from './domain.js';
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('dns_timeout')),5000);timer.unref();})]);}finally{clearTimeout(timer);}}
export async function resolvePublic(host,lookup=dns.lookup) {
  const records=await bounded(lookup(normalizeDomain(host),{all:true,verbatim:true}));
  if (!records.length || records.some(r=>!isPublicIP(r.address))) throw new Error('non_public_target');
  return records;
}
export async function verifyDNS(domain,tokenHash,resolveTxt=dns.resolveTxt) {
  const records=await bounded(resolveTxt('_gen-auditor.'+normalizeDomain(domain)));
  return records.some(parts=>sha256(parts.join(''))===tokenHash);
}
export async function passiveScan(host,{lookup=dns.lookup,request=https.request}={}) {
  const hostname=normalizeDomain(host);const records=await resolvePublic(hostname,lookup);
  const pinned=records[0];
  const result=await new Promise((resolve,reject)=>{
    const req=request({hostname,port:443,path:'/',method:'HEAD',servername:hostname,rejectUnauthorized:true,agent:false,
      // Pin the exact public address validated above, retaining hostname verification/SNI.
      lookup:(_name,options,cb)=>options?.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family),
      headers:{'User-Agent':'Gen-Auditor/0.1 authorized posture check'}},res=>{
        if(res.statusCode>=300&&res.statusCode<400){res.destroy();reject(new Error('redirect_requires_review'));return;}
        const headers={};for(const key of ['strict-transport-security','content-security-policy','x-content-type-options','referrer-policy']){
          const val=res.headers[key];if(typeof val==='string')headers[key]=val.slice(0,4096);
        }
        const cert=res.socket.getPeerCertificate?.();res.resume();resolve({status:res.statusCode,headers,tls_valid:true,certificate_expires_at:cert?.valid_to||null});
      });
    const timer=setTimeout(()=>req.destroy(new Error('scan_timeout')),8000);timer.unref();
    req.once('close',()=>clearTimeout(timer));req.once('error',reject);req.end();
  });
  if(result.status<200||result.status>=300)throw new Error('http_status_requires_review');
  return {...result,...evaluateHeaders(result.headers),target_ips:records.map(x=>x.address)};
}
export function activePlan({domain,authorization,tool,ips,now=new Date()}) {
  if(!domain.verified_at||new Date(domain.verified_at)<new Date(now.getTime()-86400000))throw new Error('verification_stale');
  if(!authorization||authorization.revoked_at||new Date(authorization.starts_at)>now||new Date(authorization.expires_at)<=now)throw new Error('authorization_required');
  if(authorization.domain_id!==domain.id||!authorization.allowed_tools.includes(tool))throw new Error('scope_mismatch');
  if(!ips.length||ips.some(ip=>!isPublicIP(ip)||!authorization.approved_ips.includes(ip)))throw new Error('ip_scope_changed');
  if(tool!=='nmap')throw new Error('tool_not_enabled');
  return {binary:'/usr/bin/nmap',args:[...(ips[0]?.includes(':')?['-6']:[]),'-sT','-Pn','-T2','--max-retries','1','--host-timeout','120s','-p','80,443','--open','-oX','-',...ips],shell:false,timeout:Math.min(130000,new Date(authorization.expires_at).getTime()-now.getTime()),maxBuffer:1024*1024};
}
