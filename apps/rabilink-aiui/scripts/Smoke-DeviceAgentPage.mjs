import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=(await fs.readFile(new URL('../utils/device-agent-page.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export const deviceAgentPageMethods','const deviceAgentPageMethods')+'\nglobalThis.methods=deviceAgentPageMethods;';
function fixture() {
  const storage=new Map(),calls=[];let invoke=async()=>({});
  const context=vm.createContext({wx:{getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,structuredClone(value))},tokenStorageKey:()=> 'credential-hash',usesRemoteAgent:()=>false,Date,Math,Promise,setTimeout:()=>1,clearTimeout:()=>{},getDeviceAgentContext:async()=>({agentId:'glasses',targetDeviceId:'pc-owner'}),requestDeviceAgent:async(_config,owner,path,options={})=>{calls.push({owner,path,options:structuredClone(options)});return invoke(path,options);}});
  vm.runInContext(source,context);
  const page={...context.methods,pageVisible:true,data:{},setData(value){Object.assign(this.data,value)},deviceAgentProfileConfig:()=>({token:'synthetic',targetDeviceId:'pc-persona'}),ensureChatModel:async()=>({}),runDeviceAgentMailbox:context.methods.runDeviceAgentMailbox};
  const state={config:{},context:{agentId:'glasses',targetDeviceId:'pc-owner'},scope:'scope',sessionId:'native-session',ownerEpoch:'owner-epoch'};
  return {page,state,calls,storage,handler(value){invoke=value;}};
}
test('registration requires the real native model and advertises only available host capabilities',async()=>{
  const f=fixture();f.page.ensureChatModel=async()=>null;await f.page.startDeviceAgentOwner();assert.equal(f.calls.length,0);
  f.page.ensureChatModel=async()=>({});f.page.runDeviceAgentMailbox=async()=>{};f.page.asrAdapter={getCapability:()=>({available:true})};
  f.handler(async()=>({session:{ownerEpoch:'actual-server-epoch'}}));await f.page.startDeviceAgentOwner();
  assert.equal(f.calls[0].owner.targetDeviceId,'pc-owner');assert.deepEqual(f.calls[0].options.body.capabilities,['language-model','asr']);assert.equal(f.page.deviceAgentOwner.ownerEpoch,'actual-server-epoch');
  f.page.stopDeviceAgentOwner();assert.equal(f.calls.at(-1).options.body.loaded,false);
});
test('original Route prompt executes through the existing eye loop and returns its original receipt',async()=>{
  const f=fixture();f.page.deviceAgentOwner=f.state;let turns=0;
  f.page.executeLingzhuAgentPrompt=async(prompt,options)=>{turns++;assert.equal(prompt,'original prompt');assert.equal(options.deviceContext.targetDeviceId,'pc-owner');assert.equal(options.deviceContext.sessionId,'native-session');return {state:'completed',text:'actual native result'};};
  f.handler(async(path,options)=>{if(path.startsWith('/pending'))return {pending:true};if(path==='/deliveries/claim')return {delivery:{deliveryId:'original-delivery',prompt:'original prompt',claimToken:'server-claim'}};f.page.pageVisible=false;assert.equal(options.body.text,'actual native result');assert.equal(options.body.claimToken,'server-claim');return {receipt:{deliveryId:'original-delivery',status:'completed'}};});
  await f.page.runDeviceAgentMailbox(f.state);assert.equal(turns,1);assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|original-delivery'].state,'settled');
  f.page.pageVisible=true;await f.page.runDeviceAgentMailbox(f.state);assert.equal(turns,1);assert.match(f.page.data.deviceAgentProfileStatus,/已有执行记录/);
});
test('reopening the same native session preserves its registered epoch for queued formal requests',async()=>{
  const f=fixture();f.page.runDeviceAgentMailbox=async()=>{};f.handler(async()=>({session:{ownerEpoch:'server-epoch'}}));
  await f.page.startDeviceAgentOwner();const original=f.calls[0].options.body.sessionId;
  f.page.stopDeviceAgentOwner();await f.page.startDeviceAgentOwner();
  const registration=f.calls.filter(call=>call.options.body?.loaded===true).at(-1);
  assert.equal(registration.options.body.sessionId,original);assert.equal(registration.options.body.ownerEpoch,'server-epoch');
});
test('a peer ledger target guides only formal reply while persona and physical device owners remain distinct',async()=>{
  const f=fixture();f.state.config={targetDeviceId:'pc-persona-b'};
  const context=f.page.deviceAgentTurnContext(f.state,{ledgerOwnerDeviceId:'pc-ledger-c'});
  assert.equal(context.targetDeviceId,'pc-ledger-c');assert.equal(context.ownerDeviceId,'pc-owner');
  assert.equal(f.state.config.targetDeviceId,'pc-persona-b');assert.equal(f.state.context.targetDeviceId,'pc-owner');
});

test('native session and execution caches stay within the normalized Relay connection scope',async()=>{
  const f=fixture();f.page.runDeviceAgentMailbox=async()=>{};let config={token:'synthetic',relayBaseUrl:' https://relay-a.invalid/// ',targetDeviceId:'pc-persona'};
  f.page.deviceAgentProfileConfig=()=>config;f.handler(async()=>({session:{ownerEpoch:'server-epoch'}}));
  await f.page.startDeviceAgentOwner();const original=f.page.deviceAgentOwner;
  f.page.stopDeviceAgentOwner();config={...config,relayBaseUrl:'https://relay-a.invalid'};await f.page.startDeviceAgentOwner();
  assert.equal(f.page.deviceAgentOwner.scope,original.scope);assert.equal(f.page.deviceAgentOwner.sessionId,original.sessionId);
  f.page.stopDeviceAgentOwner();config={...config,relayBaseUrl:'https://relay-b.invalid'};await f.page.startDeviceAgentOwner();
  assert.notEqual(f.page.deviceAgentOwner.scope,original.scope);assert.notEqual(f.page.deviceAgentOwner.sessionId,original.sessionId);
  assert.equal(f.calls.filter(call=>call.options.body?.loaded===true).at(-1).options.body.ownerEpoch,'');
  assert.equal(Object.keys(f.storage.get('rabilink-aiui-device-agent-v1').sessions).length,2);
});
test('voice steering completes before mailbox claim; response uncertainty retains the original execution without replay',async()=>{
  const f=fixture();f.page.deviceAgentOwner=f.state;f.page.deviceAgentTurnActive=true;let turns=0;
  f.page.executeLingzhuAgentPrompt=async()=>{turns++;return {state:'completed',text:'original result'};};
  f.handler(async path=>path.startsWith('/pending')?{pending:true}:path==='/deliveries/claim'?{delivery:{deliveryId:'unknown',prompt:'prompt',claimToken:'claim'}}:Promise.reject(Error('lost response')));
  const work=f.page.runDeviceAgentMailbox(f.state);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  f.page.resumeDeviceAgentClaim();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  f.page.deviceAgentTurnActive=false;f.page.resumeDeviceAgentClaim();await work;assert.equal(turns,1);assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|unknown'].state,'response-pending');
  await f.page.runDeviceAgentMailbox(f.state);assert.equal(turns,1);
});
