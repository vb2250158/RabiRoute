import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureRegistry } from '../runtime/capture.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = async () => { for(let i=0;i<12;i++)await Promise.resolve(); };
function fixture({ permission, close = Promise.resolve(), module = Promise.resolve() } = {}) {
  let opened=0, stopped=0, contexts=0;
  const stream = () => ({getTracks:()=>[{stop(){stopped++},addEventListener(){}}]});
  class Context {
    sampleRate=16000;state='running';destination={};audioWorklet={addModule:()=>module};
    constructor(){contexts++}
    createMediaStreamSource(){return {connect(){},disconnect(){}}}
    createGain(){return {gain:{value:1},connect(){},disconnect(){}}}
    resume(){return Promise.resolve()}
    async close(){await close;this.state='closed'}
  }
  const capture=createCaptureRegistry({mediaDevices:{getUserMedia(){opened++;return permission?.promise??Promise.resolve(stream())}},
    AudioContext:Context,AudioWorkletNode:class {port={};connect(){}disconnect(){}},send(){}});
  return {capture,stream,state:()=>({opened,stopped,contexts})};
}
test('dispose waits for pending permission result and releases late tracks before next acquisition',async()=>{
  const permission=deferred(), f=fixture({permission});
  const starting=f.capture.start({id:'first'}); const rejected=assert.rejects(starting,/CANCELLED/);
  await flush(); let released=false;
  const releasing=f.capture.release('first').then(()=>{released=true});
  await flush();assert.equal(released,false);
  await assert.rejects(f.capture.start({id:'second'}),/BUSY/);
  assert.equal(f.state().opened,1);
  permission.resolve(f.stream());await Promise.all([rejected,releasing]);
  assert.equal(f.state().stopped,1);assert.equal(f.state().contexts,0);
  await f.capture.start({id:'second'});assert.equal(f.state().opened,2);await f.capture.release('second');
});
test('dispose also waits for pending worklet initialization and confirmed context close',async()=>{
  const module=deferred(), close=deferred(), f=fixture({module:module.promise,close:close.promise});
  const started=f.capture.start({id:'a'}), rejected=assert.rejects(started,/CANCELLED/);
  await flush();let released=false;const releasing=f.capture.release('a').then(()=>{released=true});
  module.resolve();await flush();assert.equal(f.state().stopped,1);assert.equal(released,false);
  await assert.rejects(f.capture.start({id:'b'}),/BUSY/);
  close.resolve();await Promise.all([rejected,releasing]);assert.equal(released,true);
});
test('failed cleanup remains fenced instead of allowing another capture',async()=>{
  const close=deferred(),f=fixture({close:close.promise});await f.capture.start({id:'a'});
  const releasing=f.capture.release('a');close.reject(Error('close failed'));
  await assert.rejects(releasing,/close failed/);await assert.rejects(f.capture.start({id:'b'}),/BUSY/);
});
