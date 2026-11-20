import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceAssistantOwner} from './src/runtime.mjs';
import {createVoiceAssistantOperations} from './src/operations.mjs';

test('mobile speech uses the original role conversation and leaves desktop audio alone', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const stateRoot=await mkdtemp(join(tmpdir(),'rabi-mobile-submit-'));
  const observations=[], nativeText=[], played=[];
  let owner;
  const speech={speechControl:{personas:()=>[],models:async()=>[]}};
  const operations={
    async describe(){return {operation:{contract:{transport:'http',method:'GET'}}};},
    async invokeOperation(){return {ok:true,statusCode:200,body:'{}'};},
    async call(id){
      const data=id==='manager.roles.list'?{roles:[{roleId:'A',title:'Fixture'}]}:{document:'Fixture role',personaConfig:{}};
      return {ok:true,data:{code:0,data}};
    },
  };
  try {
    owner=await createVoiceAssistantOwner({
      identity:{applicationGenerationId:'app',managerInstanceId:'manager',activationId:'fixture'},
      stateRoot,speech,signal:new AbortController().signal,publish(){},
      clientFactory:async()=>({operations,close:async()=>{}}),
      modelCatalog:async()=>[{id:'fixture',isDefault:true}],
      createModel:()=>({
        async prompt(input){
          observations.push(JSON.parse(input[0].content));
          return 'Reply from the shared conversation.';
        },
        destroy(){},
      }),
      customProviderFactory:()=>({
        createAsr:()=>({
          createRound:handlers=>({handlers}),
          start(round){round.handlers.onStart();},
          stop(){},
        }),
        async synthesize(text){played.push(text);return new Uint8Array(44);},
      }),
      deviceFactory:async()=>({
        configurePresenter:async()=>{},
        present:async value=>nativeText.push(value.text),
        async createPlayer(){
          const events=new EventTarget();
          return {events,async play(){queueMicrotask(()=>events.dispatchEvent(new Event('ended')));},async stop(){},async destroy(){}};
        },
        async close(){},
      }),
    });
    const waitFor=async check=>{
      for(let n=0;n<250;n++){
        if(await check())return;
        await delay(10);
      }
      assert.fail(JSON.stringify({messages:await owner.messages(),error:(await owner.state()).error,prompts:observations.length}));
    };
    await owner.command({action:'host-settings',patch:{personaId:'A',asrSource:'custom',ttsSource:'custom'}});
    await owner.command({action:'settings',patch:{
      electronExecutable:process.execPath,llmProvider:'compatible',llmEndpoint:'http://127.0.0.1:1',
      llmModel:'fixture',asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture',
    }});
    await owner.command({action:'start'});
    const state=await owner.state();
    assert.equal(state.voice.phase,'running');
    assert.equal(state.capabilities.mobileVoiceSubmit,true);
    const sessionId=state.sessionId;
    const requestId=randomUUID();
    const phone={action:'mobile-voice-submit',requestId,sessionId,text:'Phone speech',observation:{emotion:'happy',age:29,language:'zh-CN'}};
    const finish=async id=>waitFor(async()=> (await owner.messages()).some(entry=>entry.id==='reply-'+id&&entry.status==='completed'));
    await assert.rejects(owner.command({...phone,sessionId:'old-role-session'}),/ASSISTANT_CONTEXT_CHANGED/);
    await assert.rejects(owner.command({...phone,requestId:'reply-manual'}),/ASSISTANT_INPUT_INVALID/);
    await assert.rejects(owner.command({...phone,observation:{token:'fixture-secret'}}),/ASSISTANT_SPEECH_OBSERVATION_INVALID/);
    assert.deepEqual(await owner.command(phone),{accepted:true,sessionId,requestId});
    assert.deepEqual(await owner.command(phone),{accepted:true,sessionId,requestId});
    await finish(requestId);
    const readMessages=createVoiceAssistantOperations(owner,operation=>operation())
      .find(value=>value.contract.operationId==='manager.voice-assistant.messages').handler;
    const original=await readMessages({query:{}});
    const mobile=await readMessages({query:{view:'mobile'}});
    assert.ok(Array.isArray(original.body.data));
    assert.deepEqual(mobile.body.data.messages,original.body.data);
    assert.equal(mobile.body.data.sessionId,sessionId);
    assert.equal(mobile.body.data.activity.requestId,requestId);
    assert.equal(mobile.body.data.activity.status,'completed');
    assert.equal(observations.length,1);
    assert.deepEqual(observations[0].speechObservation?.estimates,phone.observation);
    assert.deepEqual(played,[]);
    assert.ok(!nativeText.includes('Reply from the shared conversation.'));
    assert.deepEqual((await owner.messages()).filter(message=>message.role==='user').map(value=>[value.id,value.source]),[[requestId,'speech']]);
    const desktopId=randomUUID();
    await owner.command({action:'text',text:'Desktop text',sessionId,requestId:desktopId});
    await finish(desktopId);
    await waitFor(()=>played.length>0);
    await owner.command({action:'settings',patch:{voiceEnabled:false}});
    await assert.rejects(owner.command({...phone,requestId:randomUUID()}),/ASSISTANT_VOICE_DISABLED/);
  } finally {
    await owner?.dispose();
    await rm(stateRoot,{recursive:true,force:true});
  }
});