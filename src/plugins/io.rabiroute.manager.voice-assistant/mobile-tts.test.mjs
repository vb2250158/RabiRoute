import test from 'node:test';
import assert from 'node:assert/strict';
import {createMobileTts,mobileCustomTtsReady,mobileTtsAudioLimit} from './src/mobile-tts.mjs';
import {createVoiceAssistantOperations} from './src/operations.mjs';
import {createSpeechProviders} from '@rabilink/desktop-voice-service/speech-providers';
import {decodeFrame} from '../../../packages/desktop-voice-service/src/volcano-codec.mjs';
import {initialAssistantSettings} from '@rabilink/desktop-voice-service/settings';

function wav(pcm=Buffer.from([1,0,2,0])){
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);return Buffer.concat([header,pcm]);
}
function fixture({synthesize=async()=>wav(),provider,config={}}={}){
  let session='session',settings={...initialAssistantSettings(),ttsProvider:'compatible',ttsEndpoint:'https://fixture.test/speech',ttsModel:'fixture',ttsVoice:'fixture',voiceEnabled:true,...config},ready=true,current=true;
  const rows=[{id:'reply',role:'assistant',status:'generating',text:'第一句。第二句。尾段',expression:{style:'warm'}}],details={speechSegmentEnds:[],expression:{style:'warm'}},trace=[],listeners=new Set();
  const conversation={getSessionId:()=>session,messages:()=>rows,messageDetails:()=>details,recordSpeechDetails:(id,event)=>trace.push({id,event}),subscribe(listener){listeners.add(listener);listener();return()=>listeners.delete(listener)}};
  const controller=new AbortController(),calls=[];
  const service=createMobileTts({conversation,settings:()=>settings,ready:async()=>ready,createProviders:config=>provider??{synthesize:(...args)=>{calls.push({config,args});return synthesize(...args)}},assertCurrent(){if(!current)throw Error('ASSISTANT_CONTEXT_CHANGED')},signal:controller.signal});
  return {service,rows,details,calls,trace,controller,publish:()=>{for(const listener of listeners)listener()},listenerCount:()=>listeners.size,request:(input='第一句。',extra={})=>({sessionId:'session',responseId:'reply',input,...extra}),changeSession:()=>session='other',changeSettings:()=>settings={...settings,ttsVoice:'changed'},setReady:value=>ready=value,retire:()=>current=false};
}

test('mobile custom TTS readiness follows custom source, saved credential and actual connection fields',()=>{
  const config={ttsProvider:'volcengine',ttsEndpoint:'wss://openspeech.bytedance.com/api/v3/tts/bidirection',ttsModel:'seed-tts-2.0',ttsVoice:'fixture',ttsResourceId:'seed-tts-2.0',voiceEnabled:true};
  assert.equal(mobileCustomTtsReady('custom',config,{configured:true}),true);
  for(const [source,value,credential] of [['host',config,{configured:true}],['custom',config,{configured:false}],['custom',{...config,ttsVoice:''},{configured:true}],['custom',{...config,ttsResourceId:''},{configured:true}],['custom',{...config,voiceEnabled:false},{configured:true}],['custom',{...config,ttsEndpoint:'http://outside.test'},{configured:true}]])assert.equal(mobileCustomTtsReady(source,value,credential),false);
  assert.equal(mobileCustomTtsReady('custom',{...config,ttsProvider:'compatible',ttsEndpoint:'http://127.0.0.1:19000/speech'},{configured:false}),true);
  assert.equal(mobileCustomTtsReady('custom',{...config,ttsProvider:'compatible',ttsEndpoint:'https://api.openai.com/v1/audio/speech'},{configured:false}),false);
});

test('only current authoritative assistant canonical segments, including trusted tool boundaries, are synthesized',async()=>{
  const f=fixture();
  try{
    await assert.rejects(f.service.synthesize(f.request('第一')),/SEGMENT_INVALID/);
    await assert.rejects(f.service.synthesize(f.request('第一句。第二句。')),/SEGMENT_INVALID/);
    await assert.rejects(f.service.synthesize(f.request('尾段')),/SEGMENT_INVALID/);
    await assert.rejects(f.service.synthesize(f.request('第一句。',{responseId:'missing'})),/REPLY_EXPIRED/);
    await assert.rejects(f.service.synthesize(f.request('第一句。',{sessionId:'other'})),/CONTEXT_CHANGED/);
    await assert.rejects(f.service.synthesize({...f.request(),ttsEndpoint:'https://attacker.test'}),/REQUEST_INVALID/);
    await assert.rejects(f.service.synthesize(f.request('x'.repeat(16001))),/TEXT_INVALID/);
    f.rows[0].role='user';await assert.rejects(f.service.synthesize(f.request()),/REPLY_EXPIRED/);f.rows[0].role='assistant';
    f.rows[0].notice=true;await assert.rejects(f.service.synthesize(f.request()),/REPLY_EXPIRED/);delete f.rows[0].notice;
    assert.equal(f.calls.length,0);
    assert.deepEqual(await f.service.synthesize(f.request()),wav());assert.deepEqual(f.calls[0].args[2],{style:'warm'});
    f.details.speechSegmentEnds=[f.rows[0].text.length];await f.service.synthesize(f.request('尾段'));
    assert.equal(f.calls.length,2);
  }finally{await f.service.dispose()}
  assert.equal(f.listenerCount(),0);
});

test('matching in-flight calls share one charge and a cancelled waiter cannot cancel another',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture({synthesize:async(_text,signal)=>{await gate;signal.throwIfAborted();return wav()}}),cancel=new AbortController();
  try{
    const first=f.service.synthesize(f.request(),cancel.signal),second=f.service.synthesize(f.request());
    const rejected=assert.rejects(first,/cancelled/);cancel.abort(Error('cancelled'));await rejected;
    await assert.rejects(f.service.synthesize(f.request('第二句。')),/BUSY/);
    release();assert.deepEqual(await second,wav());assert.deepEqual(await f.service.synthesize(f.request()),wav());assert.equal(f.calls.length,1);
    // Identical adjacent sentences reuse the same audio; caller offsets remain presentation-owned.
    f.rows[0].text='第一句。第一句。';assert.deepEqual(await f.service.synthesize(f.request()),wav());assert.equal(f.calls.length,1);
  }finally{release();await f.service.dispose()}
});

test('failed or invalid provider outcomes retain their original failure without paid replay',async()=>{
  for(const outcome of ['failure','invalid','large']){
    const f=fixture({synthesize:async()=>{if(outcome==='failure')throw Error('SPEECH_PROVIDER_HTTP_403');return outcome==='invalid'?Buffer.from('not audio'):Buffer.alloc(mobileTtsAudioLimit+1)}});
    try{for(let n=0;n<2;n++)await assert.rejects(f.service.synthesize(f.request()),outcome==='failure'?/403/:/AUDIO/);assert.equal(f.calls.length,1)}finally{await f.service.dispose()}
  }
});

test('bounded cache retains no-recharge tombstones and canonical per-row request budget',async()=>{
  const f=fixture({synthesize:async()=>wav(Buffer.alloc(7*1024*1024-44))});
  f.rows[0].text='一。二。三。四。五。';
  try{
    for(const input of ['一。','二。','三。','四。','五。'])await f.service.synthesize(f.request(input));
    await assert.rejects(f.service.synthesize(f.request('一。')),/RESULT_EXPIRED/);assert.equal(f.calls.length,5);
  }finally{await f.service.dispose()}
  const budget=fixture();budget.rows[0].text=Array.from({length:129},(_,n)=>n+'。').join('');
  try{for(let n=0;n<128;n++)await budget.service.synthesize(budget.request(n+'。'));await assert.rejects(budget.service.synthesize(budget.request('128。')),/SEGMENT_LIMIT/);assert.equal(budget.calls.length,128)}finally{await budget.service.dispose()}
});

test('durable chats can synthesize beyond 256 turns while older replies and their late audio expire',async()=>{
  const f=fixture();
  try{
    for(let n=0;n<300;n++){
      const id='reply-'+n;f.rows.push({id,role:'assistant',text:'当前回复。',status:'completed'});
      await f.service.synthesize(f.request('当前回复。',{responseId:id}));
      await assert.rejects(f.service.synthesize(f.request('当前回复。',{responseId:'reply-'+(n-1)})),/REPLY_EXPIRED/);
    }
    assert.equal(f.calls.length,300);
  }finally{await f.service.dispose()}
  let release;const gate=new Promise(resolve=>release=resolve),late=fixture({synthesize:async()=>{await gate;return wav()}});
  const work=late.service.synthesize(late.request()),rejected=assert.rejects(work,/CONTEXT_CHANGED/);
  await new Promise(resolve=>setImmediate(resolve));late.rows.push({id:'new-reply',role:'assistant',status:'generating',text:''});release();await rejected;await late.service.dispose();
});

test('session, configuration, reply and activation changes reject late bytes and old cached audio',async()=>{
  for(const change of ['changeSession','changeSettings','retire','reply']){
    let release;const gate=new Promise(resolve=>release=resolve),f=fixture({synthesize:async()=>{await gate;return wav()}});
    const work=f.service.synthesize(f.request());const rejected=assert.rejects(work,change==='reply'?/REPLY_CHANGED/:/CONTEXT_CHANGED/);
    await new Promise(resolve=>setImmediate(resolve));if(change==='reply')f.rows[0].text='不同回复。';else f[change]();release();await rejected;await f.service.dispose();
  }
  const f=fixture();try{await f.service.synthesize(f.request());f.changeSettings();await f.service.synthesize(f.request());assert.equal(f.calls.length,2);f.service.invalidate();await f.service.synthesize(f.request());assert.equal(f.calls.length,3);f.rows[0].expression={style:'changed'};await f.service.synthesize(f.request());assert.equal(f.calls.length,4)}finally{await f.service.dispose()}
});

test('provider supports compatible WAV and known OpenAI PCM via saved adapters, never client settings',async()=>{
  for(const openai of [false,true]){
    const sent=[],config={ttsProvider:'compatible',ttsEndpoint:openai?'https://api.openai.com/v1/audio/speech':'https://fixture.test/speech',ttsModel:openai?'gpt-4o-mini-tts':'fixture',ttsVoice:'alloy',ttsDynamicExpression:openai};
    const provider=createSpeechProviders({config:{...initialAssistantSettings(),...config},credentials:{resolve:async()=> 'fixture-key'},fetcher:async(url,input)=>{sent.push({url,body:JSON.parse(input.body)});return new Response(openai?Buffer.from([1,0,2,0]):wav())}});
    const f=fixture({provider,config});try{assert.deepEqual(await f.service.synthesize(f.request()),wav());assert.equal(sent[0].body.input,'第一句。');assert.equal(sent[0].body.response_format,openai?'pcm':'wav');assert.equal(sent[0].url,config.ttsEndpoint)}finally{await f.service.dispose()}
  }
});

const integer=value=>{const bytes=Buffer.alloc(4);bytes.writeInt32BE(value);return bytes};
const frame=(event,id,body=Buffer.from('{}'),type=9)=>Buffer.concat([Buffer.from([0x11,type*16+4,type===11?0:16,0]),integer(event),integer(Buffer.byteLength(id)),Buffer.from(id),integer(body.length),body]);
test('formal configured Volcano seed-tts-2.0 family uses existing authenticated protocol and returns bounded WAV',async()=>{
  const wire=[],traces=[],config={...initialAssistantSettings(),ttsProvider:'volcengine',ttsEndpoint:'wss://openspeech.bytedance.com/api/v3/tts/bidirection',ttsResourceId:'seed-tts-2.0',ttsModel:'seed-tts-2.0',ttsVariant:'seed-tts-2.0-standard',ttsVoice:'fixture',ttsEncoding:'pcm',ttsSampleRate:24000,ttsDynamicExpression:true};
  let receives,session,closed=0;
  const provider=createSpeechProviders({config,credentials:{resolve:async(kind,endpoint,provider)=>{assert.equal(kind,'tts');assert.equal(endpoint,config.ttsEndpoint);assert.equal(provider,'volcengine');return 'fixture-only-key'}},connect:async options=>{
    assert.equal(options.headers['X-Api-Key'],'fixture-only-key');assert.equal(options.headers['X-Api-Resource-Id'],'seed-tts-2.0');receives=options.onMessage;
    return {close:async()=>{closed++},async send(bytes){const request=decodeFrame(bytes,{tts:true});wire.push(request);session=request.id||session;const expected=({1:50,100:150,101:151,2:52,102:152})[request.event];if(request.event===200)queueMicrotask(()=>receives(frame(352,session,Buffer.from([1,0,2,0]),11)));if(expected)queueMicrotask(()=>receives(frame(expected,request.id||'connection')))}};
  }});
  const f=fixture({provider,config});
  try{
    assert.deepEqual(await f.service.synthesize(f.request()),wav());assert.equal(wire.filter(x=>x.event===100).length,1);assert.equal(wire.find(x=>x.event===200).data.req_params.text,'第一句。');assert.equal(wire.find(x=>x.event===100).data.req_params.audio_params.format,'pcm');assert.ok(f.trace.some(x=>x.event.stage==='accepted'));assert.ok(!JSON.stringify(f.trace).includes('fixture-only-key'));assert.equal(closed,1);
  }finally{await f.service.dispose()}
});

test('mobile TTS operation returns raw WAV and safe errors through the accepted owner',async()=>{
  let calls=0,accepted=0;const signal=new AbortController().signal;
  const operation=createVoiceAssistantOperations({async synthesizeMobile(body,passedSignal){calls++;assert.equal(passedSignal,signal);if(body.input==='fail')throw Error('private endpoint and key');return wav()}},async work=>{accepted++;return work()}).find(item=>item.contract.operationId==='manager.voice-assistant.mobile-tts');
  const result=await operation.handler({body:{sessionId:'session',responseId:'reply',input:'一句。'},signal});assert.equal(result.status,200);assert.equal(result.headers['content-type'],'audio/wav');assert.deepEqual(result.body,wav());
  const failed=await operation.handler({body:{input:'fail'},signal});assert.deepEqual(failed,{status:409,body:{code:-1,message:'MOBILE_TTS_FAILED'}});assert.equal(calls,2);assert.equal(accepted,2);
});
