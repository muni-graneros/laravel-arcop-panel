import test from 'node:test';import assert from 'node:assert/strict';import { generateKeyPairSync } from 'node:crypto';
import { normalizeDomain,isPublicIP,dueAt,incidentDeadlines,compliance,encrypt,decrypt,subjectRef,evaluateHeaders } from '../server/domain.js';
import { resolvePublic,activePlan,passiveScan } from '../server/scanner.js';import { securityReport,verifyReport } from '../server/report.js';
test('normalization refuses URL tricks and internal names',()=>{assert.equal(normalizeDomain('EXAMPLE.ORG.'),'example.org');for(const s of ['https://example.org','127.0.0.1','[::1]','example.org@127.0.0.1','foo.local','a/b.org','a\\b.org'])assert.throws(()=>normalizeDomain(s));});
test('SSRF blocks loopback, mapped IPv4, metadata, private and rebinding mixed results',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','192.0.2.1'])assert.equal(isPublicIP(ip),false,ip);
 assert.equal(isPublicIP('8.8.8.8'),true);await assert.rejects(resolvePublic('example.org',async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]),/non_public_target/);
 let requested=false;await assert.rejects(passiveScan('example.org',{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{requested=true;}}));assert.equal(requested,false);
});
test('active scan requires fresh verification, exact domain and approved public IPs',()=>{
 const now=new Date(),domain={id:'domain',verified_at:now.toISOString()},authorization={domain_id:'domain',starts_at:new Date(now-1000),expires_at:new Date(+now+3600000),allowed_tools:['nmap'],approved_ips:['8.8.8.8']};
 const p=activePlan({domain,authorization,tool:'nmap',ips:['8.8.8.8'],now});assert.equal(p.shell,false);assert.deepEqual(p.args.slice(-1),['8.8.8.8']);
 for(const patch of [{authorization:null},{ips:['1.1.1.1']},{tool:'nuclei'},{domain:{...domain,verified_at:'2020-01-01'}}])assert.throws(()=>activePlan({domain,authorization,tool:'nmap',ips:['8.8.8.8'],now,...patch}));
});
test('business deadlines are contextual and never a universal 48 hour incident timer',()=>{
 const known_at='2026-10-16T12:00:00Z';assert.equal(dueAt('critical',known_at),'2026-10-18T12:00:00.000Z');
 assert.equal(incidentDeadlines({known_at,obligated:true,oiv:true,essential_affected:true}).update,'2026-10-17T12:00:00.000Z');
 assert.equal(incidentDeadlines({known_at,obligated:true}).final,null);assert.equal(incidentDeadlines({known_at,obligated:false}).early,null);
 assert.equal(compliance([]).percent,null);assert.equal(compliance([{status:'verified'},{status:'pending'},{status:'not_applicable'}]).percent,50);
});
test('PII cipher is authenticated and tenant bound; subject lookup is keyed',()=>{
 const key='ab'.repeat(32),value=encrypt('12345678-9','tenant-a',key);assert.equal(decrypt(value,'tenant-a',key),'12345678-9');assert.throws(()=>decrypt(value,'tenant-b',key));assert.notEqual(subjectRef('a','123',key),subjectRef('b','123',key));
});
test('headers are a partial posture index, not proof of complete security',()=>{assert.equal(evaluateHeaders({}).score,40);assert.match(evaluateHeaders({}).limitations,/no score integral/);});
test('PDF hash and Ed25519 manifest verify; modified PDF fails',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');const result=await securityReport({client:{id:'client',tenant_id:'tenant',name:'Example'},domains:[],findings:[],integrity:true,privateKey});
 assert.equal(result.pdf.subarray(0,4).toString(),'%PDF');assert(verifyReport(result.pdf,result.manifest,result.signature,publicKey));assert(!verifyReport(Buffer.concat([result.pdf,Buffer.from('altered')]),result.manifest,result.signature,publicKey));
});
