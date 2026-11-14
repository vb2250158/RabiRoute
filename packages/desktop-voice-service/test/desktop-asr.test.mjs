import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopAsr} from '../src/desktop-asr.mjs';
const flush=async()=>{for(let n=0;n<15;n++)await Promise.resolve()};
test('capture and speech onset continue while an earlier transcription is pending',async()=>{
  let now=0,tick,level=0,release,disposed=0,starts=0,spoken=0;
  const first=new Promise(resolve=>{release=resolve}),results=[],calls=[];
  const asr=createDesktopAsr({createRecording:()=>({start:async()=>{starts++},amplitude:()=>level,markSpeech(){},
    take:async()=>new Uint8Array([1]),dispose:async()=>{disposed++}}),
    transcribe:async(audio,signal)=>{calls.push(signal);return calls.length===1?first:{text:'second'}},
    settings:()=>({threshold:.1,silenceMs:10,sampleMs:1,maxDurationMs:100}),
    clock:{now:()=>now,setInterval:fn=>{tick=fn;return 1},clearInterval(){},setTimeout:()=>1,clearTimeout(){}}});
  const round=asr.createRound({onStart(){},onSpeechStart(){spoken++},onFinal:r=>results.push(r.text),onError:e=>{throw e}});
  await asr.start(round);
  const utterance=async()=>{level=.2;tick();level=0;tick();now+=11;tick();await flush()};
  await utterance();assert.equal(calls.length,1);assert.equal(results.length,0);
  await utterance();assert.equal(spoken,2);assert.equal(starts,1);assert.equal(disposed,0);
  release({text:'first'});await flush();assert.deepEqual(results,['first','second']);
  await asr.stop(round);assert.equal(disposed,1);assert.equal(calls[0].aborted,true);
});
