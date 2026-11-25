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
  const observations=[], nativeText=[], played=[], asrRequests=[], petEvents=[];
  let owner, captureHandlers, localModel=true, keywordCompiles=0, speechAvailable=true, allowActiveAsr=false, holdLocalCheck=false, captures=0;
  const keywords={model:'fixture-kws',keywords:'Y E @rabi-0/N AY T @rabi-1',tokensSha256:'1'.repeat(64)};
  const speech={speechRuntimeControl:{
    async assistantLocalAsrModel(signal){
      if (holdLocalCheck) await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,1000);
        signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
      });
      return localModel?'fireredasr2/fireredasr2-aed':undefined;
    },
    async transcribeMobileAssistantAudio(audio,signal){
      signal.throwIfAborted();
      if(!localModel)throw Error('MOBILE_LOCAL_ASR_UNAVAILABLE');
      asrRequests.push(Buffer.from(audio));
      return {text:'Local speech',additions:{age:'31'}};
    },
    get assistantKeywordProfile(){
      if(!speechAvailable)throw Error('Speech activation is not ready');
      return async aliases=>{
        assert.deepEqual(aliases,['夜雨','night']);
        keywordCompiles++;
        return keywords;
      };
    },
  }, speechControl:{personas:()=>[],
    status:async()=>({state:'online',localOnly:false}),
    models:async()=>localModel?[{id:'local/fixture',capability:'asr',enabled:true,available:true,
      request:{properties:{prompt:{'x-rabi-dictionary':{format:'context',maxBytes:2048}}}}}]:[],
    async transcribe(contentType,body,guard){
      assert(allowActiveAsr,'mobile local input must never reach the public or peer ASR');
      guard();
      const form=await new Response(body,{headers:{'content-type':contentType}}).formData();
      asrRequests.push([form.get('model'),form.get('prompt')]);
      return {status:200,body:Buffer.from(JSON.stringify({text:'Local speech',additions:{age:'31'}}))};
    },
  }};
  const operations={
    async describe(){return {operation:{contract:{transport:'http',method:'GET'}}};},
    async invokeOperation(){return {ok:true,statusCode:200,body:'{}'};},
    async call(id,request){
      const data=id==='manager.roles.list'?{roles:[{roleId:'A',title:'Fixture'},{roleId:'B',title:'Other role'}]}:{
        document:'Fixture role',personaConfig:request.pathParams?.roleId==='B'?{speechTriggerKeywords:['夜雨','night']}:{},
      };
      return {ok:true,data:{code:0,data}};
    },
  };
  try {
    owner=await createVoiceAssistantOwner({
      identity:{applicationGenerationId:'app',managerInstanceId:'manager',activationId:'fixture'},
      stateRoot,speech,signal:new AbortController().signal,
      publish(){},
      publishDesktopPresentation(presentation,publicReply){petEvents.push({...presentation,publicReply});},
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
          start(round){captures++;captureHandlers=round.handlers;captureHandlers.onStart();},
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
      llmModel:'fixture',asrMode:'volcengine',asrModel:'bigmodel',asrDictionary:' Rabi \nＲＡＢＩ ',ttsModel:'fixture',ttsVoice:'fixture',
    }});
    await owner.command({action:'start'});
    const state=await owner.state();
    assert.equal(state.voice.phase,'running');
    const initialCaptures=captures;
    const paused=await owner.command({action:'pause'});
    assert.equal(paused.voice.phase,'running');
    assert.equal(paused.voice.capture,'stopped');
    const resumed=await owner.command({action:'start-for-persona',personaId:'A'});
    assert.equal(resumed.voice.capture,'listening');
    assert.equal(resumed.voice.generation,state.voice.generation);
    assert.equal(resumed.sessionId,state.sessionId);
    assert.equal(captures,initialCaptures+1);
    const alreadyListening=await owner.command({action:'start-for-persona',personaId:'A'});
    assert.equal(alreadyListening.voice.generation,state.voice.generation);
    assert.equal(alreadyListening.voice.capture,'listening');
    assert.equal(captures,initialCaptures+1);
    assert.equal(state.capabilities.mobileVoiceSubmit,true);
    assert.deepEqual(state.hostSettings.mobileAudio,{recognition:'streaming',sampleRate:16000,wakeAliases:[],passiveModel:'fireredasr2/fireredasr2-aed',dictionary:null});
    holdLocalCheck=true;
    assert.deepEqual((await owner.state('mobile')).hostSettings.mobileAudio,
      {recognition:'streaming',sampleRate:16000,wakeAliases:[],passiveAsrStatus:'checking'});
    holdLocalCheck=false;
    const sessionId=state.sessionId;
    const wav=Buffer.alloc(46);wav.write('RIFF');wav.write('WAVE',8);
    const routes=createVoiceAssistantOperations(owner,operation=>operation());
    const transcribe=routes.find(value=>value.contract.operationId==='manager.voice-assistant.mobile-transcribe').handler;
    const mobileState=await routes.find(value=>value.contract.operationId==='manager.voice-assistant.state').handler({query:{view:'mobile'}});
    assert.equal(state.settings.asrDictionary,'Rabi');
    assert.equal(Object.hasOwn(mobileState.body.data.settings,'asrDictionary'),false);
    const localRequest={query:{sessionId,source:'local'},body:wav};
    assert.deepEqual((await transcribe(localRequest)).body,{text:'Local speech',age:31});
    assert.deepEqual(asrRequests,[wav]);
    localModel=false;
    assert.equal((await transcribe(localRequest)).body.message,'MOBILE_LOCAL_ASR_UNAVAILABLE');
    localModel=true;
    assert.equal((await transcribe({...localRequest,query:{sessionId:'old',source:'local'}})).body.message,'ASSISTANT_CONTEXT_CHANGED');
    assert.equal(asrRequests.length,1);
    const requestId=randomUUID();
    const phone={action:'mobile-voice-submit',requestId,sessionId,text:'Phone speech',observation:{emotion:'happy',age:29,language:'zh-CN'},recentSpeech:[{text:'Earlier background',ageMs:1800}]};
    const finish=async id=>waitFor(async()=> (await owner.messages()).some(entry=>entry.id==='reply-'+id&&entry.status==='completed'));
    await assert.rejects(owner.command({...phone,sessionId:'old-role-session'}),/ASSISTANT_CONTEXT_CHANGED/);
    await assert.rejects(owner.command({...phone,requestId:'reply-manual'}),/ASSISTANT_INPUT_INVALID/);
    await assert.rejects(owner.command({...phone,observation:{token:'fixture-secret'}}),/ASSISTANT_SPEECH_OBSERVATION_INVALID/);
    await assert.rejects(owner.command({...phone,recentSpeech:[{text:'expired',ageMs:120000}]}),/ASSISTANT_RECENT_SPEECH_INVALID/);
    assert.deepEqual(await owner.command(phone),{accepted:true,sessionId,requestId});
    assert.deepEqual(await owner.command(phone),{accepted:true,sessionId,requestId});
    await finish(requestId);
    const readMessages=createVoiceAssistantOperations(owner,operation=>operation())
      .find(value=>value.contract.operationId==='manager.voice-assistant.messages').handler;
    const original=await readMessages({query:{}});
    const mobile=await readMessages({query:{view:'mobile'}});
    assert.ok(Array.isArray(original.body.data));
    assert.deepEqual(mobile.body.data.messages.map(({speechSegmentEnds,...row})=>row),original.body.data);
    assert.deepEqual(mobile.body.data.messages.at(-1).speechSegmentEnds,[]);
    assert.equal(mobile.body.data.sessionId,sessionId);
    assert.equal(mobile.body.data.activity.requestId,requestId);
    assert.equal(mobile.body.data.activity.status,'completed');
    assert.equal(observations.length,1);
    assert.deepEqual(observations[0].speechObservation?.estimates,phone.observation);
    assert.deepEqual(observations[0].recentSpeech,phone.recentSpeech);
    assert.deepEqual(played,[]);
    assert.ok(!nativeText.includes('Reply from the shared conversation.'));
    assert.deepEqual((await owner.messages()).filter(message=>message.role==='user').map(value=>[value.id,value.source]),[[requestId,'speech']]);
    const desktopId=randomUUID();
    await owner.command({action:'text',text:'Desktop text',sessionId,requestId:desktopId});
    await finish(desktopId);
    await waitFor(()=>played.length>0);
    await waitFor(async()=> (await owner.state()).activity.pending===0);
    await assert.rejects(owner.command({action:'start-for-persona',personaId:'B'}),/ASSISTANT_OTHER_PERSONA_ACTIVE/);
    assert.equal((await owner.state()).hostSettings.personaId,'A');
    await owner.command({action:'stop'});
    const companionVoice=await owner.command({action:'start-for-persona',personaId:'B'});
    assert.equal(companionVoice.voice.phase,'running');
    assert.equal(companionVoice.voice.capture,'listening');
    assert.equal(companionVoice.settings.petEnabled,false);
    captureHandlers.onInterim({text:'Companion microphone preview'});
    assert.equal(petEvents.at(-1).personaId,'B');
    assert.equal(petEvents.at(-1).publicReply,false);
    assert.deepEqual(petEvents.at(-1).inputPreview,{text:'Companion microphone preview',final:false});
    assert.equal((await owner.session()).name,'Other role');
    assert.deepEqual((await owner.messages()).filter(message=>message.role==='user'),[]);
    await owner.command({action:'settings',patch:{voiceEnabled:false}});
    assert.deepEqual({personaId:petEvents.at(-1).personaId,clear:petEvents.at(-1).clear,
      publicReply:petEvents.at(-1).publicReply},{personaId:'B',clear:true,publicReply:false});
    await assert.rejects(owner.command({action:'start-for-persona',personaId:'A'}),/ASSISTANT_VOICE_DISABLED/);
    await owner.command({action:'host-settings',patch:{personaId:'A'}});
    const mobileWhilePcDisabled=await owner.state('mobile');
    assert.equal((await owner.state()).settings.voiceEnabled,false);
    assert.equal(mobileWhilePcDisabled.settings.voiceEnabled,true);
    assert.equal((await transcribe({query:{sessionId:mobileWhilePcDisabled.sessionId,source:'local'},body:wav})).status,200);
    localModel=false;
    await owner.command({action:'host-settings',patch:{personaId:'B'}});
    const latest=await Promise.all([owner.state(),owner.state()]);
    for(const result of latest)assert.deepEqual(result.hostSettings.mobileAudio,
      {recognition:'streaming',sampleRate:16000,wakeAliases:['夜雨','night'],kws:keywords});
    assert.equal(keywordCompiles,1);
    speechAvailable=false;
    await owner.command({action:'host-settings',patch:{personaId:'A'}});
    await owner.command({action:'host-settings',patch:{personaId:'B'}});
    assert.deepEqual((await owner.state()).hostSettings.mobileAudio,
      {recognition:'streaming',sampleRate:16000,wakeAliases:[]});
    assert.equal(keywordCompiles,1);
    localModel=true;
    await owner.command({action:'host-settings',patch:{asrSource:'host'}});
    await owner.command({action:'settings',patch:{voiceEnabled:true}});
    const hostState=await owner.state();
    assert.equal(hostState.asrDictionary.recognition.format,'context');
    allowActiveAsr=true;
    assert.equal((await transcribe({query:{sessionId:hostState.sessionId,source:'active'},body:wav})).body.text,'Local speech');
    assert.deepEqual(asrRequests.at(-1),['local/fixture','Rabi']);
  } finally {
    await owner?.dispose();
    await rm(stateRoot,{recursive:true,force:true});
  }
});
