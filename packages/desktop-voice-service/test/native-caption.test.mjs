import test from 'node:test';
import assert from 'node:assert/strict';
import {openDesktopVoiceServices} from '../src/services.mjs';

class PlayerEvents extends EventTarget{
 progressListeners=new Set();
 addEventListener(name,listener,options){if(name==='progress')this.progressListeners.add(listener);super.addEventListener(name,listener,options)}
 removeEventListener(name,listener,options){if(name==='progress')this.progressListeners.delete(listener);super.removeEventListener(name,listener,options)}
 progress(seconds){this.dispatchEvent(Object.assign(new Event('progress'),{seconds}))}
}
async function fixture(){
 const events=new PlayerEvents(),cues=[];let closed=0;
 const services=await openDesktopVoiceServices({signal:new AbortController().signal,settings:{},
  synthesize:async()=>new Uint8Array([1,2]),createAsr:()=>({createRound(){return{}},start(){},stop(){}}),
  openDevice:async()=>({close:async()=>closed++,createPlayer:async()=>({events,play(){},stop:async()=>{},destroy:async()=>{}})})});
 return {events,cues,services,closed:()=>closed};
}
test('non-streaming audio highlights its actual playing segment without inventing word alignment',async()=>{
 const f=await fixture();
 try{
  const job=await f.services.runtime.tts.synthesize('你好，第二句。',{onCue:cue=>f.cues.push(cue)});
  assert.deepEqual(f.cues,[]);await job.player.play();assert.deepEqual(f.cues,[],'requesting play is not actual output');
  f.events.progress(-1);f.events.progress(NaN);assert.deepEqual(f.cues,[]);
  f.events.progress(0);assert.deepEqual(f.cues,[{charIndex:0,charLength:7,mode:'sentence'}]);
  f.events.progress(.2);assert.equal(f.cues.length,1);
  f.events.dispatchEvent(new Event('ended'));assert.equal(f.events.progressListeners.size,0);
 }finally{await f.services.dispose();assert.equal(f.closed(),1)}
});
test('cancelled, stopped or destroyed native playback never accepts a late highlight',async()=>{
 for(const action of ['abort','stop','destroy']){
  const f=await fixture(),controller=new AbortController();
  try{
   const job=await f.services.runtime.tts.synthesize('不要亮',{signal:controller.signal,onCue:cue=>f.cues.push(cue)});
   if(action==='abort')controller.abort();else await job.player[action]();
   f.events.progress(0);assert.deepEqual(f.cues,[],action);assert.equal(f.events.progressListeners.size,0,action);
  }finally{await f.services.dispose();assert.equal(f.closed(),1)}
 }
});
