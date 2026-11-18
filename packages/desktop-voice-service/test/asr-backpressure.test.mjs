import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createVolcanoAsr} from '../src/volcano-asr.mjs';
import {decodeFrame} from '../src/volcano-codec.mjs';
import {openSpeechSocket} from '../src/speech-socket.mjs';

test('an eight-second IPC batch drains through asynchronous send callbacks without losing PCM',async()=>{
  let capture;const frames=[],errors=[];
  const asr=createVolcanoAsr({settings:()=>({sampleMs:50,silenceThreshold:.01,silenceDurationMs:700}),connection:async()=>({}),
    createRecording:()=>({start:async(_fail,options)=>{capture=options.onPcm},amplitude:()=>0,dispose:async()=>{}}),
    connect:async()=>({send:async bytes=>{await new Promise(resolve=>setImmediate(resolve));frames.push(decodeFrame(bytes))},close:async()=>{}})});
  const round=asr.createRound({onError:error=>errors.push(error.message)});
  try{
    await asr.start(round);
    const pcm=Buffer.concat(Array.from({length:64},(_,index)=>Buffer.alloc(4096,index)));
    capture(pcm);await asr.finish(round);
    assert.deepEqual(errors,[]);assert.equal(frames.at(-1).last,true);
    assert.deepEqual(Buffer.concat(frames.filter(frame=>frame.type===2).map(frame=>frame.payload)),pcm);
  }finally{await asr.stop(round)}
});

test('transport backlog is distinct from PCM batching and still rejects over one MiB',async()=>{
  let socket;const errors=[];
  class WebSocket extends EventEmitter{
    bufferedAmount=0;sends=0;
    constructor(){super();socket=this;queueMicrotask(()=>this.emit('open'))}
    send(_bytes,_options,done){this.sends++;queueMicrotask(()=>done())}
    close(){queueMicrotask(()=>this.emit('close'))}terminate(){this.emit('close')}
  }
  const transport=await openSpeechSocket({endpoint:'wss://example.test',WebSocketClass:WebSocket,onError:error=>errors.push(error.message)});
  try{
    socket.bufferedAmount=1024*1024-8;await transport.send(Buffer.alloc(8));
    socket.bufferedAmount=1024*1024;
    await assert.rejects(transport.send(Buffer.alloc(1)),/SPEECH_SEND_BACKLOG/);
    assert.equal(socket.sends,1);
    socket.bufferedAmount=0;await transport.send(Buffer.alloc(8));
    assert.equal(socket.sends,2);assert.deepEqual(errors,[]);
  }finally{await transport.close()}
});
