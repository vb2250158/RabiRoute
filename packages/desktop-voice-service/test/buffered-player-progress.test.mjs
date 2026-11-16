import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const source=new URL('../runtime/renderer.mjs',import.meta.url),artifact=new URL('../runtime/renderer.js',import.meta.url);
const bundled=await build({entryPoints:[fileURLToPath(source)],bundle:true,write:false,platform:'browser',format:'iife',target:'chrome120'});
const programs={source:bundled.outputFiles[0].text,built:await readFile(artifact,'utf8')};
function fixture(program){
 const sent=[],audios=[],revoked=[];let receive,sequence=0;
 class Audio{
  constructor(url){this.url=url;this.currentTime=0;this.paused=true;audios.push(this)}
  async play(){this.paused=false}pause(){this.paused=true}load(){}removeAttribute(){}
 }
 runInNewContext(program,{window:{audioDevice:{send:value=>sent.push(value),onCommand:fn=>receive=fn}},navigator:{mediaDevices:{}},Audio,
  AudioContext:class{},AudioWorkletNode:class{},URL:{createObjectURL:()=> 'blob:owned',revokeObjectURL:value=>revoked.push(value)},Blob,atob});
 return {sent,audios,revoked,events:()=>sent.filter(value=>value.event?.startsWith('player.')),
  async command(method,params){const id='request-'+(++sequence);await receive({id,method,params});const response=sent.find(value=>value.id===id);assert.equal(response?.ok,true,JSON.stringify(response));return response.value}};
}
for(const [name,program] of Object.entries(programs)){
 test(name+': buffered media forwards actual playing/timeupdate positions, not synthesis or play requests',async()=>{
  const f=fixture(program);await f.command('player.create',{id:'one',audio:'AQI='});const audio=f.audios[0];
  assert.deepEqual(f.events(),[]);await f.command('player.play',{id:'one'});assert.deepEqual(f.events(),[]);
  assert.equal(typeof audio.onplaying,'function');audio.onplaying();
  assert.equal(f.events()[0].event,'player.progress');assert.equal(f.events()[0].seconds,0);
  audio.currentTime=.25;audio.ontimeupdate();assert.equal(f.events().at(-1).seconds,.25);
  audio.currentTime=.8;audio.onended();assert.equal(f.events().at(-1).event,'player.ended');
  const count=f.events().length;audio.onplaying();audio.ontimeupdate();assert.equal(f.events().length,count);
  await f.command('player.dispose',{id:'one'});assert.deepEqual(f.revoked,['blob:owned']);
 });
 test(name+': stop and disposal fence captured late media callbacks and release handlers',async()=>{
  const f=fixture(program);await f.command('player.create',{id:'one',audio:'AQI='});await f.command('player.play',{id:'one'});
  const audio=f.audios[0],late=[audio.onplaying,audio.ontimeupdate,audio.onended,audio.onerror];
  assert(late.every(value=>typeof value==='function'));
  await f.command('player.stop',{id:'one'});for(const callback of late)callback();assert.deepEqual(f.events(),[]);
  await f.command('player.dispose',{id:'one'});for(const callback of late)callback();assert.deepEqual(f.events(),[]);
  assert.equal(audio.onplaying,null);assert.equal(audio.ontimeupdate,null);assert.equal(audio.onended,null);assert.equal(audio.onerror,null);
 });
}
