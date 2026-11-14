import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulatorHost } from './host.js';

function pcm(seconds, value = 4000) {
  const bytes = new Uint8Array(Math.round(seconds * 16000) * 2);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, value, true);
  return bytes;
}

test('sequential audio writes remain responsive during ASR and graceful finish drains ordered transcripts', { timeout: 2000 }, async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
  const events = [], pending = [];
  const host = createSimulatorHost({ mode: 'microphone', config: {}, token: 'fixture', report() {},
    emit(type, detail) { events.push({ type, detail }); },
    request() { return new Promise(resolve => pending.push(text => resolve({ ok: true, json: async () => ({ text }) }))); }
  });
  t.after(() => host.dispose());
  const speech = host.capabilities.speech, request = { sessionId: 'sequential', audio: { sampleRate: 16000 } };
  speech.openRecognitionStream(request);
  const write = bytes => speech.writeRecognitionAudio({ sessionId: request.sessionId, bytes });
  let timer;
  try {
    const accepted = await Promise.race([write(pcm(12)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 80); })]);
    assert.equal(accepted, true, 'Audio acceptance must not wait for a transcription response.');
  } finally { clearTimeout(timer); }
  await write(pcm(0.8, 0));
  await write(pcm(0.1));
  assert.equal(events.filter(event => event.type === 'speech.speechstart').length, 2);
  assert.equal(pending.length, 1, 'Transcription requests must stay serialized.');
  let ended = false;
  const finish = speech.finishRecognitionStream(request).then(() => { ended = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, false, 'Graceful stop must retain the in-flight segment and its tail.');
  pending[0]('第一段');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2); assert.equal(ended, false);
  pending[1]('第二段'); await finish;
  assert.deepEqual(events.filter(event => event.type === 'speech.result').map(event => event.detail.alternatives[0].transcript), ['第一段', '第二段']);
  assert.equal(events.filter(event => event.type === 'speech.end').length, 1);
});

test('microphone onset precedes transcription, survives buffer splits, and stops after disposal', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
  const events = [], requests = [];
  let resolveTranscript;
  const host = createSimulatorHost({ mode: 'microphone', config: {}, token: 'fixture', report() {},
    emit(type) { events.push(type); },
    request(route, options) {
      requests.push({ route, signal: options.signal });
      return new Promise(resolve => { resolveTranscript = () => resolve({ ok: true, json: async () => ({ text: 'fixture transcript' }) }); });
    } });
  t.after(() => host.dispose());
  const speech = host.capabilities.speech;
  speech.openRecognitionStream({ sessionId: 'fixture', audio: { sampleRate: 16000 } });
  const write = bytes => speech.writeRecognitionAudio({ sessionId: 'fixture', bytes });
  await write(pcm(0.1, 0));
  await write(pcm(0.02)); // A short transient alone must not interrupt.
  assert.equal(events.includes('speech.speechstart'), false);
  await write(pcm(0.02));
  assert.equal(events.filter(type => type === 'speech.speechstart').length, 1);
  assert.equal(requests.length, 0, 'Onset must not wait for a transcription request');
  const split = write(pcm(12));
  await split;
  assert.equal(requests.length, 1);
  assert.equal(events.includes('speech.result'), false);
  resolveTranscript(); await new Promise(resolve => setImmediate(resolve));
  await write(pcm(0.1));
  assert.equal(events.filter(type => type === 'speech.speechstart').length, 1, 'Buffer split is not a new onset');
  const trailing = write(pcm(0.8, 0));
  await trailing;
  assert.equal(events.filter(type => type === 'speech.speechend').length, 1);
  assert.equal(requests.length, 2);
  await write(pcm(0.1));
  assert.equal(events.filter(type => type === 'speech.speechstart').length, 2, 'Next utterance interrupts even while prior ASR is pending');
  await host.dispose();
  assert.ok(requests.every(request => request.signal.aborted));
  const afterDispose = events.length;
  resolveTranscript(); await trailing;
  await write(pcm(0.1));
  assert.equal(events.length, afterDispose, 'Late ASR and audio must not reach a released host');
});

test('ASR backlog and network failure stop capture explicitly without issuing queued requests', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
  for (const scenario of ['backlog', 'network']) {
    const events = [], pending = [];
    const host = createSimulatorHost({ mode: 'microphone', config: {}, token: 'fixture', report() {},
      emit(type, detail) { events.push({ type, detail }); },
      request(_route, options) { return new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal })); }
    });
    try {
      const speech = host.capabilities.speech, request = { sessionId: scenario, audio: { sampleRate: 16000 } };
      speech.openRecognitionStream(request);
      const write = () => speech.writeRecognitionAudio({ sessionId: scenario, bytes: pcm(12) });
      for (let i = 0; i < (scenario === 'backlog' ? 4 : 2); i++) await write();
      assert.equal(pending.length, 1);
      if (scenario === 'backlog') await assert.rejects(write(), /ASR_BUFFER_FULL/);
      else pending[0].reject(new Error('private-upstream-error'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pending[0].signal.aborted, true);
      assert.equal(events.filter(event => event.type === 'speech.error').length, 1);
      assert.equal(events.filter(event => event.type === 'speech.end').length, 1);
      assert.doesNotMatch(JSON.stringify(events), /private-upstream-error/);
      pending[0].resolve({ ok: true, json: async () => ({ text: '迟到结果' }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pending.length, 1, 'No queued work may escape a failed capture session.');
      assert.equal(events.filter(event => event.type === 'speech.result').length, 0);
    } finally { await host.dispose(); }
  }
});

test('abort releases a graceful stop immediately and late ASR cannot affect a replacement session', { timeout: 2000 }, async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
  const events = [], pending = [];
  const host = createSimulatorHost({ mode: 'microphone', config: {}, token: 'fixture', report() {},
    emit(type, detail) { events.push({ type, detail }); },
    request() { return new Promise(resolve => pending.push(text => resolve({ ok: true, json: async () => ({ text }) }))); }
  });
  t.after(() => host.dispose());
  const speech = host.capabilities.speech, request = { sessionId: 'reused', audio: { sampleRate: 16000 } };
  const write = () => speech.writeRecognitionAudio({ sessionId: request.sessionId, bytes: pcm(12) });
  speech.openRecognitionStream(request); await write();
  const finish = speech.finishRecognitionStream(request);
  await speech.abortRecognitionStream(request); await finish;
  assert.equal(events.filter(event => event.type === 'speech.end').length, 1);
  speech.openRecognitionStream(request); await write();
  pending[0]('旧回复'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.type === 'speech.result').length, 0);
  assert.equal(events.filter(event => event.type === 'speech.end').length, 1);
  const replacementFinish = speech.finishRecognitionStream(request);
  pending[1]('新回复'); await replacementFinish;
  assert.deepEqual(events.filter(event => event.type === 'speech.result').map(event => event.detail.alternatives[0].transcript), ['新回复']);
  assert.equal(events.filter(event => event.type === 'speech.end').length, 2);
});
