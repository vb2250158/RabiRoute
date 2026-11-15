import test from 'node:test';
import assert from 'node:assert/strict';
import {createStreamPlayers} from '../runtime/stream-players.mjs';
import {openSpeechSocket} from '../src/speech-socket.mjs';
import {EventEmitter} from 'node:events';

function fixture(){
 const sources=[],events=[],contexts=[],timers=new Map();let timerId=0;
 class AudioContext{
   currentTime=0;
   constructor(){contexts.push(this)}
   async suspend(){} async resume(){} async close(){}
   createBuffer(_channels,length){return {getChannelData:()=>new Float32Array(length)}}
   createBufferSource(){const source={connect(){},disconnect(){},start(){},stop(){},onended:null};sources.push(source);return source}
 }
 return {sources,events,contexts,timers,tick:()=>{for(const fn of timers.values())fn()},players:createStreamPlayers({AudioContext,send:event=>events.push(event),maxQueuedSeconds:1,clock:{setInterval(fn){timers.set(++timerId,fn);return timerId},clearInterval(id){timers.delete(id)}}})};
}

test('fast TTS waits for playback capacity and resumes instead of failing a long reply',async()=>{
 const {players,sources,events}=fixture();
 await players.create({id:'reply',sampleRate:8000});await players.play('reply');
 await players.append('reply',new Uint8Array(16000));
 let resumed=false;const waiting=Promise.resolve().then(()=>players.append('reply',new Uint8Array(1600))).then(()=>resumed=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(resumed,false);
 sources[0].onended();await waiting;assert.equal(resumed,true);
 players.finish('reply');assert.equal(events.filter(item=>item.event==='player.ended').length,0);sources[1].onended();assert.equal(events.at(-1).event,'player.ended');
 await players.dispose('reply');
});

test('PCM progress excludes queued time and underrun gaps, and stops on cancellation',async()=>{
 const f=fixture();await f.players.create({id:'timed',sampleRate:8000});await f.players.play('timed');await f.players.append('timed',new Uint8Array(8000));
 f.tick();assert.equal(f.events.length,0);
 f.contexts[0].currentTime=.22;f.tick();assert.ok(Math.abs(f.events.at(-1).seconds-.2)<.001);
 f.contexts[0].currentTime=.52;f.sources[0].onended();
 f.contexts[0].currentTime=2;await f.players.append('timed',new Uint8Array(1600));f.tick();assert.equal(f.events.at(-1).seconds,.5);
 f.contexts[0].currentTime=2.07;f.tick();assert.ok(Math.abs(f.events.at(-1).seconds-.55)<.001);
 f.players.stop('timed');const count=f.events.length;f.contexts[0].currentTime=3;f.tick();assert.equal(f.events.length,count);assert.equal(f.timers.size,0);await f.players.dispose('timed');
});

test('speech interruption releases blocked audio immediately and rejects late chunks',async()=>{
 const {players}=fixture();await players.create({id:'reply',sampleRate:8000});await players.play('reply');
 await players.append('reply',new Uint8Array(16000));
 const waiting=Promise.resolve().then(()=>players.append('reply',new Uint8Array(1600)));
 const rejected=assert.rejects(waiting,/DEVICE_STREAM_MISSING/);
 await new Promise(resolve=>setImmediate(resolve));players.stop('reply');await rejected;
 await assert.rejects(players.append('reply',new Uint8Array(1600)),/DEVICE_STREAM_MISSING/);
 await players.dispose('reply');
});

test('audio transport pauses ahead of slow playback and resumes after draining',async()=>{
 let socket,release,received=0;const gate=new Promise(resolve=>release=resolve),errors=[];
 class WebSocket extends EventEmitter{
   bufferedAmount=0;pauses=0;resumes=0;
   constructor(){super();socket=this;queueMicrotask(()=>this.emit('open'))}
   pause(){this.pauses++}resume(){this.resumes++}
   close(){queueMicrotask(()=>this.emit('close'))}terminate(){this.emit('close')}
 }
 const stream=await openSpeechSocket({endpoint:'wss://example.test',WebSocketClass:WebSocket,onError:error=>errors.push(error),async onMessage(){received++;if(received===1)await gate}});
 socket.emit('message',Buffer.alloc(256*1024),true);socket.emit('message',Buffer.alloc(128*1024),true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(socket.pauses,1);assert.equal(socket.resumes,0);assert.equal(received,1);
 release();await new Promise(resolve=>setImmediate(resolve));assert.equal(received,2);assert.equal(socket.resumes,1);assert.deepEqual(errors,[]);await stream.close();
});
