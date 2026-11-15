import test from 'node:test';import assert from 'node:assert/strict';
import {openDesktopVoiceServices} from '../src/services.mjs';
import {openPcmBuffer} from '../src/pcm-buffer.mjs';
import {mkdtemp,readdir,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const tick=()=>new Promise(r=>setImmediate(r));
async function settled(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PCM_TEST_HANDSHAKE_TIMEOUT')),5000)})])}finally{clearTimeout(timer)}}

test('playback backpressure never blocks receipt of following subtitle/control frames; completion waits for all PCM',async()=>{
 let release,played=false,subtitleReceived=false,providerFinished=false,finishCount=0,resolveProvider;
 const gate=new Promise(r=>release=r),providerDone=new Promise(r=>resolveProvider=r),events=new EventTarget(),received=[],cues=[];
 const services=await openDesktopVoiceServices({settings:{},signal:new AbortController().signal,openDevice:async()=>({close:async()=>{},createStreamPlayer:async()=>({events,append:async bytes=>{await gate;received.push(Buffer.from(bytes));},finish:async()=>finishCount++,play(){played=true},stop:async()=>release(),destroy:async()=>{}})}),
 createAsr:()=>({createRound(){return{}},start(){},stop(){}}),openSpeechStream:async options=>({finished:providerDone,async append(){await options.onAudio(Buffer.from([1,0,2,0]));subtitleReceived=true;options.onTiming([{charIndex:0,charLength:2,startTime:0,endTime:.2,mode:'word'}]);},async finish(){providerFinished=true;resolveProvider({duration:.2})},async close(){resolveProvider({duration:.2})}})});
 try{
  const job=await services.runtime.tts.openStream({onCue:cue=>cues.push(cue)});
  // Await the actual disk acceptance, while deliberately withholding player
  // capacity. Counting event-loop ticks races asynchronous filesystem work.
  const append=job.input.append('你好');await settled(append);
  assert.equal(subtitleReceived,true,'metadata must be readable while the player is blocked');assert.equal(cues.length,0,'metadata is not a played receipt');
  await job.input.finish();let taskDone=false;const completion=job.task.finished.then(()=>taskDone=true);await tick();assert.equal(providerFinished,true);assert.equal(taskDone,false);assert.equal(finishCount,0);
  release();await append;await completion;assert.deepEqual(Buffer.concat(received),Buffer.from([1,0,2,0]));assert.equal(finishCount,1);
  events.dispatchEvent(Object.assign(new Event('progress'),{seconds:.1}));assert.equal(cues.length,1);assert.equal(played,false);
 }finally{release();await services.dispose()}
});

test('concurrent PCM writes drain in order and leave no recording after disposal',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'rabi-pcm-test-')),received=[];
 const queue=await openPcmBuffer({directory,sampleRate:24000,append:async bytes=>received.push(Buffer.from(bytes))});
 try{
  const first=queue.append(Buffer.alloc(130000,1)),second=queue.append(Buffer.alloc(17000,2));
  await queue.finish();await Promise.all([first,second]);
  assert.deepEqual(Buffer.concat(received),Buffer.concat([Buffer.alloc(130000,1),Buffer.alloc(17000,2)]));
  await assert.rejects(queue.append(Buffer.alloc(2)),/CLOSED/);
 }finally{await queue.dispose();assert.deepEqual(await readdir(directory),[]);await rmdir(directory)}
});

test('cancellation discards queued PCM and fences late audio and timing before cleanup completes',async()=>{
 let release,audio,timing,providerClosed=0,playerStopped=0,received=0,resolveProvider,entered;
 const playerEntered=new Promise(resolve=>entered=resolve);
 const gate=new Promise(resolve=>release=resolve),events=new EventTarget(),cues=[];
 const services=await openDesktopVoiceServices({settings:{},signal:new AbortController().signal,
  openDevice:async()=>({close:async()=>{},createStreamPlayer:async()=>({events,append:async()=>{received++;entered();await gate},finish:async()=>{},play(){},stop:async()=>{playerStopped++;release()},destroy:async()=>{}})}),
  createAsr:()=>({createRound(){return{}},start(){},stop(){}}),
  openSpeechStream:async options=>{audio=options.onAudio;timing=options.onTiming;return{finished:new Promise(resolve=>resolveProvider=resolve),append:async()=>{},finish:async()=>{},close:async()=>{providerClosed++;resolveProvider({})}}}
 });
 try{
  const job=await services.runtime.tts.openStream({onCue:value=>cues.push(value)});
  await audio(Buffer.alloc(200000));await settled(playerEntered);
  job.task.abort();await audio(Buffer.alloc(2));timing([{charIndex:0,charLength:1,startTime:0,endTime:1,mode:'word'}]);events.dispatchEvent(Object.assign(new Event('progress'),{seconds:1}));
  await job.player.destroy();assert.equal(received,1);assert.deepEqual(cues,[]);assert.equal(providerClosed,1);assert.equal(playerStopped,1);
 }finally{release();await services.dispose()}
});

test('PCM limit and player errors fail once and still remove the private spool',async()=>{
 for(const mode of ['limit','player']){
  const directory=await mkdtemp(join(tmpdir(),'rabi-pcm-failure-')),errors=[];
  const queue=await openPcmBuffer({directory,sampleRate:24000,maxBytes:10,onError:error=>errors.push(error),append:async()=>{if(mode==='player')throw Error('DEVICE_GONE')}});
  try{
   if(mode==='limit')await assert.rejects(queue.append(Buffer.alloc(12)),/PCM_BUFFER_FAILED/);
   else await queue.append(Buffer.alloc(2));
   await assert.rejects(queue.finish(),/PCM_BUFFER_FAILED/);assert.equal(errors.length,1);
  }finally{await queue.dispose();assert.deepEqual(await readdir(directory),[]);await rmdir(directory)}
 }
});

test('device failure rejects the synthesis task even when a provider never acknowledges cancellation',async()=>{
 let audio,aborted=false;
 const services=await openDesktopVoiceServices({settings:{},signal:new AbortController().signal,
  openDevice:async()=>({close:async()=>{},createStreamPlayer:async()=>({events:new EventTarget(),append:async()=>{throw Error('DEVICE_GONE')},finish:async()=>assert.fail('failed output cannot finish'),play(){},stop:async()=>{},destroy:async()=>{}})}),
  createAsr:()=>({createRound(){return{}},start(){},stop(){}}),
  openSpeechStream:async options=>{audio=options.onAudio;options.signal.addEventListener('abort',()=>aborted=true);return{finished:new Promise(()=>{}),append:async()=>{},finish:async()=>{},close:async()=>{}}}
 });
 try{
  const job=await services.runtime.tts.openStream();const rejected=assert.rejects(job.task.finished,/PCM_BUFFER_FAILED/);
  await audio(Buffer.alloc(2));await rejected;assert.equal(aborted,true);
 }finally{await services.dispose()}
});
