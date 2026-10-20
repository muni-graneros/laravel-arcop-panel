export const RIGHTS=['access','rectification','erasure','opposition','portability'];
export function transition(request,action,actor,input,{policyReviewed=false}={}) {
 const fail=code=>{throw Object.assign(new Error(code),{status:409});};
 if(!actor?.active)fail('inactive_actor');
 const resolver=['resolver','admin'].includes(actor.role),receiver=['receiver','admin'].includes(actor.role);
 const evidence=()=>{if(!/^[a-f0-9]{64}$/.test(input.evidence_sha256||''))fail('evidence_required');};
 if(action==='verify_identity'){
  if(!receiver||request.status!=='identity_pending')fail('transition_forbidden');evidence();return {status:'in_review'};
 }
 if(action==='approve'||action==='reject'){
  if(!resolver||request.status!=='in_review')fail('transition_forbidden');
  if(request.created_by===actor.sub)fail('segregation_required');
  if(!policyReviewed)fail('legal_policy_not_reviewed');
  if(typeof input.legal_basis!=='string'||input.legal_basis.length<10||typeof input.reason!=='string'||input.reason.length<10)fail('reason_and_legal_basis_required');
  evidence();return {status:action==='approve'?'action_pending':'rejected'};
 }
 if(action==='complete'){
  if(!resolver||request.status!=='action_pending')fail('transition_forbidden');evidence();
  if(typeof input.receipt_ref!=='string'||input.receipt_ref.length<5)fail('host_execution_receipt_required');
  return {status:'completed'};
 }
 fail('unknown_transition');
}
