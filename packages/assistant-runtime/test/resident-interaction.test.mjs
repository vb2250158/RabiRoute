import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentInteraction } from '../src/resident-interaction.js';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function services(startError, afterStart) {
  const rounds=[],jobs=[];let disposed=0;
  const runtime=createAiuiAssistantRuntime({
    asr:{createRound(handlers){const r={handlers,stopped:0};rounds.push(r);return r;},start(r){if(startError)throw startError;r.handlers.onStart();return afterStart?.(r);},stop(r){r.stopped++;}},
    tts:{async synthesize(text){const job={text,aborted:0,task:{abort(){job.aborted++;}},player:{audioPlayer:new EventTarget(),play(){},destroy(){}}};jobs.push(job);return job;}},
  });
  return {runtime,rounds,jobs,dispose(){disposed++;runtime.dispose();},get disposed(){return disposed;}};
}
test('one resident survives all presenter detachments and preserves mute across restart',async()=>{
  const first=services(),second=services(),inputs=[];let opens=0;
  const resident=createResidentInteraction({openServices:async()=>++opens===1?first:second,onInput:i=>inputs.push(i)});
  const offGUI=resident.subscribe(()=>{}),offPet=resident.subscribe(()=>{});
  await Promise.all([resident.start(),resident.start()]);
  assert.equal(opens,1);offGUI();offPet();
  first.rounds[0].handlers.onFinal({text:'background'});
  assert.equal(inputs.length,1);assert.equal(first.rounds[0].stopped,0);
  const response=resident.beginResponse({id:'work'});response.append('Still working。');await flush();
  first.rounds[0].handlers.onSpeechStart();assert.equal(first.jobs[0].aborted,1);
  response.append(' task continues');assert.equal(response.getState().text,'Still working。 task continues');
  resident.setOutputEnabled(false);await resident.stop();
  assert.equal(first.disposed,1);assert.equal(first.rounds[0].stopped,1);
  await resident.start();resident.beginResponse().append('Muted.');await flush();
  assert.equal(second.jobs.length,0);assert.equal(second.rounds.length,1);
  await resident.dispose();assert.equal(second.disposed,1);
});
test('stop during acquisition rejects late start and disposes late services without capture',async()=>{
  const wait=deferred(),service=services();
  const resident=createResidentInteraction({openServices:()=>wait.promise,onInput(){}});
  const pending=resident.start();await flush();await resident.stop();wait.resolve(service);
  await assert.rejects(pending,/START_EXPIRED/);assert.equal(service.disposed,1);assert.equal(service.rounds.length,0);
  await resident.dispose();assert.equal(service.disposed,1);
});
test('a failing service can retry; GUI observers cannot prevent device release',async()=>{
  const service=services();let calls=0;
  const resident=createResidentInteraction({openServices:async()=>{if(++calls===1)throw Error('offline');return service;},onInput(){},onError(){}});
  resident.subscribe(()=>{throw Error('view error');});
  await assert.rejects(resident.start(),/offline/);assert.equal(resident.getState().phase,'failed');
  await resident.start();await resident.dispose();assert.equal(service.disposed,1);
  await assert.rejects(resident.start(),/CLOSED/);
});
test('new acquisition waits for asynchronous device release',async()=>{
  const released=deferred(),first=services(),second=services();let calls=0;
  const original=first.dispose;first.dispose=async()=>{await released.promise;original.call(first);};
  const resident=createResidentInteraction({openServices:async()=>++calls===1?first:second,onInput(){}});
  await resident.start();const stopping=resident.stop(),starting=resident.start();
  await flush();assert.equal(calls,1);
  released.resolve();await stopping;await starting;assert.equal(calls,2);
  await resident.dispose();
});

test('replacement start also waits for a cancelled factory to return and release its late device',async()=>{
  const acquired=deferred(),first=services(),second=services();let calls=0;
  const resident=createResidentInteraction({openServices:()=>++calls===1?acquired.promise:Promise.resolve(second),onInput(){}});
  const old=resident.start();await flush();await resident.stop();
  const next=resident.start();await flush();assert.equal(calls,1);
  acquired.resolve(first);await assert.rejects(old,/EXPIRED/);await next;
  assert.equal(first.disposed,1);assert.equal(first.rounds.length,0);assert.equal(second.rounds.length,1);
  await resident.dispose();
});

test('microphone start failure rejects start and can retry after confirmed release',async()=>{
  const bad=services(Error('mic-denied')),good=services();let calls=0;
  const resident=createResidentInteraction({openServices:async()=>++calls===1?bad:good,onInput(){}});
  await assert.rejects(resident.start(),/mic-denied/);
  assert.equal(resident.getState().capture,'failed');assert.equal(bad.disposed,1);
  await resident.start();assert.equal(resident.getState().capture,'listening');await resident.dispose();
});
test('unconfirmed device cleanup blocks future acquisition',async()=>{
  const device=services();let calls=0;device.dispose=async()=>{throw Error('still-owned');};
  const resident=createResidentInteraction({openServices:async()=>{calls++;return device;},onInput(){}});
  await resident.start();await assert.rejects(resident.stop(),/still-owned/);
  await assert.rejects(resident.start(),/CLEANUP_UNCONFIRMED/);assert.equal(calls,1);
  await resident.dispose();
});
test('async observer and diagnostic failures are contained',async()=>{
  const device=services();
  const resident=createResidentInteraction({openServices:async()=>device,onInput(){},
    onEvent:async()=>{throw Error('view');},onError:async()=>{throw Error('sink');}});
  resident.subscribe(async()=>{throw Error('pet');});
  await resident.start();await flush();await resident.dispose();await flush();
  assert.equal(device.disposed,1);
});
test('reentrant start joins the installed startup latch',async()=>{
  const device=services();let nested,calls=0;
  const resident=createResidentInteraction({openServices:async()=>{calls++;return device;},onInput(){},
    onEvent:event=>{if(event.type==='state'&&event.state.phase==='starting')nested=resident.start();}});
  const original=resident.start();assert.equal(original,nested);await original;assert.equal(calls,1);await resident.dispose();
});
test('reentrant stop and dispose prevent acquisition before the first await',async()=>{
  for(const method of ['stop','dispose']){
    let action,calls=0;
    const resident=createResidentInteraction({openServices:async()=>{calls++;return services();},onInput(){},
      onEvent:event=>{if(event.type==='state'&&event.state.phase==='starting')action=resident[method]();}});
    await assert.rejects(resident.start(),/EXPIRED/);await action;assert.equal(calls,0);await resident.dispose();
  }
});

test('onStart followed by immediate failure never publishes running',async()=>{
  for(const fail of [r=>r.handlers.onError(Error('device-loss')),()=>Promise.reject(Error('device-loss'))]){
    const device=services(undefined,fail),states=[];
    const resident=createResidentInteraction({openServices:async()=>device,onInput(){},onEvent:e=>{if(e.type==='state')states.push(e.state.phase);}});
    await assert.rejects(resident.start(),/device-loss/);
    assert.equal(states.includes('running'),false);assert.equal(resident.getState().capture,'failed');
    assert.equal(device.disposed,1);await resident.dispose();
  }
});
test('illegal factory result with failed disposal blocks future acquisition',async()=>{
  let calls=0;
  const resident=createResidentInteraction({openServices:async()=>{calls++;return {dispose(){throw Error('device-unknown');}};},onInput(){}});
  await assert.rejects(resident.start(),/device-unknown/);
  await assert.rejects(resident.start(),/CLEANUP_UNCONFIRMED/);
  assert.equal(calls,1);await resident.dispose();
});

test('reentrant output enable keeps public state and actual playback consistent',async()=>{
  const device=services();let reenabling=false;
  const resident=createResidentInteraction({openServices:async()=>device,onInput(){},
    onEvent:e=>{if(e.type==='voice'&&e.event.type==='speech-interrupted'&&e.event.reason==='output-disabled'&&!reenabling){
      reenabling=true;resident.setOutputEnabled(true);
    }}});
  await resident.start();resident.setOutputEnabled(false);
  assert.equal(resident.getState().outputEnabled,true);
  resident.beginResponse().append('Allowed。');await flush();
  assert.equal(device.jobs.length,1);await resident.dispose();
});

test('blocked listening rejects instead of hanging in starting',async()=>{
  const device=services();
  const resident=createResidentInteraction({openServices:async()=>device,onInput(){},
    voiceOptions:{listening:{canStart:()=>false}},captureStartTimeoutMs:50});
  await assert.rejects(resident.start(),/CAPTURE_BLOCKED/);
  assert.equal(resident.getState().phase,'failed');assert.equal(device.disposed,1);
  await resident.dispose();
});

test('onStart does not remove the deadline for a stuck dispatch Promise',async()=>{
  const device=services(undefined,()=>new Promise(()=>{}));
  const resident=createResidentInteraction({openServices:async()=>device,onInput(){},captureStartTimeoutMs:10});
  await assert.rejects(resident.start(),/CAPTURE_START_TIMEOUT/);
  assert.equal(resident.getState().phase,'failed');assert.equal(device.disposed,1);
  await resident.dispose();
});

test('capture pause leaves playback and service owner alive and resumes one round',async()=>{
  const device=services();let opens=0;
  const resident=createResidentInteraction({openServices:async()=>{opens++;return device;},onInput(){}});
  await resident.start();const response=resident.beginResponse();response.append('Still speaking。');await flush();
  resident.pauseCapture();assert.equal(resident.getState().capture,'stopped');
  assert.equal(device.jobs[0].aborted,0);assert.equal(device.disposed,0);
  await Promise.all([resident.resumeCapture(),resident.resumeCapture()]);
  assert.equal(opens,1);assert.equal(device.rounds.length,2);assert.equal(resident.getState().capture,'listening');
  await resident.dispose();
});
