import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantDiagnostics} from '../src/diagnostics.mjs';
import {createDiagnosticSample,diagnosticSampleText,diagnosticTranscript} from './fixtures/diagnostic-inputs.mjs';

test('full test uses actual recognition output and requires playback completion and stopped voice',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-checks-'));
  const createSample=createDiagnosticSample;
  let config={llmModel:'m',asrModel:'a',ttsVoice:'v'},phase='stopped',played=0,input;
  const host={state:async()=>({voice:{phase},playback:{completed:played}}),command:async request=>{
    if(request.action==='start')phase='running';
    if(request.action==='stop')phase='stopped';
    return request.action==='test-microphone'?{bytes:100,peak:.1,audible:true}:{voice:{phase},error:null};
  }};
  const conversation={submit:async text=>{input=text;played++},drain:async()=>{},activity:()=>({status:'completed'})};
  const options={directory,createSample,settings:()=>config,host,conversation,recognize:async audio=>{assert.equal(audio.toString(),diagnosticSampleText);return {text:diagnosticTranscript}}};
  try{
    const checks=await createAssistantDiagnostics(options);
    await checks.run('all');await checks.drain();
    assert.ok(input.includes(diagnosticTranscript));
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
  const createSample=createDiagnosticSample;
  const checks=await createAssistantDiagnostics({directory,createSample,settings:()=>({}),
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

test('missing system sample cannot pass ASR or invoke recognition',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-no-sample-'));
  try {
    const checks=await createAssistantDiagnostics({directory,settings:()=>({}),
      host:{state:async()=>({voice:{phase:'stopped'}})},conversation:{},
      createSample:async()=>{throw Error('ASR_SAMPLE_SOURCE_UNAVAILABLE')},
      recognize:async()=>assert.fail('recognition must not run without a real sample')});
    await checks.run('asr');await checks.drain();
    assert.equal(checks.snapshot().checks.asr.status,'failed');
    assert.equal(checks.snapshot().checks.asr.detail,'ASR_SAMPLE_SOURCE_UNAVAILABLE');
  } finally {await rm(directory,{recursive:true,force:true})}
});

test('prior bundled-sample results become stale without invalidating unchanged model checks',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-sample-migration-'));
  try {
    const oldSignature=createHash('sha256').update('{}').digest('hex');
    await writeFile(join(directory,'checks.json'),JSON.stringify({
      asr:{status:'passed',detail:'old sample',signature:oldSignature},
      voice:{status:'passed',detail:'old sample chain',signature:oldSignature},
      model:{status:'passed',detail:'model reply',signature:oldSignature},
    }));
    const checks=await createAssistantDiagnostics({directory,settings:()=>({}),host:{},conversation:{}});
    assert.equal(checks.snapshot().checks.asr.status,'stale');
    assert.equal(checks.snapshot().checks.voice.status,'stale');
    assert.equal(checks.snapshot().checks.model.status,'passed');
  } finally {await rm(directory,{recursive:true,force:true})}
});
