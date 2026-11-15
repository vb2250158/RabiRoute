import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantDiagnostics} from '../src/diagnostics.mjs';

test('full test uses actual recognition output and requires playback completion and stopped voice',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-checks-'));
  const fixture=join(directory,'audio.wav');await writeFile(fixture,'fixture');
  let config={llmModel:'m',asrModel:'a',ttsVoice:'v'},phase='stopped',played=0,input;
  const host={state:async()=>({voice:{phase},playback:{completed:played}}),command:async request=>{
    if(request.action==='start')phase='running';
    if(request.action==='stop')phase='stopped';
    return request.action==='test-microphone'?{bytes:100,peak:.1,audible:true}:{voice:{phase},error:null};
  }};
  const conversation={submit:async text=>{input=text;played++},drain:async()=>{},activity:()=>({status:'completed'})};
  const options={directory,fixture,settings:()=>config,host,conversation,recognize:async()=>({text:'示例音频内容'})};
  try{
    const checks=await createAssistantDiagnostics(options);
    await checks.run('all');await checks.drain();
    assert.ok(input.includes('示例音频内容'));
    assert.equal(phase,'stopped');assert.equal(checks.snapshot().job.completed,5);
    for(const item of Object.values(checks.snapshot().checks))assert.equal(item.status,'passed');
    await checks.confirmPlayback(false);assert.equal(checks.snapshot().checks.tts.status,'warning');
    await checks.confirmPlayback(true);assert.equal(checks.snapshot().checks.tts.status,'passed');
    const restored=await createAssistantDiagnostics(options);
    assert.equal(restored.snapshot().checks.asr.status,'passed');
    config={...config,asrModel:'changed'};
    assert.equal(restored.snapshot().checks.asr.status,'stale');
    assert.equal(restored.snapshot().checks.voice.status,'stale');
    assert.equal(restored.snapshot().checks.model.status,'passed');
    config={...config,outputEnabled:false};
    await assert.rejects(restored.run('all'),/SPEECH_TEST_UNMUTE_REQUIRED/);
    await restored.invalidate('model');
    assert.equal(restored.snapshot().checks.model.status,'untested');
    assert.equal(restored.snapshot().checks.voice.status,'untested');
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('failed recognition is visible, never passes the voice chain, and overlapping tests are rejected',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-checks-'));
  const fixture=join(directory,'audio.wav');await writeFile(fixture,'fixture');
  const checks=await createAssistantDiagnostics({directory,fixture,settings:()=>({}),
    host:{state:async()=>({voice:{phase:'stopped'}}),command:async()=>({bytes:100,audible:false})},
    conversation:{submit:async()=>assert.fail('model should not run')},recognize:async()=>{throw Error('LOCAL_ASR_FAILED')}});
  try{
    const admissions=await Promise.allSettled([checks.run('all'),checks.run('all')]);
    assert.equal(admissions.filter(item=>item.status==='fulfilled').length,1);
    await checks.drain();
    assert.equal(checks.snapshot().checks.asr.status,'failed');
    assert.equal(checks.snapshot().checks.voice.status,'failed');
    assert.equal(checks.snapshot().checks.microphone.status,'warning');
  }finally{await rm(directory,{recursive:true,force:true})}
});
