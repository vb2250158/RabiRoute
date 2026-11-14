import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTts, encodeAsr, decodeFrame } from '../src/volcano-codec.mjs';
import { openVolcanoTts } from '../src/volcano-tts.mjs';
import { createVolcanoAsr } from '../src/volcano-asr.mjs';
import { openDesktopVoiceServices } from '../src/services.mjs';
import { createVoiceInteraction } from '@rabilink/assistant-runtime/voice';
const flush = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
const integer = n => { const b=Buffer.alloc(4);b.writeInt32BE(n);return b; };
const response = (event,id,payload=Buffer.from('{}'),type=9) => Buffer.concat([Buffer.from([0x11,type*16+4,type===11?0:16,0]),integer(event),integer(Buffer.byteLength(id)),Buffer.from(id),integer(payload.length),payload]);
const asrResponse = result => { const b=Buffer.from(JSON.stringify({result}));return Buffer.concat([Buffer.from([0x11,0x90,0x10,0]),integer(b.length),b]); };

test('TTS abort while awaiting connection acknowledgement never opens a late session',async()=>{
  const controller=new AbortController(),sent=[];let receive,closed=0;
  const opening=openVolcanoTts({endpoint:'wss://example.com',voice:'fixture',signal:controller.signal,onAudio:()=>assert.fail('late audio'),
    connect:async({onMessage})=>{receive=onMessage;return {close:async()=>{closed++},send:async bytes=>sent.push(decodeFrame(bytes,{tts:true}).event)}}});
  const rejected=assert.rejects(opening,/CLOSED/);
  await flush();assert.deepEqual(sent,[1]);controller.abort();
  await receive(response(50,'connection'));await rejected;
  assert.deepEqual(sent,[1]);assert.equal(closed,1);
});

test('TTS closes a socket returned after an early connection error or abort',async()=>{
  for(const cause of ['error','abort']){
    const controller=new AbortController();let closed=0,sent=0,passedSignal;
    await assert.rejects(openVolcanoTts({endpoint:'wss://example.com',voice:'fixture',signal:controller.signal,onAudio:()=>{},
      connect:async({onError,signal})=>{passedSignal=signal;if(cause==='error')onError(Error('EARLY'));else controller.abort();await flush();return {close:async()=>{closed++},send:async()=>{sent++}}}}),/CLOSED/);
    assert.equal(passedSignal,controller.signal);assert.equal(closed,1);assert.equal(sent,0);
  }
});

test('protocol frames match fixed byte layout and reject truncated or trailing data',()=>{
  assert.equal(encodeTts(1).toString('hex'),'1114100000000001000000027b7d');
  assert.equal(encodeAsr(Buffer.from([1,2]),{audio:true,last:true}).toString('hex'),'11220000000000020102');
  assert.equal(decodeFrame(response(50,'connection'),{tts:true}).id,'connection');
  assert.throws(()=>decodeFrame(Buffer.from([0x11,0x90,0x10,0,0,0,0,100])),/TRUNCATED/);
  assert.throws(()=>decodeFrame(Buffer.concat([asrResponse({text:'hi'}),Buffer.from([0])])),/TRAILING/);
});

test('one TTS session accepts deltas and yields PCM before finish; cancel ignores late frames',async()=>{
  const sent=[],audio=[];let receive,session,closed=0;
  const stream=await openVolcanoTts({endpoint:'wss://example.com',headers:{},voice:'fixture',onAudio:bytes=>audio.push(bytes),
    connect:async({onMessage})=>{receive=onMessage;return {close:async()=>{closed++},send:async bytes=>{
      const msg=decodeFrame(bytes,{tts:true});sent.push(msg.event);session=msg.id||session;
      const expected=({1:50,100:150,101:151,2:52})[msg.event];
      if(expected)queueMicrotask(()=>void receive(response(expected,msg.id||'connection')));
      if(msg.event===200)queueMicrotask(()=>void receive(response(352,session,Buffer.from([0,0,1,0]),11)));
    }}}});
  await stream.append('你好');await flush();assert.equal(audio.length,1);assert.ok(!sent.includes(102));
  await stream.append('。第二句');await flush();assert.equal(sent.filter(e=>e===100).length,1);
  await stream.close();await stream.finished.catch(()=>{});
  await receive(response(352,session,Buffer.from([0,0]),11));
  assert.equal(audio.length,2);assert.ok(sent.includes(101));assert.equal(closed,1);
});

test('streaming ASR sends microphone PCM before silence and deduplicates final utterances',async()=>{
  let capture,receive,disposed=0,closed=0;const frames=[],finals=[],interims=[];
  const asr=createVolcanoAsr({settings:()=>({sampleMs:50,silenceThreshold:.01,silenceDurationMs:700}),connection:async()=>({}),
    createRecording:()=>({start:async(_fail,options)=>{capture=options.onPcm},amplitude:()=>0,dispose:async()=>{disposed++}}),
    connect:async({onMessage})=>{receive=onMessage;return {send:async b=>frames.push(decodeFrame(b)),close:async()=>{closed++}}}});
  const round=asr.createRound({onFinal:value=>finals.push(value.text),onInterim:value=>interims.push(value.text)});
  await asr.start(round);capture(Buffer.alloc(2048));capture(Buffer.alloc(2048));await flush();
  assert.equal(frames[1].type,2);assert.equal(frames[1].payload.length,4096);
  receive(asrResponse({utterances:[{text:'你好',definite:false,end_time:100}]}));
  const result=asrResponse({utterances:[{text:'你好。',definite:true,start_time:0,end_time:200}]});receive(result);receive(result);
  assert.deepEqual(finals,['你好。']);assert.deepEqual(interims,['你好']);
  await asr.stop(round);capture(Buffer.alloc(4096));await flush();assert.equal(frames.length,2);assert.equal(disposed,1);assert.equal(closed,1);
});

test('shared voice streams immediately and barge-in preserves text while releasing all audio',async()=>{
  let handlers,audioCallback,played=0,stopped=0,destroyed=0,deviceClosed=0,providerClosed=0,appends=0;
  const signals=[],events=new EventTarget();let resolveFinished;
  const services=await openDesktopVoiceServices({signal:new AbortController().signal,settings:{},
    openDevice:async()=>({close:async()=>{deviceClosed++},createStreamPlayer:async()=>({events,play:async()=>{played++},append:async()=>{appends++},finish:async()=>{},stop:async()=>{stopped++},destroy:async()=>{destroyed++}})}),
    createAsr:()=>({createRound:h=>(handlers=h,{}),start:()=>handlers.onStart(),stop:async()=>{}}),
    openSpeechStream:async({signal,onAudio})=>{audioCallback=onAudio;signals.push(signal);return {append:async()=>onAudio(Buffer.alloc(2)),finish:async()=>resolveFinished({duration:.01}),finished:new Promise(resolve=>resolveFinished=resolve),close:async()=>{providerClosed++}}},
  });
  const voice=createVoiceInteraction({runtime:services.runtime,onInput:()=>{}});
  voice.activate();const reply=voice.beginResponse();reply.append('第一段');await flush();
  assert.equal(played,1);assert.equal(appends,1);assert.equal(providerClosed,0);
  handlers.onSpeechStart();reply.append('后台继续完成的文字');reply.finish();await flush();
  await audioCallback(Buffer.alloc(2));assert.equal(appends,1);assert.ok(signals[0].aborted);
  assert.equal(reply.getState().text,'第一段后台继续完成的文字');
  voice.dispose();await services.dispose();assert.equal(stopped,1);assert.equal(destroyed,1);assert.equal(providerClosed,1);assert.equal(deviceClosed,1);
});
