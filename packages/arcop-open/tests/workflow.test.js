import test from 'node:test';import assert from 'node:assert/strict';import {transition} from '../src/workflow.js';import {ArcopClient} from '../sdk/client.mjs';
const evidence_sha256='a'.repeat(64),receiver={sub:'receiver',role:'receiver',active:true},resolver={sub:'resolver',role:'resolver',active:true};
test('identity, legal review, segregation and host execution are separate gates',()=>{
 const initial={created_by:'receiver',status:'identity_pending'};assert.equal(transition(initial,'verify_identity',receiver,{evidence_sha256}).status,'in_review');
 const reviewed={...initial,status:'in_review'},decision={evidence_sha256,reason:'A sufficiently detailed reason',legal_basis:'A reviewed legal basis'};
 assert.throws(()=>transition(reviewed,'approve',resolver,decision),/legal_policy_not_reviewed/);
 assert.throws(()=>transition(reviewed,'approve',{...resolver,sub:'receiver'},decision,{policyReviewed:true}),/segregation_required/);
 assert.equal(transition(reviewed,'approve',resolver,decision,{policyReviewed:true}).status,'action_pending');
 assert.throws(()=>transition({...initial,status:'action_pending'},'complete',resolver,{evidence_sha256}),/receipt/);
 assert.equal(transition({...initial,status:'action_pending'},'complete',resolver,{evidence_sha256,receipt_ref:'host-execution-123'}).status,'completed');
});
test('language-independent HTTP client sets auth, tenant and idempotency without redirects',async()=>{
 let captured;const client=new ArcopClient({baseUrl:'https://arcop.example.org',token:'test',tenant:'tenant',fetchImpl:async(...args)=>{captured=args;return {ok:true,json:async()=>({id:'test'})};}});
 await client.request('/requests',{method:'POST',body:{product:'test'},idempotencyKey:'key'});assert.equal(captured[1].headers['Idempotency-Key'],'key');assert.equal(captured[1].redirect,'error');assert.throws(()=>new ArcopClient({baseUrl:'http://example.org',token:'x',tenant:'y'}));
});
