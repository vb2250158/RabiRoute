import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiuiAssistantRuntime } from '../../../packages/assistant-runtime/src/aiui-runtime.js';
const source=(await fs.readFile(new URL('../utils/device-agent-page.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export const deviceAgentPageMethods','const deviceAgentPageMethods')+'\nglobalThis.methods=deviceAgentPageMethods;';
function fixture() {
  const storage=new Map(),calls=[],timers=new Map();let invoke=async()=>({}),timerId=0,readContext=async()=>({agentId:'glasses',targetDeviceId:'pc-owner'});
  const context=vm.createContext({wx:{getStorageSync:key=>structuredClone(storage.get(key)),setStorageSync:(key,value)=>storage.set(key,structuredClone(value))},tokenStorageKey:()=> 'credential-hash',usesRemoteAgent:()=>false,Date,Math,Promise,setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),getDeviceAgentContext:(...args)=>readContext(...args),requestDeviceAgent:async(_config,owner,path,options={})=>{calls.push({owner,path,options:structuredClone(options)});return invoke(path,options);}});
  vm.runInContext(source,context);
  const page={...context.methods,pageVisible:true,data:{},setData(value){Object.assign(this.data,value)},deviceAgentProfileConfig:()=>({token:'synthetic',targetDeviceId:'pc-persona'}),ensureChatModel:async()=>({}),runDeviceAgentMailbox:context.methods.runDeviceAgentMailbox};
  const state={config:{},context:{agentId:'glasses',targetDeviceId:'pc-owner'},scope:'scope',sessionId:'native-session',ownerEpoch:'owner-epoch'};
  return {page,state,calls,storage,timers,handler(value){invoke=value;},contextHandler(value){readContext=value;},fireLease(){const id=page.deviceAgentLeaseTimer;const timer=timers.get(id);assert.equal(timer.delay,15000);timers.delete(id);return timer.fn();}};
}

test('lease renews the current shared assistant and retires only when that assistant is unready',async()=>{
  const f=fixture();let ready=true;
  f.page.runDeviceAgentMailbox=async()=>{};
  f.page.chatAssistant={getState:()=>({ready})};
  f.page.deviceAgentOwner=f.state;
  f.handler(async()=>({session:{sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,loaded:true}}));
  f.page.scheduleDeviceAgentLease();
  await f.fireLease();
  assert.equal(f.calls[0].options.body.loaded,true);
  assert.equal(f.page.deviceAgentOwner,f.state);
  assert.equal(f.timers.size,1);
  ready=false;
  await f.fireLease();
  assert.equal(f.calls.at(-1).options.body.loaded,false);
  assert.equal(f.page.deviceAgentOwner,null);
  assert.equal(f.timers.size,0);
});

test('late lease success or failure cannot stop or reschedule a replacement owner',async()=>{
  for(const fail of [false,true]) {
    const f=fixture();let settle;
    f.page.runDeviceAgentMailbox=async()=>{};
    f.page.chatAssistant={getState:()=>({ready:true})};f.page.deviceAgentOwner=f.state;
    f.handler(()=>new Promise((resolve,reject)=>{settle=()=>fail?reject(Error('old lease failed')):resolve({});}));
    f.page.scheduleDeviceAgentLease();const old=f.fireLease();
    const replacement={...f.state,sessionId:'new-session',generation:2};f.page.deviceAgentOwner=replacement;
    f.page.scheduleDeviceAgentLease();const timer=f.page.deviceAgentLeaseTimer;
    settle();await old;
    assert.equal(f.page.deviceAgentOwner,replacement);
    assert.equal(f.page.deviceAgentLeaseTimer,timer);
    assert.equal(f.calls.length,1);
    assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
  }
});
test('superseded lease callbacks and pending renewals leave the newer timer intact',async()=>{
  const f=fixture();let settle;
  f.page.runDeviceAgentMailbox=async()=>{};
  f.page.chatAssistant={getState:()=>({ready:true})};f.page.deviceAgentOwner=f.state;
  f.page.scheduleDeviceAgentLease();const obsolete=f.timers.get(f.page.deviceAgentLeaseTimer).fn;
  f.page.scheduleDeviceAgentLease();const replacement=f.page.deviceAgentLeaseTimer;
  await obsolete();assert.equal(f.calls.length,0);assert.equal(f.page.deviceAgentLeaseTimer,replacement);
  f.handler(()=>new Promise((resolve,reject)=>{settle=()=>reject(Error('obsolete renewal'));}));
  const old=f.fireLease();f.page.scheduleDeviceAgentLease();const newest=f.page.deviceAgentLeaseTimer;
  settle();await old;
  assert.equal(f.page.deviceAgentOwner,f.state);assert.equal(f.page.deviceAgentLeaseTimer,newest);
  assert.equal(f.calls.length,1);assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
});

test('current lease failure unregisters once, while hidden completion does not change presentation',async()=>{
  for(const hidden of [false,true]) {
    const f=fixture();let rejectLease;
    f.page.runDeviceAgentMailbox=async()=>{};
    f.page.chatAssistant={getState:()=>({ready:true})};f.page.deviceAgentOwner=f.state;
    f.handler((_path,options)=>options.body.loaded?new Promise((_resolve,reject)=>{rejectLease=reject;}):Promise.resolve({}));
    f.page.scheduleDeviceAgentLease();const lease=f.fireLease();
    if(hidden) {f.page.pageVisible=false;f.page.stopDeviceAgentOwner();}
    rejectLease(Error('connection failed'));await lease;
    assert.equal(f.page.deviceAgentOwner,null);assert.equal(f.timers.size,0);
    assert.equal(f.calls.filter(call=>call.options.body.loaded===false).length,1);
    if(hidden)assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
    else assert.match(f.page.data.deviceAgentProfileStatus,/连接未确认/);
  }
});

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
  f.handler(async(path,options)=>{if(path.startsWith('/pending'))return {pending:true};if(path==='/deliveries/claim')return {delivery:{deliveryId:'original-delivery',prompt:'original prompt',claimToken:'server-claim'}};f.page.pageVisible=false;assert.equal(options.body.text,'actual native result');assert.equal(options.body.claimToken,'server-claim');return {receipt:{deliveryId:'original-delivery',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed'}};});
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

test('mailbox waits for current speech and its final transcript before claiming a delivery',async()=>{
  const f=fixture();f.page.deviceAgentOwner=f.state;let turns=0;
  const runtime=createAiuiAssistantRuntime({asr:{createRound:handlers=>({handlers}),start(){},stop(){}},
    tts:{synthesize:async()=>({task:{},player:{}})},onInputStateChange:()=>f.page.resumeDeviceAgentClaim()});
  f.page.aiuiRuntime=runtime;
  const round=runtime.asr.createRound({onFinal:()=>{f.page.deviceAgentTurnActive=true;}});
  f.handler(async(path)=>{
    if(path.startsWith('/pending'))return {pending:true};
    if(path==='/deliveries/claim')return {delivery:{deliveryId:'after-speech',prompt:'background',claimToken:'claim'}};
    f.page.pageVisible=false;return {receipt:{deliveryId:'after-speech',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed'}};
  });
  f.page.executeLingzhuAgentPrompt=async()=>{turns++;return {state:'completed',text:'background reply'};};
  round.handlers.onSpeechStart();const mailbox=f.page.runDeviceAgentMailbox(f.state);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  round.handlers.onSpeechEnd();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  round.handlers.onFinal({text:'user input'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  f.page.deviceAgentTurnActive=false;f.page.resumeDeviceAgentClaim();await mailbox;
  assert.equal(turns,1);assert.equal(f.calls.filter(call=>call.path==='/deliveries/claim').length,1);runtime.dispose();
});

test('replacement owner releases an idle waiter without waiting for unrelated speech to end',async()=>{
  const f=fixture();f.page.deviceAgentOwner=f.state;f.page.deviceAgentTurnActive=true;
  let finished=false;const mailbox=f.page.runDeviceAgentMailbox(f.state).then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));
  f.page.stopDeviceAgentOwner();f.page.deviceAgentOwner={...f.state,sessionId:'replacement'};
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,true);assert.equal(f.calls.some(call=>call.path==='/deliveries/claim'),false);
  await mailbox;
});

test('late registration context cannot create a model or block the replacement startup',async()=>{
  const f=fixture();let completeContext,models=0;
  f.contextHandler(()=>new Promise(resolve=>{completeContext=resolve;}));
  f.page.ensureChatModel=async()=>{models++;return {};};f.page.runDeviceAgentMailbox=async()=>{};
  f.handler(async()=>({session:{ownerEpoch:'replacement-epoch'}}));
  const old=f.page.startDeviceAgentOwner();f.page.stopDeviceAgentOwner();
  f.contextHandler(async()=>({agentId:'glasses',targetDeviceId:'pc-owner'}));
  await f.page.startDeviceAgentOwner();const replacement=f.page.deviceAgentOwner;
  assert.ok(replacement,'replacement can register while obsolete context is pending');
  completeContext({agentId:'old',targetDeviceId:'old-owner'});await old;
  assert.equal(models,1);assert.equal(f.page.deviceAgentOwner,replacement);
  assert.equal(f.calls.filter(c=>c.options.body?.loaded===true).length,1);
});

test('obsolete startup rejection does not overwrite current presentation or release a newer startup',async()=>{
  const f=fixture();let rejectOld,resolveNew;
  f.contextHandler(()=>new Promise((_resolve,reject)=>{rejectOld=reject;}));
  const old=f.page.startDeviceAgentOwner();f.page.stopDeviceAgentOwner();
  f.contextHandler(()=>new Promise(resolve=>{resolveNew=resolve;}));
  const current=f.page.startDeviceAgentOwner();
  rejectOld(Error('obsolete connection'));await old;
  assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
  assert.ok(f.page.deviceAgentOwnerStarting);
  f.page.runDeviceAgentMailbox=async()=>{};f.handler(async()=>({session:{ownerEpoch:'current'}}));
  resolveNew({agentId:'glasses',targetDeviceId:'pc-owner'});await current;
  assert.equal(f.page.deviceAgentOwner.ownerEpoch,'current');
});

test('registration and mailbox writes preserve records created during awaited work',async()=>{
  const f=fixture(),key='rabilink-aiui-device-agent-v1',mailbox=f.page.runDeviceAgentMailbox;f.page.runDeviceAgentMailbox=async()=>{};
  function concurrentRecord(name) {
    const value=structuredClone(f.storage.get(key));
    value.executions[name]={state:'settled',deliveryId:name};
    value.sessions[name]='other-session';f.storage.set(key,value);
  }
  f.handler(async()=>{concurrentRecord('during-registration');return {session:{ownerEpoch:'current'}};});
  await f.page.startDeviceAgentOwner();
  assert.ok(f.storage.get(key).executions['during-registration']);
  const state=f.page.deviceAgentOwner;
  f.page.executeLingzhuAgentPrompt=async()=>{concurrentRecord('during-model');return {state:'completed',text:'result'};};
  f.handler(async(path)=>{
    if(path.startsWith('/pending'))return {pending:true};
    if(path==='/deliveries/claim')return {delivery:{deliveryId:'work',prompt:'prompt',claimToken:'claim'}};
    concurrentRecord('during-response');f.page.pageVisible=false;return {receipt:{deliveryId:'work',sessionId:state.sessionId,ownerEpoch:state.ownerEpoch,status:'completed'}};
  });
  await mailbox.call(f.page,state);
  for(const name of ['during-registration','during-model','during-response']) {
    assert.ok(f.storage.get(key).executions[name],name);assert.equal(f.storage.get(key).sessions[name],'other-session');
  }
  assert.equal(f.storage.get(key).executions[state.scope+'|work'].state,'settled');
});

test('cancelled remote registration settles and unregisters before replacement registration',async()=>{
  const f=fixture();let resolveRegister,resolveUnregister;
  f.page.runDeviceAgentMailbox=async()=>{};
  f.handler((_path,options)=>new Promise(resolve=>{
    if(options.body.loaded)resolveRegister=resolve;else resolveUnregister=resolve;
  }));
  const old=f.page.startDeviceAgentOwner();await new Promise(resolve=>setImmediate(resolve));
  f.page.stopDeviceAgentOwner();await f.page.startDeviceAgentOwner();
  assert.equal(f.calls.length,1,'do not overlap remote registrations');
  resolveRegister({session:{sessionId:f.calls[0].options.body.sessionId,ownerEpoch:'old-epoch'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.body.loaded,false);
  await f.page.startDeviceAgentOwner();assert.equal(f.calls.length,2,'wait for stale unregister receipt');
  resolveUnregister({});await old;
  f.handler(async()=>({session:{ownerEpoch:'new-epoch'}}));await f.page.startDeviceAgentOwner();
  assert.equal(f.page.deviceAgentOwner.ownerEpoch,'new-epoch');
  assert.equal(f.calls.length,3);
});

test('receipt reconciliation preserves a concurrently recorded delivery',async()=>{
  const f=fixture(),key='rabilink-aiui-device-agent-v1';f.page.deviceAgentOwner=f.state;
  f.storage.set(key,{sessions:{},executions:{'scope|old':{deliveryId:'old',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,state:'response-pending'}}});
  f.handler(async()=>{
    const latest=structuredClone(f.storage.get(key));latest.executions['scope|new']={deliveryId:'new',state:'running'};
    f.storage.set(key,latest);return {receipt:{deliveryId:'old',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed'}};
  });
  await f.page.reconcileDeviceAgentReceipts();
  assert.equal(f.storage.get(key).executions['scope|old'].state,'settled');
  assert.equal(f.storage.get(key).executions['scope|new'].state,'running');
});

test('late receipt failure after owner replacement leaves current status untouched',async()=>{
  const f=fixture();let rejectReceipt;f.page.deviceAgentOwner=f.state;
  f.storage.set('rabilink-aiui-device-agent-v1',{sessions:{},executions:{'scope|old':{deliveryId:'old',state:'running'}}});
  f.handler(()=>new Promise((_resolve,reject)=>{rejectReceipt=reject;}));
  const old=f.page.reconcileDeviceAgentReceipts();f.page.deviceAgentOwner={...f.state,sessionId:'new'};
  rejectReceipt(Error('old receipt'));await old;
  assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
});

test('lease recovery reads a committed original reply and resumes without resending or reexecuting it',async()=>{
  const f=fixture(),key='rabilink-aiui-device-agent-v1';let turns=0,recovering=false;
  f.page.deviceAgentOwner=f.state;f.page.chatAssistant={getState:()=>({ready:true})};
  f.page.executeLingzhuAgentPrompt=async()=>{turns++;return {state:'completed',text:'saved result'};};
  f.handler(async(path)=>{
    if(path==='/session')return {session:{sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,loaded:true}};
    if(path==='/deliveries/original')return {receipt:{deliveryId:'original',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed',response:{status:'completed',text:'saved result'}}};
    if(path.startsWith('/pending')) {if(recovering)f.page.pageVisible=false;return {pending:true};}
    if(path==='/deliveries/claim')return {delivery:{deliveryId:'original',prompt:'work',claimToken:'claim'}};
    throw Error('response was committed, acknowledgement lost');
  });
  await f.page.runDeviceAgentMailbox(f.state);
  assert.equal(f.storage.get(key).executions['scope|original'].state,'response-pending');
  recovering=true;f.page.scheduleDeviceAgentLease();await f.fireLease();await f.state.mailboxWork;
  assert.equal(f.storage.get(key).executions['scope|original'].state,'settled');
  assert.equal(turns,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/response')).length,1);
  assert.equal(f.calls.filter(c=>c.path.startsWith('/pending')).length,2);
});

test('parallel mailbox entry points share one live claim and inference',async()=>{
  const f=fixture();let finish,turns=0;f.page.deviceAgentOwner=f.state;
  f.page.executeLingzhuAgentPrompt=()=>{turns++;return new Promise(resolve=>{finish=resolve;});};
  f.handler(async(path)=>{
    if(path.startsWith('/pending'))return {pending:true};
    if(path==='/deliveries/claim')return {delivery:{deliveryId:'once',prompt:'work',claimToken:'claim'}};
    f.page.pageVisible=false;return {receipt:{deliveryId:'once',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed'}};
  });
  const first=f.page.runDeviceAgentMailbox(f.state),second=f.page.runDeviceAgentMailbox(f.state);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(turns,1);assert.equal(f.calls.filter(c=>c.path==='/deliveries/claim').length,1);
  finish({state:'completed',text:'result'});await Promise.all([first,second]);assert.equal(f.state.mailboxWork,null);
});

test('unconfirmed or mismatched original receipts never trigger a new claim or response replay',async()=>{
  const original={deliveryId:'old',sessionId:'native-session',ownerEpoch:'owner-epoch'};
  for(const patch of [{status:'claimed'},{deliveryId:'other'},{sessionId:'other'},{ownerEpoch:'other'},{sessionId:undefined}]) {
    const f=fixture(),key='rabilink-aiui-device-agent-v1';f.page.deviceAgentOwner=f.state;
    f.storage.set(key,{sessions:{},executions:{'scope|old':{...original,state:'response-pending',response:{text:'saved'}}}});
    f.handler(async()=>({receipt:{...original,status:'completed',...patch}}));
    await f.page.runDeviceAgentMailbox(f.state);
    assert.equal(f.storage.get(key).executions['scope|old'].state,'response-pending');
    assert.deepEqual(f.calls.map(c=>c.path),['/deliveries/old']);assert.equal(f.state.mailboxWork,null);
  }
});

test('response acknowledgements from a different session or epoch remain pending',async()=>{
  for(const patch of [{sessionId:'other'},{ownerEpoch:'other'}]) {
    const f=fixture();f.page.deviceAgentOwner=f.state;
    f.page.executeLingzhuAgentPrompt=async()=>({state:'completed',text:'result'});
    f.handler(async(path)=>{
      if(path.startsWith('/pending'))return {pending:true};
      if(path==='/deliveries/claim')return {delivery:{deliveryId:'old',prompt:'work',claimToken:'claim'}};
      return {receipt:{deliveryId:'old',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,status:'completed',...patch}};
    });
    await f.page.runDeviceAgentMailbox(f.state);
    assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|old'].state,'response-pending');
    assert.match(f.page.data.deviceAgentProfileStatus,/DEVICE_AGENT_RESPONSE_UNCONFIRMED/);
  }
});

test('hidden recovery completion cannot settle local records or restart the mailbox',async()=>{
  const f=fixture(),key='rabilink-aiui-device-agent-v1';let complete;
  f.page.deviceAgentOwner=f.state;
  const row={deliveryId:'old',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,state:'response-pending'};
  f.storage.set(key,{sessions:{},executions:{'scope|old':row}});
  f.handler(()=>new Promise(resolve=>{complete=resolve;}));
  const work=f.page.runDeviceAgentMailbox(f.state);await new Promise(resolve=>setImmediate(resolve));
  f.page.pageVisible=false;complete({receipt:{...row,status:'completed'}});await work;
  assert.equal(f.storage.get(key).executions['scope|old'].state,'response-pending');
  assert.equal(f.calls.length,1);assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
});

test('registration reconciles persisted delivery records before starting the next mailbox wait',async()=>{
  const f=fixture(),key='rabilink-aiui-device-agent-v1',scope='|credential-hash|glasses|pc-owner';
  const row={deliveryId:'old',sessionId:'saved-session',ownerEpoch:'saved-epoch',state:'response-pending'};
  f.storage.set(key,{sessions:{[scope]:row.sessionId},ownerEpochs:{[scope]:row.ownerEpoch},executions:{[scope+'|old']:row}});
  f.handler(async(path)=>{
    if(path==='/session')return {session:{sessionId:row.sessionId,ownerEpoch:row.ownerEpoch}};
    if(path==='/deliveries/old')return {receipt:{...row,status:'completed'}};
    f.page.pageVisible=false;return {pending:false};
  });
  await f.page.startDeviceAgentOwner();await f.page.deviceAgentOwner.mailboxWork;
  assert.deepEqual(f.calls.map(c=>c.path),['/session','/deliveries/old','/pending?waitMs=12000']);
  assert.equal(f.storage.get(key).executions[scope+'|old'].state,'settled');
});

function pendingResponse(f) {
  const row={deliveryId:'original',sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,state:'response-pending',
    response:{sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,claimToken:'original-claim',status:'completed',text:'saved native answer'}};
  f.page.deviceAgentOwner=f.state;
  f.storage.set('rabilink-aiui-device-agent-v1',{sessions:{},executions:{'scope|original':row}});
  return row;
}
function responseReceipt(row) {
  return {deliveryId:row.deliveryId,sessionId:row.sessionId,ownerEpoch:row.ownerEpoch,status:row.response.status,
    response:{status:row.response.status,text:row.response.text,...(row.response.errorCode?{errorCode:row.response.errorCode}:{})}};
}
test('a saved result not received by PC is resubmitted with the original claim, never reexecuted',async()=>{
  const f=fixture(),row=pendingResponse(f);let turns=0;
  f.page.executeLingzhuAgentPrompt=async()=>{turns++;throw Error('must not rerun');};
  f.handler(async(path,options)=>{
    if(path==='/deliveries/original')return {receipt:{...responseReceipt(row),status:'claimed',response:null}};
    if(path.endsWith('/response')) {
      assert.deepEqual(options.body,row.response);assert.equal(options.operationId,'device-agent-response:original');
      return {receipt:responseReceipt(row)};
    }
    f.page.pageVisible=false;return {pending:false};
  });
  await f.page.runDeviceAgentMailbox(f.state);
  assert.deepEqual(f.calls.map(c=>c.path),['/deliveries/original','/deliveries/original/response','/pending?waitMs=12000']);
  assert.equal(turns,0);assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|original'].state,'settled');
});
test('lost recovery acknowledgement is read back on the next attempt without resending a committed result',async()=>{
  const f=fixture(),row=pendingResponse(f);let committed=false;
  f.handler(async(path)=>{
    if(path.endsWith('/response')){committed=true;throw Error('ack lost');}
    return {receipt:committed?responseReceipt(row):{...responseReceipt(row),status:'claimed',response:null}};
  });
  assert.equal(await f.page.reconcileDeviceAgentReceipts(),false);
  assert.equal(await f.page.reconcileDeviceAgentReceipts(),true);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/response')).length,1);
});
test('recovery rejects missing or conflicting saved-result evidence without claiming new work',async()=>{
  for(const patch of [{response:null},{response:{status:'completed',text:'other answer'}},{status:'failed'},
    {response:{status:'completed',text:'saved native answer',errorCode:'other-error'}}]) {
    const f=fixture(),row=pendingResponse(f);
    f.handler(async path=>{if(path!=='/deliveries/original')throw Error('unexpected mailbox continuation');return {receipt:{...responseReceipt(row),...patch}};});
    await f.page.runDeviceAgentMailbox(f.state);
    assert.equal(f.calls.length,1);assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|original'].state,'response-pending');
  }
});
test('changed owner, malformed saved response and stale read never resubmit the old claim',async()=>{
  for(const variant of ['owner','malformed','hidden','replacement']) {
    const f=fixture(),row=pendingResponse(f);
    if(variant==='owner')f.state.ownerEpoch='replacement-epoch';
    if(variant==='malformed'){row.response.claimToken='';f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|original']=row;}
    f.handler(async()=>{
      if(variant==='hidden')f.page.pageVisible=false;
      if(variant==='replacement')f.page.deviceAgentOwner={...f.state};
      return {receipt:{...responseReceipt(row),status:'claimed',response:null}};
    });
    assert.equal(await f.page.reconcileDeviceAgentReceipts(),false);assert.equal(f.calls.length,1);
  }
});
test('late recovery response cannot settle or present for a hidden or replaced owner',async()=>{
  for(const replacement of [false,true]) {
    const f=fixture(),row=pendingResponse(f);
    f.handler(async path=>{
      if(!path.endsWith('/response'))return {receipt:{...responseReceipt(row),status:'claimed',response:null}};
      if(replacement)f.page.deviceAgentOwner={...f.state};else f.page.pageVisible=false;
      return {receipt:responseReceipt(row)};
    });
    assert.equal(await f.page.reconcileDeviceAgentReceipts(),false);
    assert.equal(f.calls.length,2);assert.equal(f.storage.get('rabilink-aiui-device-agent-v1').executions['scope|original'].state,'response-pending');
    assert.equal(f.page.data.deviceAgentProfileStatus,undefined);
  }
});

test('hidden owner renews across multiple lease periods without claiming mailbox work',async()=>{
  const f=fixture();let claims=0;
  f.page.pageVisible=false;f.page.deviceAgentOwner=f.state;
  f.page.chatAssistant={getState:()=>({ready:true})};
  f.page.runDeviceAgentMailbox=async()=>{claims++;};
  f.handler(async()=>({session:{sessionId:f.state.sessionId,ownerEpoch:f.state.ownerEpoch,loaded:true}}));
  f.page.scheduleDeviceAgentLease();
  for(let i=0;i<5;i++)await f.fireLease();
  assert.equal(f.calls.length,5);assert.equal(claims,0);assert.equal(f.page.deviceAgentOwner,f.state);
  f.page.pageVisible=true;f.state.leaseConfirmed=false;
  await f.page.reconcileDeviceAgentReceipts();assert.equal(f.calls.length,5);
  await f.fireLease();assert.equal(f.state.leaseConfirmed,true);assert.equal(claims,1);
});
test('resuming after a suspended host never adopts a changed server epoch',async()=>{
  const f=fixture();let claims=0;
  f.page.deviceAgentOwner=f.state;f.state.leaseConfirmed=false;
  f.page.chatAssistant={getState:()=>({ready:true})};f.page.runDeviceAgentMailbox=async()=>{claims++;};
  f.handler(async()=>({session:{sessionId:f.state.sessionId,ownerEpoch:'different-epoch',loaded:true}}));
  f.page.scheduleDeviceAgentLease();await f.fireLease();
  assert.equal(f.page.deviceAgentOwner,null);assert.equal(claims,0);assert.equal(f.state.ownerEpoch,'owner-epoch');
  assert.match(f.page.data.deviceAgentProfileStatus,/连接未确认/);
});
