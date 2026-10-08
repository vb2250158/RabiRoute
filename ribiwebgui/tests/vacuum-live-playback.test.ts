import assert from "node:assert/strict";
import test from "node:test";
import {LivePlaybackPacer, startVacuumLivePlayback} from "../src/vacuumLivePlayback.js";
test("live playback recovers sustained backlog without repeatedly resetting the decoder",()=>{
 const pacer=new LivePlaybackPacer();
 assert.equal(pacer.update(0,20,25,0)?.seekTo,24.7);
 assert.equal(pacer.update(22,20,25,1000)?.seekTo,undefined);
 assert.equal(pacer.update(22,20,25,2000)?.seekTo,undefined);
 assert.equal(pacer.update(22,20,25,5000)?.seekTo,24.7);
 assert.equal(pacer.update(22,20,25,5100)?.seekTo,undefined);
 assert.equal(pacer.update(24.8,20,25,5200)?.playbackRate,1);
 assert.equal(pacer.update(10,20,20.05,5300)?.seekTo,20);
});
test("normal frame jitter stays at normal speed, including brief latency spikes",()=>{
 const pacer=new LivePlaybackPacer();
 for(let sample=0;sample<300;sample++) {
  const gap=[0.12,0.2,0.36,0.5,0.72,1.7,0.3][sample%7];
  const correction=pacer.update(5-gap,0,5,sample*100)!;
  assert.equal(correction.seekTo,undefined);assert.equal(correction.playbackRate,1);
 }
});
test("gentle catch-up uses hysteresis instead of changing speed for every packet",()=>{
 const pacer=new LivePlaybackPacer();
 assert.equal(pacer.update(4.2,0,5,0)?.playbackRate,1);
 assert.equal(pacer.update(4.2,0,5,1100)?.playbackRate,1.03);
 for(const gap of [0.6,0.42,0.55]) assert.equal(pacer.update(5-gap,0,5,1200)?.playbackRate,1.03);
 assert.equal(pacer.update(4.7,0,5,1300)?.playbackRate,1);
 assert.equal(new LivePlaybackPacer().update(3,0,5,0)?.seekTo,undefined);
 const recovering=new LivePlaybackPacer();
 recovering.update(3,0,5,0);
 assert.equal(recovering.update(3,0,5,1100)?.seekTo,4.7);
});
test("unready and invalid media ranges do not manufacture a live edge",()=>{
 for(const values of [[0,0,0],[0,2,1],[NaN,0,1],[0,0,Infinity]]) assert.equal(new LivePlaybackPacer().update(...values as [number,number,number],0),undefined);
});
test("an unresolved play promise cannot block later frames, and end releases the owned URL",async()=>{
 const oldFetch=globalThis.fetch, oldMedia=globalThis.MediaSource, oldCreate=URL.createObjectURL, oldRevoke=URL.revokeObjectURL;
 let appended=0, revoked=0, reads=0, playCalls=0, playAt=0, source:EventTarget;
 class Buffer extends EventTarget {
  buffered={length:1,start:()=>0,end:()=>appended/20};
  appendBuffer(){appended++;queueMicrotask(()=>this.dispatchEvent(new Event("updateend")));}
 }
 class Media extends EventTarget {
  static isTypeSupported(){return true;}
  duration=0;
  constructor(){super();source=this;}
  addSourceBuffer(){return new Buffer();}
  setLiveSeekableRange(){}
 }
 const video={_src:"",get src(){return this._src;},set src(value:string){this._src=value;queueMicrotask(()=>source.dispatchEvent(new Event("sourceopen")));},currentTime:0,paused:true,playbackRate:1,
  play:()=>{playCalls++;playAt=appended;return new Promise<void>(()=>undefined);},pause:()=>undefined,removeAttribute:()=>undefined,load:()=>undefined};
 globalThis.MediaSource=Media as unknown as typeof MediaSource;
 URL.createObjectURL=()=>"blob:owned";URL.revokeObjectURL=()=>{revoked++;};
 globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){reads++;if(reads<=7)c.enqueue(new Uint8Array([1,2]));else c.close();}}),{headers:{"content-type":'video/mp4; codecs="avc1.4D001F"'}});
 try {
  const playback=startVacuumLivePlayback(video as unknown as HTMLVideoElement,"/owned-stream",()=>undefined);
  await assert.rejects(playback.finished,/视频流已中断/);
  assert.equal(appended,7);assert.equal(playCalls,1);assert.equal(playAt,6);assert.equal(revoked,1);
  playback.stop();assert.equal(revoked,1);
 }finally{globalThis.fetch=oldFetch;globalThis.MediaSource=oldMedia;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
});
