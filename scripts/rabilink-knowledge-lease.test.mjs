import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { authorizeKnowledgeRequest } from './rabilink-knowledge-grant.mjs';
const source=fs.readFileSync(new URL('./rabilink-relay-server.mjs',import.meta.url),'utf8');
const start=source.indexOf('function claimWebguiRequests('),end=source.indexOf('\nfunction finishWebguiWaiters(',start);
function fixture(request,apps=[]){let finished=0;const context=vm.createContext({Buffer,authorizeKnowledgeRequest,Date:{now:()=>6000},webguiRequests:new Map([['request',request]]),cleanupWebguiRequests(){},canWorkerClaimWebguiRequest:()=>true,finishWebguiWaiters(){finished++;},webguiRequestForResponse:r=>r,scheduleLeaseAvailability(){},writeEvent(){},writeAccountLogForApp(){},readAppStore:()=>({apps}),leaseMs:5000});vm.runInContext(source.slice(start,end)+';globalThis.claim=claimWebguiRequests;',context);return {claim:()=>context.claim(1,'pc','app','guid'),finished:()=>finished};}
test('expired state-changing lease fails uncertain without execution',()=>{const r={status:'leased',leaseUntil:5000,nonReplayable:true};const f=fixture(r);assert.equal(f.claim().length,0);assert.equal(r.status,'failed');assert.equal(r.error,'KNOWLEDGE_OUTCOME_UNCERTAIN');assert.equal(f.finished(),1);assert.equal(f.claim().length,0);});
test('revoked role, changed target and rebound credential prevent read re-claim',()=>{
 const grant={allowedRoles:['example'],allowedTools:['plan_list'],allowWrites:false};
 for(const change of ['role','target','credential']){
  const binding={id:'glass',credentialHash:change==='credential'?'new':'old',knowledgeGrantState:{revision:2,grant:{...grant,allowedRoles:change==='role'?[]:['example']},operations:[]}};
  const app={id:'app',ownerAccountId:'owner',targetDeviceId:change==='target'?'other':'pc',deviceBindings:[binding]};
  const r={status:'leased',leaseUntil:5000,attempts:1,appId:'app',targetDeviceId:'pc',knowledgeCredentialHash:'old',knowledge:{deviceBindingId:'glass',ownerAccountId:'owner',grant},bodyBase64:Buffer.from(JSON.stringify({operation:'call',name:'plan_list',args:{roleId:'example'}})).toString('base64')};
  const f=fixture(r,[app]);assert.equal(f.claim().length,0);assert.equal(r.error,'KNOWLEDGE_GRANT_REVOKED');assert.equal(f.finished(),1);
 }
});
test('ordinary read lease may be reclaimed',()=>{const r={status:'leased',leaseUntil:5000,attempts:1};const f=fixture(r);assert.equal(f.claim().length,1);assert.equal(r.attempts,2);});
