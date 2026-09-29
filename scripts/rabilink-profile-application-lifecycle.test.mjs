import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createAgentProfileService } from './rabilink-agent-profile.mjs';
const pageSource = (await fs.readFile(new URL('../apps/rabilink-aiui/utils/agent-profile-page.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('export const agentProfilePageMethods', 'const agentProfilePageMethods');
function fixture() {
 let store={apps:[{id:'app',ownerAccountId:'owner',deviceBindings:[{id:'device',credentialHash:'fixture'}]}]};
 const service=createAgentProfileService({readStore:()=>store,writeStore:s=>store=s});
 const principal={kind:'device',appId:'app',bindingId:'device',credentialHash:'fixture'};
 const profile={revision:1,id:'assistant',name:'Assistant',systemPrompt:'',skills:[],mcp:[{id:'rabi-knowledge',label:'Knowledge',enabled:true}]};
 service.save({kind:'account',accountId:'owner'},'app','device',{expectedRevision:0,idempotencyKey:'save1',profile});
 const ctx=vm.createContext({validateAgentProfile:p=>p,getDeviceAgentProfile:async()=>service.readOwn(principal),reportDeviceAgentProfileApplied:async(c,b)=>service.acknowledge(principal,JSON.parse(JSON.stringify(b)))});
 vm.runInContext(pageSource+';globalThis.methods=agentProfilePageMethods;',ctx);
 const runtime={},catalog={allowedRoles:['role']};
 const page={...ctx.methods,deviceAgentProfile:profile,deviceAgentProfileScope:'scope',deviceAgentProfileConfig:()=>({}),agentProfileScope:()=> 'scope',currentAgentProfileScope:()=> 'scope',chatModel:{},chatModelDeviceProfile:profile,knowledgeRuntime:runtime,chatModelKnowledgeRuntime:runtime,chatModelKnowledgeScope:'scope',knowledgeScope:'scope',chatModelKnowledgeRole:'role',knowledgeSelectedRole:'role',chatModelKnowledgeCatalog:catalog,knowledgeCatalog:catalog,chatModelReadonlyToolsCount:1,showDeviceAgentProfile:(p,s)=>page.label=s,setData:d=>page.label=d.deviceAgentProfileStatus};
 return {service,principal,profile,page,state:()=>store.apps[0].deviceBindings[0].agentProfileState};
}
test('ready/unavailable/ready keeps a single application receipt and authoritative success',async()=>{
 const f=fixture();
 for(const ready of [true,false,true,true]) { f.page.knowledgeRebuildPending=!ready; await f.page.acknowledgeDeviceAgentProfile(f.profile); assert.equal(f.service.readOwn(f.principal).applied.status,'applied'); if(!ready)assert.match(f.page.label,/当前不可用/); }
 assert.equal(f.state().operations.length,2);
 assert.throws(()=>f.service.acknowledge(f.principal,{idempotencyKey:'downgrade',appliedRevision:1,status:'failed',errorCode:'TOOLS_UNAVAILABLE'}),e=>e.statusCode===409&&e.code==='PROFILE_ALREADY_APPLIED');
});
test('first failure can recover; historical failed key cannot downgrade success',async()=>{
 const f=fixture(); f.page.knowledgeRebuildPending=true;await f.page.acknowledgeDeviceAgentProfile(f.profile);
 assert.equal(f.service.readOwn(f.principal).applied.status,'failed');
 f.page.knowledgeRebuildPending=false;await f.page.acknowledgeDeviceAgentProfile(f.profile);
 assert.equal(f.service.readOwn(f.principal).applied.status,'applied');assert.equal(f.state().operations.length,3);
 assert.throws(()=>f.service.acknowledge(f.principal,{idempotencyKey:'aiui-profile-1-tools-unavailable',appliedRevision:1,status:'failed',errorCode:'TOOLS_UNAVAILABLE'}),e=>e.code==='PROFILE_ALREADY_APPLIED');
});
test('legacy successful receipt with current failure is not accepted as current success',async()=>{
 const f=fixture();await f.page.acknowledgeDeviceAgentProfile(f.profile);
 f.state().applied={appliedRevision:1,status:'failed',errorCode:'TOOLS_UNAVAILABLE'}; // Legacy fixture only, no production migration.
 await f.page.acknowledgeDeviceAgentProfile(f.profile);
 assert.equal(f.page.deviceAgentProfileRemoteApplied.status,'failed');assert.match(f.page.label,/重新保存配置/);assert.equal(f.state().operations.length,2);
});
