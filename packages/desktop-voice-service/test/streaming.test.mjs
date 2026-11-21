import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTts, encodeAsr, decodeFrame } from '../src/volcano-codec.mjs';
import { openVolcanoTts } from '../src/volcano-tts.mjs';
import { createVolcanoAsr } from '../src/volcano-asr.mjs';
import { openDesktopVoiceServices } from '../src/services.mjs';
import { createVoiceInteraction } from '@rabilink/assistant-runtime/voice';
const flush = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
const until=async predicate=>{const deadline=Date.now()+2000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate(),'expected asynchronous speech receipt')};
const integer = n => { const b=Buffer.alloc(4);b.writeInt32BE(n);return b; };
const response = (event,id,payload=Buffer.from('{}'),type=9) => Buffer.concat([Buffer.from([0x11,type*16+4,type===11?0:16,0]),integer(event),integer(Buffer.byteLength(id)),Buffer.from(id),integer(payload.length),payload]);
const asrResponse = result => { const b=Buffer.from(JSON.stringify({result}));return Buffer.concat([Buffer.from([0x11,0x90,0x10,0]),integer(b.length),b]); };

test('TTS cleanup observes a rejected acknowledgement while its send is still pending',async()=>{
  let receive,closed=0;
  const stream=await openVolcanoTts({endpoint:'wss://example.com',voice:'fixture',onAudio:()=>assert.fail('symbol-only response has no audio'),
    connect:async({onMessage})=>{receive=onMessage;return {close:async()=>{closed++},send:async bytes=>{
      const msg=decodeFrame(bytes,{tts:true});
      if(msg.event===2){await new Promise(resolve=>setTimeout(resolve,25));return;}
      const expected=({1:50,100:150,102:152})[msg.event];
      if(expected)queueMicrotask(()=>void receive(response(expected,msg.id||'connection')));
    }}}});
  await stream.append('***');await stream.finish();
  assert.equal((await stream.finished).duration,0);
  await stream.close();
  // Let the pending send settle; node:test also checks for unhandled rejections.
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(closed,1);
});

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
  const round=asr.createRound({onFinal:value=>finals.push([value.text,value.endSample]),onInterim:value=>interims.push(value.text)});
  await asr.start(round);capture(Buffer.alloc(2048));capture(Buffer.alloc(2048));await flush();
  assert.equal(frames[1].type,2);assert.equal(frames[1].payload.length,4096);
  receive(asrResponse({utterances:[{text:'你好',definite:false,end_time:100}]}));
  const result=asrResponse({utterances:[{text:'你好。',definite:true,start_time:0,end_time:100}]});receive(result);receive(result);
  receive(asrResponse({utterances:[{text:'超出已送音频。',definite:true,start_time:100,end_time:200}]}));
  assert.deepEqual(finals,[['你好。',1600],['超出已送音频。',undefined]]);assert.deepEqual(interims,['你好']);
  capture(Buffer.alloc(100));await asr.finish(round);await asr.finish(round);assert.equal(frames.at(-1).last,true);assert.equal(frames.at(-1).payload.length,100);
  await asr.stop(round);capture(Buffer.alloc(4096));await flush();assert.equal(frames.length,3);assert.equal(disposed,1);assert.equal(closed,1);
});

test('ASR drains a batched microphone delivery without mistaking it for a blocked network',async()=>{
  let capture;const frames=[],errors=[];
  const asr=createVolcanoAsr({settings:()=>({sampleMs:50,silenceThreshold:.01,silenceDurationMs:700}),connection:async()=>({}),
    createRecording:()=>({start:async(_fail,options)=>{capture=options.onPcm},amplitude:()=>0,dispose:async()=>{}}),
    connect:async()=>({send:async bytes=>frames.push(decodeFrame(bytes)),close:async()=>{}})});
  const round=asr.createRound({onError:error=>errors.push(error.message)});await asr.start(round);
  const pcm=Buffer.concat(Array.from({length:64},(_,index)=>Buffer.alloc(4096,index)));
  capture(pcm);await asr.finish(round);
  assert.deepEqual(errors,[]);assert.equal(frames.at(-1).last,true);
  assert.deepEqual(Buffer.concat(frames.filter(frame=>frame.type===2).map(frame=>frame.payload)),pcm);
  await asr.stop(round);
});

test('ASR still closes a genuinely blocked audio send queue',async()=>{
  let capture,release;const gate=new Promise(resolve=>release=resolve),errors=[];let sent=0,disposed=0;
  const asr=createVolcanoAsr({settings:()=>({sampleMs:50,silenceThreshold:.01,silenceDurationMs:700}),connection:async()=>({}),
    createRecording:()=>({start:async(_fail,options)=>{capture=options.onPcm},amplitude:()=>0,dispose:async()=>{disposed++}}),
    connect:async()=>({send:async()=>{if(sent++>0)await gate},close:async()=>{release()}})});
  const round=asr.createRound({onError:error=>errors.push(error.message)});await asr.start(round);
  capture(Buffer.alloc(4096));await flush();capture(Buffer.alloc(16000*2*6));
  await until(()=>errors.length===1);
  await asr.stop(round);assert.deepEqual(errors,['SPEECH_SEND_BACKLOG']);assert.equal(disposed,1);
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
  voice.activate();const reply=voice.beginResponse();reply.append('第一段');await until(()=>played===1&&appends===1);
  assert.equal(played,1);assert.equal(appends,1);assert.equal(providerClosed,0);
  handlers.onSpeechStart();assert.equal(signals[0].aborted,false);
  reply.append('首字前继续播报');await until(()=>appends===2);assert.equal(appends,2);
  handlers.onInterim({text:'停'});reply.append('后台继续完成的文字');reply.finish();await flush();
  await audioCallback(Buffer.alloc(2));assert.equal(appends,2);assert.ok(signals[0].aborted);
  assert.equal(reply.getState().text,'第一段首字前继续播报后台继续完成的文字');
  voice.dispose();await services.dispose();assert.equal(stopped,1);assert.equal(destroyed,1);assert.equal(providerClosed,1);assert.equal(deviceClosed,1);
});
