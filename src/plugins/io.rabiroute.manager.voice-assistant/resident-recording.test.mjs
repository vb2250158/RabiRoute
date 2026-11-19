import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createResidentRecording } from './src/resident-recording.mjs';
import { createWakeListener } from './src/wake-listener.mjs';

const captureId = 'a'.repeat(32);
const headers = {
  'content-type': 'application/octet-stream',
  'x-rabispeech-capture-id': captureId,
  'x-rabispeech-start-sample': '5200',
  'x-rabispeech-sample-rate': '16000',
};
const cursor = { captureId, sample: 5200 };

test('a wake event borrows the same capture from the keyword marker and combines partial PCM frames', async () => {
  const wakes = Object.assign(new PassThrough(), {statusCode:200, headers:{'content-type':'application/x-ndjson'}});
  const pcm = Object.assign(new PassThrough(), {statusCode:200, headers});
  let resolveEmitted, rejectEmitted;
  const emitted = new Promise((resolve,reject) => { resolveEmitted = resolve; rejectEmitted = reject; });
  let observed;
  const listener = createWakeListener({
    speechRuntime: {
      async openAssistantWake(aliases, signal) {
        assert.deepEqual(aliases, ['夜雨','大肥鱼']);
        signal.addEventListener('abort', () => wakes.destroy(), {once:true});
        return wakes;
      },
      async openAssistantCapture(signal, point) {
        assert.deepEqual(point,cursor);
        signal.addEventListener('abort', () => pcm.destroy(), {once:true});
        return pcm;
      },
    },
    async onWake({createRecording, alias}) {
      try {
        assert.equal(alias,'夜雨');
        const recording = createRecording();
        observed = recording;
        await recording.start(rejectEmitted, {onPcm:resolveEmitted});
        pcm.write(Buffer.from([5]));
        pcm.write(Buffer.from([0,7,0]));
      } catch (error) { rejectEmitted(error); }
    },
  });
  try {
    listener.arm(['夜雨','大肥鱼']);
    const lines = [
      {type:'ready',captureId,sampleRate:16000},
      {type:'wake',captureId,sampleRate:16000,aliasIndex:0,replayFromSample:5200,observedThroughSample:8200},
    ].map(value=>JSON.stringify(value));
    wakes.write(lines.join('\n')+'\n');
    assert.deepEqual(await emitted,Buffer.from([5,0,7,0]));
    assert.equal(listener.snapshot().phase,'armed');
  } finally {
    await observed?.dispose();
    await listener.stop();
  }
});

test('first buffered utterance keeps replay even before VAD marks speech and writes a valid WAV', async () => {
  const stream = Object.assign(new PassThrough(), {statusCode:200,headers});
  const recorder = createResidentRecording(async()=>stream,cursor);
  const bytes = Buffer.from([0xff,0x1f,0,0,0,0]);
  await recorder.start(error=>assert.fail(error));
  const consumed = once(stream, 'data');
  stream.write(bytes);
  await consumed;
  await new Promise(resolve=>setImmediate(resolve));
  try {
    assert.ok(recorder.amplitude()>0);
    recorder.markSpeech();
    const wave = await recorder.take();
    assert.equal(wave.toString('ascii',0,4),'RIFF');
    assert.equal(wave.readUInt32LE(24),16000);
    assert.equal(wave.readUInt32LE(40),bytes.length);
    assert.deepEqual(wave.subarray(44),bytes);
  } finally { await recorder.dispose(); }
});

test('the recorder rejects audio from a different capture generation', async () => {
  const stream = Object.assign(new PassThrough(), {statusCode:200,headers:{...headers,'x-rabispeech-capture-id':'wrong'}});
  const recorder = createResidentRecording(async()=>stream,cursor);
  await assert.rejects(recorder.start(assert.fail),/ASSISTANT_CAPTURE_REPLAY_UNAVAILABLE/);
  assert.ok(stream.destroyed);
});
