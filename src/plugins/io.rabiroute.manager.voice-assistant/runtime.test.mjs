import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceAssistantOwner} from './src/runtime.mjs';
import {createVoiceAssistantAgent} from './src/agent-endpoint.mjs';
import {createRabiOperationTools} from './src/operation-tools.mjs';
import {createChatModel} from '@rabilink/desktop-voice-service/chat-model';
const identity={applicationGenerationId:'app',managerInstanceId:'manager',activationId:'activation'};
async function fixture(overrides={}){
  const stateRoot=await mkdtemp(join(tmpdir(),'rabi-voice-owner-')),abort=new AbortController(),requests=[],modelPrompts=[],modelRequests=[];
  const speech={speechControl:{personas:()=>[{id:'A',voiceReady:true,defaultModel:'tts',speed:1}],models:async()=>[{id:'asr',capability:'asr',enabled:true,available:true},{id:'tts',capability:'tts',enabled:true,available:true}]}};
  const sdk={async call(id,input){requests.push({id,input});return {ok:true,data:{code:0,data:id==='manager.roles.list'?{roles:[{roleId:'A',title:'人格 A'},{roleId:'B',title:'无本机声线人格'}],nextCursor:null}:id==='manager.personas.resources.reference.read'?{document:'你是人格 '+input.pathParams.roleId,personaConfig:{}}:{value:'native'}}}}};
  sdk.describe=async id=>({operation:{id,contract:{transport:'http',method:'GET',effects:{mode:'read'},request:{body:{kind:'none'}}}}});sdk.invokeOperation=async()=>({ok:true,statusCode:200,body:'{}'});sdk.openOperation=async()=>({});
  const args={identity,stateRoot,speech,publish(){},signal:abort.signal,clientFactory:async()=>({operations:sdk,close:async()=>{}}),modelCatalog:async()=>[{id:'fixture',label:'fixture',isDefault:true}],createModel:options=>(modelPrompts.push(options.initialPrompts),createChatModel({...options,provider:'compatible',endpoint:'https://example.test/chat/completions',resolveCredential:async()=>undefined,fetcher:async()=>(modelRequests.push(true),new Response('data: '+JSON.stringify({choices:[{delta:{content:'真实公共循环的回答'}}]})+'\n\ndata: [DONE]\n\n'))})),...overrides};
  let owner=await createVoiceAssistantOwner(args);
  return {requests,modelPrompts,modelRequests,args,get owner(){return owner},async restart(){await owner.dispose();owner=await createVoiceAssistantOwner(args)},async close(){await owner.dispose();await rm(stateRoot,{recursive:true,force:true})}};
}
test('mobile custom TTS capability and endpoint use saved provider and authoritative current reply without a desktop device',async()=>{
  let calls=0;
  const wave=Buffer.alloc(48);wave.write('RIFF');wave.writeUInt32LE(40,4);wave.write('WAVE',8);
  const f=await fixture({deviceFactory:async()=>assert.fail('mobile synthesis must not acquire a desktop device'),customProviderFactory:()=>({async synthesize(input,_signal,expression){calls++;assert.equal(input,'真实公共循环的回答');assert.equal(expression,undefined);return wave}})});
  try{
    assert.equal((await f.owner.state('mobile')).capabilities.mobileCustomTts,false);
    await f.owner.command({action:'host-settings',patch:{ttsSource:'custom'}});
    await f.owner.command({action:'settings',patch:{ttsProvider:'compatible',ttsEndpoint:'https://fixture.test/speech',ttsModel:'fixture',ttsVoice:'fixture',voiceEnabled:true}});
    assert.equal((await f.owner.state('mobile')).capabilities.mobileCustomTts,true);
    await f.owner.command({action:'credential',kind:'tts',provider:'compatible',endpoint:'https://fixture.test/speech',key:'fixture-only-key'});
    assert.equal((await f.owner.state('mobile')).capabilities.mobileCustomTts,true);
    const session=await f.owner.session();await f.owner.submit('测试','mobile-tts');
    const deadline=Date.now()+2000;
    while(Date.now()<deadline){
      if((await f.owner.messages()).some(row=>row.id==='reply-mobile-tts'&&row.status==='completed')&&(await f.owner.state()).activity.pending===0)break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal((await f.owner.state()).activity.pending,0);
    const request={sessionId:session.id,responseId:'reply-mobile-tts',input:'真实公共循环的回答'};
    assert.deepEqual(await f.owner.synthesizeMobile(request),wave);assert.deepEqual(await f.owner.synthesizeMobile(request),wave);assert.equal(calls,1);
    await f.owner.command({action:'settings',patch:{ttsSpeed:1.1}});
    assert.deepEqual(await f.owner.synthesizeMobile(request),wave);assert.equal(calls,2);
    await f.owner.command({action:'clear-context',sessionId:session.id,confirm:true});
    await assert.rejects(f.owner.synthesizeMobile(request),/CONTEXT_CHANGED/);
  }finally{await f.close()}
});

test('mobile-only latest reply projection retains authoritative tool boundaries when polling misses the tool',async()=>{
  let step=0;
  const f=await fixture({createModel:()=>({async prompt(input){const value=JSON.parse(input[0].content);return step++===0?JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'rabi_call',arguments:{operation:'manager.roles.list',input:{}},say:'我查一下'}):'结果好了。'},destroy(){}})});
  async function complete(id){
    await f.owner.submit('fixture',id);const deadline=Date.now()+2000;
    while((await f.owner.state()).activity.pending&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await f.owner.state()).activity.pending,0);
  }
  try{
    await complete('short-tool');
    const projected=await f.owner.messages('mobile'),row=projected.messages.find(item=>item.id==='reply-short-tool');
    assert.equal(projected.activity.status,'completed');assert.equal(row.text,'我查一下\n结果好了。');assert.deepEqual(row.speechSegmentEnds,[5]);assert.equal(row.details,undefined);
    assert.equal((await f.owner.messages()).find(item=>item.id===row.id).speechSegmentEnds,undefined);
    await complete('next');
    const next=await f.owner.messages('mobile');assert.equal(next.messages.find(item=>item.id===row.id).speechSegmentEnds,undefined);assert.deepEqual(next.messages.at(-1).speechSegmentEnds,[]);
  }finally{await f.close()}
});

test('plugin-owned session works without an external role route; refresh/restart preserves history and exact delivery identity',async()=>{
  const f=await fixture();try{const first=await f.owner.session();await f.owner.submit('你好','request-1');for(let n=0;n<80&&!(await f.owner.messages()).some(item=>item.status==='completed');n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok((await f.owner.messages()).some(item=>item.text==='真实公共循环的回答'),JSON.stringify(await f.owner.messages()));
    await f.restart();assert.equal((await f.owner.session()).id,first.id);assert.equal(await f.owner.recover('request-1','你好'),true);await assert.rejects(f.owner.recover('request-1','changed'),/REQUEST_CONFLICT/);
    assert.equal((await f.owner.messages()).length,2);
  }finally{await f.close()}
});
test('all four independent speech source combinations and a persona without local voice keep text/model settings available',async()=>{
  const f=await fixture();try{
    for(const asrSource of ['host','custom'])for(const ttsSource of ['host','custom']){await f.owner.command({action:'host-settings',patch:{personaId:'B',asrSource,ttsSource}});const state=await f.owner.state();assert.equal(state.hostSettings.asrSource,asrSource);assert.equal(state.hostSettings.ttsSource,ttsSource);assert.equal(state.hostSettings.voiceReady,false);assert.equal(state.capabilities.modelConfiguration,true);assert.equal(state.settings.persona,'你是人格 B')}
    const b=(await f.owner.session()).id;await f.owner.command({action:'host-settings',patch:{personaId:'A'}});assert.notEqual((await f.owner.session()).id,b);await f.owner.command({action:'host-settings',patch:{personaId:'B'}});assert.equal((await f.owner.session()).id,b);
  }finally{await f.close()}
});
test('persona switches share connection settings while each real system prompt and history remains isolated',async()=>{
 const f=await fixture();try{
  await f.owner.command({action:'settings',patch:{llmModel:'shared-model',ttsVoice:'shared-custom',onboardingComplete:true}});
  for(const personaId of ['A','B']){
   await f.owner.command({action:'host-settings',patch:{personaId,asrSource:'custom',ttsSource:'custom'}});
   const state=await f.owner.state();assert.equal(state.settings.llmModel,'shared-model');assert.equal(state.settings.ttsVoice,'shared-custom');assert.equal(state.settings.onboardingComplete,true);
   await f.owner.submit('以当前身份回应','request-'+personaId);for(let n=0;n<80&&(await f.owner.state()).context.busy;n++)await new Promise(resolve=>setTimeout(resolve,5));
   const prompt=f.modelPrompts.at(-1).find(item=>item.role==='system').content;assert.ok(prompt.includes('你是人格 '+personaId));assert.ok(!prompt.includes('你是人格 '+(personaId==='A'?'B':'A')));
  }
  await f.restart();assert.equal((await f.owner.state()).settings.llmModel,'shared-model');assert.equal((await f.owner.messages()).filter(item=>item.role==='user').length,1);
 }finally{await f.close()}
});
test('unavailable inherited voice models use a ready default while explicit unavailable choices remain visible and block capture',async()=>{
 const f=await fixture();try{
  f.args.speech.speechControl.personas=()=>[{id:'A',voiceReady:true,defaultModel:'not-installed',speed:1}];
  await f.owner.command({action:'host-settings',patch:{personaId:'A'}});assert.equal((await f.owner.state()).hostSettings.ttsModel,'tts');
  await f.owner.command({action:'host-settings',patch:{asrModel:'explicit-unavailable'}});const state=await f.owner.state();assert.equal(state.settings.asrModel,'explicit-unavailable');assert.match(state.hostSettings.asrIssue,/不可用/);
  await assert.rejects(f.owner.command({action:'start'}),/HOST_ASR_CONFIGURATION_REQUIRED/);
 }finally{await f.close()}
});
test('Agent endpoint routes to the same owner, recovers original receipts, rejects foreign sessions and retires',async()=>{
  const f=await fixture();let retired=false;try{const agent=createVoiceAssistantAgent(f.owner,identity,()=>{if(retired)throw Error('retired')},'delivery-authority-distinct-from-http'),session=await f.owner.session();
    const target=(await agent.serviceEndpoint.resolveTarget({agentAdapter:'voice-assistant',threadId:session.id})).endpoint;
    assert.notEqual(target.managerInstanceId,identity.managerInstanceId);assert.equal(target.managerInstanceId,'delivery-authority-distinct-from-http');assert.throws(()=>agent.serviceEndpoint.authorize({...target,managerInstanceId:identity.managerInstanceId}),/RETIRED/);
    const listed=await agent.operations['threads.request']({request:{action:'list',agentAdapter:'voice-assistant'}});
    assert.equal(listed.data.code,0);assert.ok(Object.hasOwn(listed.data.threads[0],'updatedAt'));
    assert.equal(await agent.serviceEndpoint.resolveSource({messageSource:{agentAdapter:'voice-assistant',sessionId:session.id}}),undefined);
    const principal={provider:target.provider,agentId:target.agentId,sessionId:target.sessionId,authorizationIncarnation:target.authorizationIncarnation};
    assert.equal((await agent.serviceEndpoint.resolveSource({sourceThreadId:session.id},principal)).threadId,session.id);
    await assert.rejects(agent.serviceEndpoint.resolveSource({sourceThreadId:session.id},{...principal,authorizationIncarnation:'forged'}),/RETIRED/);
    const delivery={deliveryId:'delivery-1',generation:'generation',target,prompt:'ping',promptHash:'hash',executionOptionsHash:'options'};
    assert.equal(await agent.serviceEndpoint.transport(delivery,()=>{},true),undefined);
    const receipt=await agent.serviceEndpoint.transport(delivery,()=>{},false);assert.equal(receipt.accepted,true);assert.deepEqual(await agent.serviceEndpoint.transport(delivery,()=>{},true),receipt);
    await assert.rejects(agent.serviceEndpoint.resolveTarget({threadId:'foreign'}),/CONTEXT_CHANGED/);
    await assert.rejects(agent.operations['threads.request']({request:{action:'delete',agentAdapter:'voice-assistant',threadId:session.id}}),/UNSUPPORTED/);
    retired=true;assert.throws(()=>agent.serviceEndpoint.authorize(target),/retired/);
  }finally{await f.close()}
});
test('unknown writes keep their owned request identity; readback remains allowed while new writes are fenced',async()=>{
 const calls=[],sdk={describe:async id=>({operation:{id,contract:{transport:'http',method:id==='readback'?'GET':'PATCH',effects:{mode:id==='readback'?'read':'write'},request:{body:{kind:id==='readback'?'none':'json',schema:{type:'object'}}}}}}),invokeOperation:async(id,options)=>{calls.push({id,options});if(id==='write')throw Error('native disconnected');return {ok:true,statusCode:200,body:'{}'}}};
 const backend=createRabiOperationTools({sdk});try{
  const unknown=await backend.executeTool({functionName:'rabi_call',arguments:{operation:'write',input:{body:{value:1}}},callId:'owned-call'});
  assert.equal(unknown.uncertain,true);assert.equal(unknown.mutation,true);assert.equal(unknown.requestId,'owned-call');assert.equal(calls[0].options.headers['idempotency-key'],'owned-call');
  const read=await backend.executeTool({functionName:'rabi_call',arguments:{operation:'readback'},writeReconciliationRequired:true});assert.equal(read.ok,true);
  const blocked=await backend.executeTool({functionName:'rabi_call',arguments:{operation:'write',input:{body:{value:2}}},callId:'new-call',writeReconciliationRequired:true});
  assert.equal(blocked.error,'WRITE_RECONCILIATION_REQUIRED');assert.equal(blocked.mutation,true);assert.equal(blocked.dispatched,false);assert.deepEqual(calls.map(item=>item.id),['write','readback']);
 }finally{await backend.dispose()}
});
test('dynamic SDK tools forward arbitrary operation IDs, schemas, original parameters and uncertainty without retry',async()=>{
  const calls=[],sdk={categories:async()=>({categories:[{id:'new-plugin'}]}),list:async filters=>({operations:[],nextCursor:filters.cursor?null:'page2'}),search:async(query,filters)=>({query,filters}),describe:async id=>({operation:{id,contract:{transport:'http',method:'PATCH',effects:{mode:'write'},request:{body:{kind:'json',schema:{type:'object'}}}}}}),invokeOperation:async(id,options)=>{calls.push({id,options});return {ok:false,statusCode:503,uncertain:true,body:JSON.stringify({code:-1,uncertain:true})}}};
  const backend=createRabiOperationTools({sdk});try{
    assert.equal((await backend.executeTool({functionName:'rabi_list',arguments:{}})).data.nextCursor,'page2');
    const result=await backend.executeTool({functionName:'rabi_call',arguments:{operation:'unlisted.future.operation',input:{pathParams:{nodeId:'remote'},query:{target:'original'},body:{a:1}},requestId:'original-id'}});
    assert.equal(calls.length,1);assert.equal(calls[0].id,'unlisted.future.operation');assert.equal(calls[0].options.headers['idempotency-key'],'original-id');assert.deepEqual(calls[0].options.pathParams,{nodeId:'remote'});assert.equal(backend.toolPolicy.inspectOutcome(result).uncertain,true);
  }finally{await backend.dispose()}
});
test('owned Agent delivery forwards its original receipt and keeps reconciliation available after an unknown send',async()=>{
 const calls=[],backend=createRabiOperationTools({sdk:{describe:async()=>{throw Error('unexpected operation')},invokeOperation:async()=>{throw Error('unexpected operation')}},sendAgent:async request=>{calls.push(request);return {statusCode:request.action==='send'?202:200,data:{status:'accepted',deliveryId:request.deliveryId}}}});
 try{const sent=await backend.executeTool({functionName:'rabi_agent_deliver',callId:'owned-call',arguments:{action:'send',agentAdapter:'voice-assistant',threadId:'target',prompt:'hello'}});assert.equal(sent.data.deliveryId,'owned-call');assert.equal(sent.statusCode,202);
  const blocked=await backend.executeTool({functionName:'rabi_agent_deliver',callId:'new-call',writeReconciliationRequired:true,arguments:{action:'send',agentAdapter:'voice-assistant',threadId:'target',prompt:'again'}});assert.equal(blocked.dispatched,false);
  const read=await backend.executeTool({functionName:'rabi_agent_deliver',writeReconciliationRequired:true,arguments:{action:'reconcile_delivery',agentAdapter:'voice-assistant',threadId:'target',deliveryId:'owned-call'}});assert.equal(read.ok,true);assert.deepEqual(calls.map(x=>x.deliveryId),['owned-call','owned-call']);
  await assert.rejects(backend.executeTool({functionName:'rabi_agent_deliver',callId:'not-original-id',arguments:{action:'reconcile_delivery',agentAdapter:'voice-assistant',threadId:'target'}}),/DELIVERY_ID_REQUIRED/);
  for(const patch of [{unknown:true},{messageSource:{}},{threadId:2},{agentAdapter:[]},{prompt:12},{deliveryId:'x'.repeat(101)},{responsePolicy:'anything'},{instanceBinding:{instanceId:'node',agentId:'agent',extra:true}},{instanceBinding:{instanceId:1,agentId:'agent'}}])await assert.rejects(backend.executeTool({functionName:'rabi_agent_deliver',callId:'owned-call',arguments:{action:'send',agentAdapter:'voice-assistant',threadId:'target',prompt:'hello',...patch}}),/AGENT_DELIVERY_/);
  assert.equal(calls.length,2);
 }finally{await backend.dispose()}
});
test('native delivery failures preserve only a machine code and function stage without private messages or stack paths',async()=>{
 const backend=createRabiOperationTools({sdk:{describe:async()=>{},invokeOperation:async()=>{}},sendAgent:async()=>{const error=Object.assign(Error('Bearer private-key /private/config'),{code:'ORIGINAL_OWNER_FAILED',stack:'Error: private\n    at originalOwner (/private/config:12:3)'});throw error}});
 try{const result=await backend.executeTool({functionName:'rabi_agent_deliver',arguments:{action:'reconcile_delivery',agentAdapter:'voice-assistant',threadId:'target',deliveryId:'original'}});assert.equal(result.uncertain,true);assert.equal(result.deliveryId,'original');assert.equal(result.causeCode,'ORIGINAL_OWNER_FAILED');assert.equal(result.failureStage,'originalOwner');assert.ok(!JSON.stringify(result).includes('private'));}finally{await backend.dispose()}
});
test('native send keeps caller identity separate from the actual scoped receipt ID used for reconciliation',async()=>{
 const backend=createRabiOperationTools({sdk:{describe:async()=>{},invokeOperation:async()=>{}},sendAgent:async()=>({statusCode:200,data:{communication:{deliveryId:'agent-scoped-original'}}})});
 try{const result=await backend.executeTool({functionName:'rabi_agent_deliver',arguments:{action:'send',agentAdapter:'voice-assistant',threadId:'target',prompt:'fixed',deliveryId:'caller-original'}});assert.equal(result.deliveryId,'agent-scoped-original');assert.equal(result.callerDeliveryId,'caller-original');}finally{await backend.dispose()}
});


test('read-only owner rejects every native command and delivery before opening model or settings',async()=>{
  let catalogCalls=0,deviceCalls=0;
  const f=await fixture({readOnly:()=>true,modelCatalog:async()=>{catalogCalls++;return []},deviceFactory:async()=>{deviceCalls++;throw Error('unexpected device')}});
  const tree=async()=>{const result={};for(const entry of await readdir(f.args.stateRoot,{recursive:true,withFileTypes:true})){if(entry.isFile()){const name=join(entry.parentPath,entry.name);result[name]=createHash('sha256').update(await readFile(name)).digest('hex')}}return result};
  try{
    const before=await tree();
    for(const action of ['text','start','stop','settings','settings-batch','credential','host-settings','test-playback','test-microphone','run-checks','devices','clear-context','exit'])
      await assert.rejects(f.owner.command({action,text:'fixture'}),/ASSISTANT_READ_ONLY/);
    await assert.rejects(f.owner.submit('fixture','readonly-request'),/ASSISTANT_READ_ONLY/);
    await assert.rejects(f.owner.recover('readonly-request','fixture'),/ASSISTANT_READ_ONLY/);
    await assert.rejects(f.owner.synthesizeMobile({sessionId:'unopened-session',responseId:'reply',input:'fixture'}),/ASSISTANT_READ_ONLY/);
    const agent=createVoiceAssistantAgent(f.owner,identity,()=>{},'fixture-authority');
    const sessionId='unopened-session',target={kind:'service',provider:'voice-assistant',managerInstanceId:'fixture-authority',agentId:'local:voice-assistant',sessionId,
      authorizationIncarnation:createHash('sha256').update(JSON.stringify([identity.applicationGenerationId,identity.managerInstanceId,identity.activationId,sessionId])).digest('hex')};
    for(const reconcile of [false,true])await assert.rejects(agent.serviceEndpoint.transport({deliveryId:'readonly-delivery',target,prompt:'fixture'},()=>{},reconcile),/ASSISTANT_READ_ONLY/);
    await assert.rejects(agent.operations.deliver({envelope:{id:'readonly-direct',text:'fixture'},binding:{sessionId}}),/ASSISTANT_READ_ONLY/);
    assert.deepEqual(await tree(),before);assert.equal(catalogCalls,0);assert.equal(deviceCalls,0);assert.equal(f.requests.length,0);assert.equal(f.modelPrompts.length,0);assert.equal(f.modelRequests.length,0);
  }finally{await f.close()}
});

test('read-only is rechecked after lazy open before a submitted message is admitted',async()=>{
  let readOnly=false;
  const f=await fixture({readOnly:()=>readOnly,modelCatalog:async()=>{readOnly=true;return [{id:'fixture',isDefault:true}]}});
  try{
    await assert.rejects(f.owner.submit('must not dispatch','revoked-during-open'),/ASSISTANT_READ_ONLY/);
    assert.equal(f.modelRequests.length,0);assert.equal((await f.owner.messages()).length,0);
  }finally{await f.close()}
});

test('read-only observation cannot acquire an audio device from saved enabled captions',async()=>{
  let deviceCalls=0;
  const f=await fixture({readOnly:()=>true,deviceFactory:async()=>{deviceCalls++;throw Error('unexpected audio acquisition')}});
  try{
    await writeFile(join(f.args.stateRoot,'data','voice-assistant','connection','settings.json'),JSON.stringify({version:1,encrypted:{},settings:{llmProvider:'compatible',llmEndpoint:'https://example.test/chat/completions',llmModel:'fixture',captionsEnabled:true}}));
    const state=await f.owner.state();
    assert.equal(deviceCalls,0);assert.equal(state.voice.phase,'stopped');assert.equal(state.caption.status,'failed');assert.equal(state.error,'ASSISTANT_READ_ONLY');assert.equal(f.modelRequests.length,0);
  }finally{await f.close()}
});

test('the same session picks up its host voice when the persona catalogue is published after startup',async()=>{
  const f=await fixture();
  try{
    f.args.speech.speechControl.personas=()=>[];
    await f.owner.command({action:'host-settings',patch:{personaId:'A'}});
    const before=await f.owner.state();
    assert.equal(before.hostSettings.voiceReady,false);
    assert.equal(before.settings.ttsVoice,'');
    f.args.speech.speechControl.personas=()=>[{id:'A',voiceReady:true,defaultModel:'tts',speed:1.2}];
    const after=await f.owner.state();
    assert.equal(after.sessionId,before.sessionId);
    assert.equal(after.hostSettings.voiceReady,true);
    assert.equal(after.hostSettings.ttsIssue,null);
    assert.equal(after.settings.ttsVoice,'A');
    assert.equal(after.settings.ttsSpeed,1.2);
  }finally{await f.close()}
});
