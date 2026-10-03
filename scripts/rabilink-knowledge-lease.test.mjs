import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { authorizeKnowledgeRequest } from './rabilink-knowledge-access.mjs';
const source=fs.readFileSync(new URL('./rabilink-relay-server.mjs',import.meta.url),'utf8');
const start=source.indexOf('function claimWebguiRequests('),end=source.indexOf('\nfunction finishWebguiWaiters(',start);
function fixture(request,apps=[]){let finished=0;const context=vm.createContext({Buffer,JSON,authorizeKnowledgeRequest,Date:{now:()=>6000},webguiRequests:new Map([['request',request]]),cleanupWebguiRequests(){},canWorkerClaimWebguiRequest:()=>true,finishWebguiWaiters(){finished++;},webguiRequestForResponse:r=>r,scheduleLeaseAvailability(){},writeEvent(){},writeAccountLogForApp(){},readAppStore:()=>({apps}),leaseMs:5000});vm.runInContext(source.slice(start,end)+';globalThis.claim=claimWebguiRequests;',context);return {claim:()=>context.claim(1,'pc','app','guid'),finished:()=>finished};}
test('expired state-changing lease fails uncertain without execution',()=>{const r={status:'leased',leaseUntil:5000,nonReplayable:true};const f=fixture(r);assert.equal(f.claim().length,0);assert.equal(r.status,'failed');assert.equal(r.error,'KNOWLEDGE_OUTCOME_UNCERTAIN');assert.equal(f.finished(),1);assert.equal(f.claim().length,0);});
test('changed owner, target, disabled membership and rebound credential prevent read re-claim',()=>{
 for(const change of ['owner','target','credential','binding-disabled','app-disabled','metadata-app','metadata-target']){
  const binding={id:'glass',credentialHash:change==='credential'?'new':'old',enabled:change!=='binding-disabled'};
  const app={id:'app',ownerAccountId:change==='owner'?'other':'owner',targetDeviceId:change==='target'?'other':'pc',enabled:change!=='app-disabled',deviceBindings:[binding]};
  const r={status:'leased',leaseUntil:5000,attempts:1,appId:'app',targetDeviceId:'pc',knowledgeCredentialHash:'old',knowledge:{appId:change==='metadata-app'?'other':'app',targetDeviceId:change==='metadata-target'?'other':'pc',deviceBindingId:'glass',ownerAccountId:'owner'},bodyBase64:Buffer.from(JSON.stringify({operation:'call',name:'plan_list',args:{roleId:'example'}})).toString('base64')};
  const f=fixture(r,[app]);assert.equal(f.claim().length,0);assert.equal(r.error,'KNOWLEDGE_ACCESS_REVOKED');assert.equal(f.finished(),1);
 }
});
test('current application membership reclaims reads without old role, tool or write grants',()=>{
 const binding={id:'glass',credentialHash:'old',knowledgeGrantState:{grant:{allowedRoles:[],allowedTools:[],allowWrites:false}}};
 const app={id:'app',ownerAccountId:'owner',targetDeviceId:'pc',deviceBindings:[binding]};
 const r={status:'leased',leaseUntil:5000,attempts:1,appId:'app',targetDeviceId:'pc',knowledgeCredentialHash:'old',knowledge:{appId:'app',targetDeviceId:'pc',deviceBindingId:'glass',ownerAccountId:'owner',grant:{allowedRoles:[]}},bodyBase64:Buffer.from(JSON.stringify({operation:'call',name:'plan_list',args:{roleId:'example'}})).toString('base64')};
 const f=fixture(r,[app]);assert.equal(f.claim().length,1);assert.equal(r.attempts,2);assert.equal('grant' in r.knowledge,false);assert.equal(f.finished(),0);
});
test('ordinary read lease may be reclaimed',()=>{const r={status:'leased',leaseUntil:5000,attempts:1};const f=fixture(r);assert.equal(f.claim().length,1);assert.equal(r.attempts,2);});
