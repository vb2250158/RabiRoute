import { openDesktopDevice } from '../src/node-device.mjs';
import { resolveElectronExecutable } from '../src/device-executable.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const device=await openDesktopDevice({electronExecutable:await resolveElectronExecutable(),signal:new AbortController().signal});
const pcm=Buffer.alloc(4800*2);
for(let i=0;i<4800;i++)pcm.writeInt16LE(Math.round(Math.sin(i/24000*2*Math.PI*440)*1200),i*2);
try {
  const player=await device.createStreamPlayer({sampleRate:24000});
  let ended=false;player.events.addEventListener('ended',()=>{ended=true});
  await player.play();await player.append(pcm);await delay(250);
  assert.equal(ended,false,'audio ending is not stream ending');
  await player.append(pcm);await player.finish();
  for(let i=0;i<30&&!ended;i++)await delay(100);
  assert.equal(ended,true);await player.destroy();
  const interrupted=await device.createStreamPlayer({sampleRate:24000});
  await interrupted.play();await interrupted.append(pcm);await interrupted.stop();
  await assert.rejects(interrupted.append(pcm),/STOPPED/);await interrupted.destroy();
  console.log(JSON.stringify({pcmPlaybackEnded:true,lateFrameRejected:true,audioSource:'local-generated-tone',externalApi:false}));
} finally { await device.close();console.log('DEVICE_JOB_RELEASE_CONFIRMED'); }
