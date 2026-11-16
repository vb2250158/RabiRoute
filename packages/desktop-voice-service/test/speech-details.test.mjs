import test from 'node:test';import assert from 'node:assert/strict';
import {safeSpeechDetails,asrMessageDetails} from '../src/speech-details.mjs';
import {initialAssistantSettings} from '../src/assistant-settings.mjs';
import {createVolcanoAsr} from '../src/volcano-asr.mjs';
import {openVolcanoTts} from '../src/volcano-tts.mjs';
import {decodeFrame} from '../src/volcano-codec.mjs';
const integer=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b};
const response=(event,id)=>Buffer.concat([Buffer.from([0x11,0x94,0x10,0]),integer(event),integer(Buffer.byteLength(id)),Buffer.from(id),integer(2),Buffer.from('{}')]);
test('message diagnostics redact credentials and audio and bound large or cyclic values',()=>{
 const value={request:{headers:{authorization:'private'},apiKey:'private',audio:'private'},result:{emotion:'happy',words:Array.from({length:100},()=>({text:'字'}))},large:'x'.repeat(50000)};value.self=value;
 const json=JSON.stringify(safeSpeechDetails(value));assert.ok(!json.includes('private'));assert.ok(json.includes('happy'));assert.ok(json.length<60000);assert.ok(json.includes('已截断'));
 assert.equal(safeSpeechDetails(JSON.parse('{"__proto__":{"token":"private"}}')).__proto__,'[已隐藏]');
});
test('ASR final carries the actual request and provider fields without dropping additional scores or words',async()=>{
 let receive;const finals=[];const config={...initialAssistantSettings(),asrMode:'volcengine',asrEnableEmotionDetection:true};
 const asr=createVolcanoAsr({settings:()=>config,connection:async()=>({}),createRecording:()=>({start:async()=>{},amplitude:()=>0,dispose:async()=>{}}),connect:async({onMessage})=>{receive=onMessage;return{send:async()=>{},close:async()=>{}}}});
 const round=asr.createRound({onFinal:value=>finals.push(value)});try{
  await asr.start(round);const payload=Buffer.from(JSON.stringify({result:{utterances:[{text:'我很开心。',definite:true,start_time:0,end_time:1000,additions:{emotion:'happy',emotion_score:'0.87',gender:'female'},words:[{text:'开心',start_time:400,end_time:900}]}]}}));
  receive(Buffer.concat([Buffer.from([0x11,0x90,0x10,0]),integer(payload.length),payload]));
  const details=asrMessageDetails(config,finals[0]);assert.equal(details.request.enable_emotion_detection,true);assert.equal(details.result.additions.emotion_score,'0.87');assert.equal(details.result.words[0].text,'开心');
  config.asrEnableEmotionDetection=false;assert.ok(details.features.some(v=>v.key==='asrEnableEmotionDetection'));
 }finally{await asr.stop(round)}
});
test('TTS diagnostics match serialized parameters, observe acceptance and retain actual text on interruption',async()=>{
 const seen=[],wire=[];let receive;
 const stream=await openVolcanoTts({endpoint:'wss://example.test',voice:'voice',requestParams:{speaker:'voice',audio_params:{format:'pcm',sample_rate:24000,speech_rate:-5},additions:'{"context_texts":["温柔"]}'},onAudio(){},onRequest:event=>seen.push(event),connect:async({onMessage})=>{receive=onMessage;return{close:async()=>{},send:async bytes=>{const msg=decodeFrame(bytes,{tts:true});wire.push(msg);const expected=({1:50,100:150,101:151,2:52})[msg.event];if(expected)queueMicrotask(()=>receive(response(expected,msg.id||'connection')))}}}});
 await stream.append('已经发送。');await stream.close();await stream.finished.catch(()=>{});
 assert.deepEqual(seen.find(v=>v.stage==='sent').parameters,wire.find(v=>v.event===100).data.req_params);
 assert.ok(seen.some(v=>v.stage==='accepted'));assert.equal(seen.at(-1).stage,'cancelled');assert.equal(seen.at(-1).textSent,'已经发送。');
});
import {openDesktopVoiceServices} from '../src/services.mjs';
import {createVoiceInteraction} from '@rabilink/assistant-runtime/voice';

test('response ownership reaches actual speech requests and interruption events even if diagnostics fail',async()=>{
 const seen=[],events=[];let handlers,closed=0;
 const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve()};
 const services=await openDesktopVoiceServices({signal:new AbortController().signal,settings:{ttsProvider:'volcengine',ttsModel:'seed-tts-2.0'},
  openDevice:async()=>({close:async()=>{closed++},createStreamPlayer:async()=>({events:new EventTarget(),play:async()=>{},append:async()=>{},finish:async()=>{},stop:async()=>{},destroy:async()=>{}})}),
  createAsr:()=>({createRound:h=>(handlers=h,{}),start:()=>handlers.onStart(),stop:async()=>{}}),
  onSpeechRequest:event=>{seen.push(event);throw Error('DIAGNOSTIC_ONLY')},
  openSpeechStream:async({onRequest,onAudio})=>{onRequest({stage:'sent',parameters:{speaker:'voice'}});onRequest({stage:'accepted'});return{append:async()=>onAudio(Buffer.alloc(2)),finish:async()=>{},close:async()=>{},finished:new Promise(()=>{})}},
 });
 const voice=createVoiceInteraction({runtime:services.runtime,onInput(){},onEvent:e=>events.push(e)});
 try{voice.activate();const response=voice.beginResponse({id:'reply-1',speech:{expression:{style:'轻快'}}});response.append('开始播放。');const deadline=Date.now()+2000;while(seen.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(seen.length,2);assert.ok(seen.every(e=>e.responseId==='reply-1'));assert.equal(seen[0].requestId,seen[1].requestId);assert.equal(seen[0].expression.style,'轻快');
  handlers.onSpeechStart();assert.equal(response.getState().suppressed,false);
  handlers.onInterim({text:'你'});response.append('声音打断，文字继续。');response.finish();await flush();
  assert.ok(events.some(e=>e.type==='playback'&&e.event.type==='cancelled'&&e.event.responseId==='reply-1'));assert.match(response.getState().text,/文字继续/);
 }finally{voice.dispose();await services.dispose()}
 assert.equal(closed,1);
});
