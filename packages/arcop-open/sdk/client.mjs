export class ArcopClient {
 constructor({baseUrl,token,tenant,fetchImpl=fetch}){const u=new URL(baseUrl);if(u.protocol!=='https:'||u.username||u.password)throw new Error('HTTPS endpoint without credentials required');this.baseUrl=u.href.replace(/\/$/,'');this.token=token;this.tenant=tenant;this.fetch=fetchImpl;}
 // Lista blanca de recursos. El SDK no es un proxy HTTP genérico: una ruta
 // fuera de este patrón es un error de programación, no una petición.
 static routes(){
  return [
   /^\/requests$/, /^\/requests\/[a-f0-9-]+\/events$/, /^\/requests\/[a-f0-9-]+\/transitions$/,
   /^\/consents$/, /^\/consents\/[a-f0-9-]+\/withdraw$/, /^\/consents\/[a-f0-9-]+\/restrict$/,
   /^\/consents\/[a-f0-9-]+\/chain$/, /^\/consents\/[a-f0-9-]+\/texts$/,
  ];
 }
 async request(path,{method='GET',body,idempotencyKey}={}){
  if(!ArcopClient.routes().some(r=>r.test(path)))throw new Error('Unsupported resource');
  const r=await this.fetch(this.baseUrl+'/v1'+path,{method,redirect:'error',headers:{Authorization:'Bearer '+this.token,'X-Tenant-ID':this.tenant,...(body?{'Content-Type':'application/json'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw new Error('ARCOP request failed: '+r.status);return r.json();
 }
 // ── Expedientes ARCO ───────────────────────────────────────────────────────
 listRequests(){return this.request('/requests');}
 createRequest(body,idempotencyKey){return this.request('/requests',{method:'POST',body,idempotencyKey});}
 requestEvents(id){return this.request(`/requests/${id}/events`);}
 transition(id,body){return this.request(`/requests/${id}/transitions`,{method:'POST',body});}
 // ── Consentimientos ────────────────────────────────────────────────────────
 // capture_method DEBE declararse: con 'operator_entered' ARCOP no atribuye
 // la IP ni el agente al titular, sino al contexto de captura.
 listConsents(){return this.request('/consents');}
 registerConsent(body,idempotencyKey){return this.request('/consents',{method:'POST',body,idempotencyKey});}
 withdrawConsent(id,reason){return this.request(`/consents/${id}/withdraw`,{method:'POST',body:{reason}});}
 restrictConsent(id,reason){return this.request(`/consents/${id}/restrict`,{method:'POST',body:{reason}});}
 consentChain(id){return this.request(`/consents/${id}/chain`);}
 publishConsentText(definitionId,version,legalText){return this.request(`/consents/${definitionId}/texts`,{method:'POST',body:{version,legal_text:legalText}});}
}
export function connectArcopFrame(iframe,{serviceOrigin,tenant,getToken}){
 const origin=new URL(serviceOrigin).origin;
 const listener=async e=>{if(e.source!==iframe.contentWindow||e.origin!==origin||e.data?.type!=='arcop.ready')return;iframe.contentWindow.postMessage({type:'arcop.session',tenant,token:await getToken()},origin);};
 window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);
}