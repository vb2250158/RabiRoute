import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {createVoiceAssistantOwner} from './src/runtime.mjs';import {createChatModel} from '@rabilink/desktop-voice-service/chat-model';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('the PC assistant switch owns background capture, with an independent compute selection and safe retirement', async t => {
  const stateRoot=await mkdtemp(join(tmpdir(),'rabi-assistant-background-'));
  const calls=[];
  const owner=await createVoiceAssistantOwner({
    identity:{applicationGenerationId:'app',managerInstanceId:'manager',activationId:'assistant'},
    stateRoot,signal:new AbortController().signal,publish(){},
    clientFactory:async()=>({operations:{async call(){return {ok:true,data:{roles:[]}}}},close:async()=>{}}),
    speech:{
      computeServers:async()=>{throw Error('RabiLink Relay is not configured.')},
      speechControl:{models:async()=>[],personas:()=>[],microphoneStatus:async()=>({config:{streamingEnabled:false}})},
      speechRuntimeControl:{async setAssistantResident(settings){calls.push(settings)}},
    },
    modelCatalog:async()=>[],
  });
  t.after(async()=>{await owner.dispose();await rm(stateRoot,{recursive:true,force:true})});
  const initial=await owner.state();
  assert.equal(initial.settings.voiceEnabled,false);
  assert.deepEqual(initial.hostSettings.modelComputers,[]);
  await owner.command({action:'host-settings',patch:{backgroundAsrDeviceId:'trusted-peer',backgroundAsrModel:'small-asr'}});
  await owner.command({action:'settings',patch:{voiceEnabled:true}});
  assert.equal((await owner.state()).hostSettings.residentTranscription.phase,'recording');
  assert.deepEqual(calls.at(-1),{enabled:true,ownerId:'assistant',model:'small-asr',computeDeviceId:'trusted-peer'});
  await owner.command({action:'settings',patch:{voiceEnabled:false}});
  assert.equal((await owner.state()).hostSettings.residentTranscription.phase,'disabled');
  assert.equal((await owner.state('mobile')).settings.voiceEnabled,true);
  await owner.command({action:'settings',patch:{voiceEnabled:true}});
  await owner.dispose();
  assert.deepEqual(calls.at(-1),{enabled:false,ownerId:'assistant',release:true});
});

for(const asrSource of ['host','custom'])for(const ttsSource of ['host','custom'])test(`actual ASR→automatic model submit→one player: ${asrSource} ASR + ${ttsSource} TTS`,async()=>{
 const stateRoot=await mkdtemp(join(tmpdir(),'rabi-voice-sources-')),abort=new AbortController();let owner;
 const calls={hostAsr:0,hostTts:0,customAsr:0,customTts:0,players:0,opened:0,closed:0,recordings:0,released:0},transcripts=[];
 const sdk={async call(id,input){if(id==='manager.desktop-pet.transcripts.append'){transcripts.push(input.body);return {ok:true,data:{code:0,data:{appended:true}}}}return {ok:true,data:{code:0,data:id==='manager.roles.list'?{roles:[{roleId:'A'}],nextCursor:null}:{document:'测试人格',personaConfig:{}}}}},describe:async()=>({operation:{contract:{transport:'http'}}}),invokeOperation:async()=>({ok:true,statusCode:200,body:'{}'})};
 const speech={speechControl:{personas:()=>[{id:'A',voiceReady:true,defaultModel:'tts',speed:1}],models:async()=>[{id:'asr',capability:'asr',enabled:true,available:true},{id:'tts',capability:'tts',enabled:true,available:true}],async transcribe(type,bytes,guard){guard();calls.hostAsr++;assert.match(type,/multipart/);assert.ok(bytes.length);return {status:200,body:Buffer.from(JSON.stringify({text:'实际识别文本',additions:{emotion:'happy'}}))}},async synthesize(command,guard){guard();calls.hostTts++;assert.equal(command.play,false);assert.equal(command.voice,'A');return {status:200,body:Buffer.alloc(44)}}}};
 const deviceFactory=async({onEvent})=>{calls.opened++;let disposed=false;return {async close(){if(!disposed){disposed=true;calls.closed++}},configurePresenter:async()=>{},present:async()=>{},
   createRecording(){calls.recordings++;let tick=0,released=false;return {start:async()=>{},amplitude:()=>++tick<5?.5:0,markSpeech(){},take:async()=>new Uint8Array(44),async dispose(){if(!released){released=true;calls.released++}}}},
   async createPlayer(){calls.players++;const events=new EventTarget();return {events,async play(){queueMicrotask(()=>{events.dispatchEvent(new Event('ended'));onEvent({type:'playback-ended'})})},stop:async()=>{},destroy:async()=>{}}}}};
 try{
  owner=await createVoiceAssistantOwner({identity:{applicationGenerationId:'app',managerInstanceId:'manager',activationId:'activation'},stateRoot,speech,publish(){},signal:abort.signal,clientFactory:async()=>({operations:sdk,close:async()=>{}}),deviceFactory,modelCatalog:async()=>[{id:'fixture',isDefault:true}],
   customProviderFactory:()=>({async recognize(){calls.customAsr++;return {text:'实际识别文本',additions:{emotion:'happy'}}},async synthesize(){calls.customTts++;return new Uint8Array(44)}}),
   createModel:options=>createChatModel({...options,provider:'compatible',endpoint:'https://fixture.test/chat/completions',resolveCredential:async()=>undefined,fetcher:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'回复已经播报。'}}]})+'\n\ndata: [DONE]\n\n')})});
  await owner.command({action:'host-settings',patch:{personaId:'A',asrSource,ttsSource}});
  await owner.command({action:'settings',patch:{electronExecutable:process.execPath,asrModel:'asr',ttsModel:'tts',ttsVoice:'custom',sampleMs:10,silenceDurationMs:200,petEnabled:true}});
  await owner.command({action:'start'});
  for(let n=0;n<150&&(await owner.state()).playback.completed<1;n++)await delay(10);
  const state=await owner.state();assert.equal(state.playback.completed,1,JSON.stringify({error:state.error,messages:await owner.messages()}));
  assert.equal(calls.hostAsr,asrSource==='host'?1:0);assert.equal(calls.customAsr,asrSource==='custom'?1:0);assert.equal(calls.hostTts,ttsSource==='host'?1:0);assert.equal(calls.customTts,ttsSource==='custom'?1:0);assert.equal(calls.players,1);
  assert.equal((await owner.messages()).filter(item=>item.role==='user').length,1);assert.equal(transcripts.filter(item=>item.kind==='asr').length,1);
  await owner.command({action:'stop'});await owner.dispose();assert.equal(calls.opened,calls.closed);assert.equal(calls.recordings,calls.released);
 }finally{await owner?.dispose();await rm(stateRoot,{recursive:true,force:true})}
});


for (const [asrSource,primaryFails,label] of [
  ['host',false,'selected host recognizer'],
  ['custom',false,'selected realtime recognizer'],
  ['custom',true,'local fallback'],
]) test(
  'Rabi wake submits the first captured turn once via '+label,
  {timeout:15000}, async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'rabi-voice-wake-'));
  const generation = new AbortController();
  const captureId = 'a'.repeat(32);
  const wake = Object.assign(new PassThrough(), {statusCode:200,headers:{'content-type':'application/x-ndjson'}});
  const recording = Object.assign(new PassThrough(), {statusCode:200,headers:{
    'content-type':'application/octet-stream',
    'x-rabispeech-capture-id':captureId,'x-rabispeech-start-sample':'9200','x-rabispeech-sample-rate':'16000',
  }});
  let arm, owner, heard, localOpen = 0, playback = 0, localTranscriptions = 0, hostTranscriptions = 0;
  const modelRequests = [], handoffs = [];
  const recentSpeech = [{text:'刚才说的是测试项目',ageMs:5000}];
  const armed = new Promise(resolve => {arm=resolve});
  const pcmReady = new Promise(resolve => {heard=resolve});
  const sdk = {async call(id) {
    const result=id==='manager.roles.list'?{roles:[{roleId:'A',title:'夜雨'}]}
      :id==='manager.roles.detail'?{config:{speechTriggerKeywords:['夜雨','小夜']}}
      :{document:'测试人格'};
    return {ok:true,data:{code:0,data:result}};
  }, describe:async()=>({operation:{contract:{transport:'http'}}}),invokeOperation:async()=>({ok:true,statusCode:200,body:'{}'})};
  const speech = {
    speechRuntimeControl:{
      async openAssistantWake(aliases, signal){
        assert.deepEqual(aliases,['夜雨','小夜']);
        signal.addEventListener('abort',()=>wake.destroy(),{once:true});
        arm();return wake;
      },
      async openAssistantCapture(signal,cursor){
        assert.deepEqual(cursor,{captureId,sample:9200});
        signal.addEventListener('abort',()=>recording.destroy(),{once:true});
        return recording;
      },
      async setAssistantRealtime(id,enabled){assert.equal(id,captureId);handoffs.push(enabled);},
      async transcribeAssistantAudio(wav){
        assert.equal(wav.toString('ascii',0,4),'RIFF');
        localTranscriptions++;heard(wav.subarray(44,48));
        return {text:'帮我查一下',provider:'fireredasr2'};
      },
    },
    speechControl:{
      personas:()=>[],
      models:async()=>[{id:'host-asr',capability:'asr',enabled:true,available:true}],
      async transcribe(type,bytes,guard){
        guard();hostTranscriptions++;
        assert.match(type,/multipart/);
        assert.match(bytes.toString('utf8'),/host-asr/);
        const audioStart=bytes.indexOf('RIFF');
        assert.ok(audioStart>=0);
        heard(bytes.subarray(audioStart+44,audioStart+48));
        return {status:200,body:Buffer.from(JSON.stringify({text:'帮我查一下'}))};
      },
    },
  };
  try {
    owner = await createVoiceAssistantOwner({
      identity:{applicationGenerationId:'app',managerInstanceId:'manager',activationId:'activation'},stateRoot,speech,
      publish(){},signal:generation.signal,clientFactory:async()=>({operations:sdk,close:async()=>{}}),
      deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{},
        createRecording(){localOpen++;throw Error('A borrowed turn must not open another microphone');},
        async createPlayer(){playback++;const events=new EventTarget();return {events,
          async play(){queueMicrotask(()=>events.dispatchEvent(new Event('ended')))},stop:async()=>{},destroy:async()=>{}};}}),
      modelCatalog:async()=>[{id:'fixture',isDefault:true}],
      customProviderFactory:()=>({
        createAsr({createRecording}){
          const rec=createRecording();
          return {
            createRound(handlers){return handlers},
            async start(handlers){
              if(primaryFails)throw Error('fixture realtime connection failed');
              await rec.start(handlers.onError,{onPcm(bytes){
              heard(bytes);
              handlers.onInterim({text:'帮我查一下'});
              handlers.onFinal({text:'帮我查一下',startTime:0,endTime:500});
            }});handlers.onStart();},
            stop:()=>rec.dispose(),
          };
        },
        async synthesize(){return new Uint8Array(44)},
      }),
      createModel:options=>createChatModel({...options,provider:'compatible',endpoint:'https://fixture.test/chat/completions',
        resolveCredential:async()=>undefined,fetcher:async(_url,init)=>{
          modelRequests.push(JSON.parse(init.body).messages);
          return new Response('data: '+JSON.stringify({choices:[{delta:{content:'收到。'}}]})+'\n\ndata: [DONE]\n\n');
        }}),
    });
    await owner.command({action:'host-settings',patch:{personaId:'A',asrSource,ttsSource:'custom',...(asrSource==='host'?{asrModel:'host-asr'}:{})}});
    await owner.command({action:'settings',patch:{electronExecutable:process.execPath,asrModel:'fixture',ttsModel:'fixture',ttsVoice:'fixture',sampleMs:10,silenceDurationMs:200}});
    await owner.command({action:'host-settings',patch:{wakeEnabled:true}});
    await armed;
    wake.write(JSON.stringify({type:'ready',captureId,sampleRate:16000})+'\n');
    wake.write(JSON.stringify({type:'wake',captureId,sampleRate:16000,aliasIndex:0,replayFromSample:9200,observedThroughSample:18000,recentSpeech})+'\n');
    const bytes=Buffer.from([3,10,6,12]);
    const usesLocalUtterance=primaryFails||asrSource==='host';
    recording.write(usesLocalUtterance?Buffer.alloc(3200,bytes):bytes);
    if(usesLocalUtterance){await delay(150);recording.write(Buffer.alloc(3200));}
    assert.deepEqual(await pcmReady,bytes);
    for(let check=0;check<120&&!playback;check++)await delay(10);
    assert.equal(localOpen,0);
    assert.equal(hostTranscriptions,asrSource==='host'?1:0);
    assert.equal(localTranscriptions,primaryFails?1:0);
    assert.equal((await owner.state()).hostSettings.wake.phase,primaryFails?'local-fallback':'active');
    assert.equal(playback,1,JSON.stringify({state:(await owner.state()).error,messages:await owner.messages()}));
    assert.deepEqual((await owner.messages()).filter(item=>item.role==='user').map(item=>item.text),['帮我查一下']);
    const first = JSON.parse(modelRequests[0].at(-1).content);
    assert.deepEqual(first.recentSpeech,recentSpeech);
    await owner.command({action:'text',text:'第二句',requestId:'second-turn'});
    for(let check=0;check<120&&modelRequests.length<2;check++)await delay(10);
    assert.equal(modelRequests.length,2);
    assert.ok(!modelRequests[1].some(item=>item.content.includes('刚才说的是测试项目')));
    await owner.command({action:'stop'});
    assert.equal((await owner.state()).hostSettings.wake.phase,'armed');
    assert.deepEqual(handoffs,primaryFails?[]:[true,false]);
  } finally {
    await owner?.dispose();await rm(stateRoot,{recursive:true,force:true});
  }
});
