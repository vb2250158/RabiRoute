import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createVoiceAssistantOwner} from './src/runtime.mjs';import {createChatModel} from '@rabilink/desktop-voice-service/chat-model';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
