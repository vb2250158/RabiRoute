import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPlayback } from '../src/speech-playback.js';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  let now = 0, timerId = 0;
  const timers = new Map(), calls = [], events = [], jobs = [], errors = [];
  const clock = { setTimeout(fn, delay) { const id = timerId++; timers.set(id, { at: now + delay, fn }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  const job = () => {
    const value = { plays: 0, aborts: 0, stops: 0, destroys: 0,
      task: { abort() { value.aborts++; } },
      player: { audioPlayer: new EventTarget(), play() { value.plays++; }, stop() { value.stops++; }, destroy() { value.destroys++; } } };
    jobs.push(value); return value;
  };
  const tts = { synthesize(text, opts) { calls.push({ text, options: opts }); const value = job(); return Promise.resolve(value); } };
  const playback = createSpeechPlayback({ tts, clock, onEvent: e => events.push(e), onCleanupError: e => errors.push(e), ...options });
  return { playback, calls, events, jobs, job, tts, timers, advance, errors };
}

test('serial playback snapshots options and ignores old cues, ended events and completion promises', async () => {
  const f = fixture(), finished = deferred();
  f.playback.speak('first'); f.jobs[0].task.finished = finished.promise;
  const options = { voice: 'selected', volume: 0.4, audio: { preferredFormat: 'pcm' } };
  f.playback.speak('second', options); options.voice = 'changed'; options.audio.preferredFormat = 'mp3';
  await settle(); assert.equal(f.calls.length, 1);
  f.jobs[0].player.audioPlayer.dispatchEvent(new Event('ended')); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].options.voice, 'selected');
  assert.equal(f.calls[1].options.audio.preferredFormat, 'pcm'); assert.equal(f.calls[1].options.volume, 0.4);
  const count = f.events.length;
  f.calls[0].options.onCue({ text: 'late' }); finished.reject(Error('old completion'));
  f.jobs[0].player.audioPlayer.dispatchEvent(new Event('ended')); await settle();
  assert.equal(f.events.length, count); assert.equal(f.playback.getState().player, f.jobs[1].player);
  f.calls[1].options.onCue({ text: 'current' }); assert.equal(f.events.at(-1).cue.text, 'current');
  f.jobs[1].player.audioPlayer.dispatchEvent(new Event('ended'));
  assert.equal(f.playback.getState().active, false); assert.equal(f.jobs[0].aborts, 0); assert.equal(f.timers.size, 0);
});

test('cancel discards queued output, cleans late synthesis and allows a fresh reply', async () => {
  const pending = deferred(); const f = fixture();
  f.tts.synthesize = () => pending.promise;
  f.playback.speak('old'); f.playback.speak('discarded'); f.playback.cancel();
  assert.equal(f.timers.size, 0); assert.equal(f.playback.getState().queued, 0);
  const old = f.job(); pending.resolve(old); await settle();
  assert.equal(old.plays, 0); assert.equal(old.aborts, 1); assert.equal(old.destroys, 1);
  const next = f.job(); f.tts.synthesize = () => Promise.resolve(next);
  f.playback.speak('fresh'); await settle(); assert.equal(next.plays, 1); f.playback.cancel();
  assert.equal(next.aborts, 1); assert.equal(next.stops, 1); assert.equal(next.destroys, 1);
});

test('native canplay starts once; hidden owners and late canplay cannot start audio', async () => {
  let visible = true;
  const f = fixture({ isActive: () => visible });
  f.tts.synthesize = () => {
    const j = f.job(); j.player.audioPlayer = { onCanplay(fn) { this.ready = fn; }, onEnded(fn) { this.end = fn; }, onError(fn) { this.error = fn; } };
    return Promise.resolve(j);
  };
  f.playback.speak('first'); await settle();
  f.jobs[0].player.audioPlayer.ready(); f.jobs[0].player.audioPlayer.ready(); assert.equal(f.jobs[0].plays, 1);
  f.playback.speak('second', { mode: 'immediate' }); await settle();
  f.jobs[0].player.audioPlayer.ready(); assert.equal(f.jobs[0].plays, 1);
  visible = false; f.jobs[1].player.audioPlayer.ready();
  assert.equal(f.jobs[1].plays, 0); assert.equal(f.jobs[1].aborts, 1); assert.equal(f.playback.getState().active, false);
});

test('watchdogs are failures; generated duration alone never confirms playback', async () => {
  const pending = deferred(); const f = fixture({ synthesisTimeoutMs: () => 20, playbackTimeoutMs: () => 30 });
  f.tts.synthesize = () => pending.promise; f.playback.speak('synthesis timeout'); f.advance(20);
  assert.equal(f.events.find(e => e.type === 'error').error.code, 'SPEECH_SYNTHESIS_TIMEOUT');
  const late = f.job(); pending.resolve(late); await settle(); assert.equal(late.plays, 0);
  const j = f.job(); j.task.finished = Promise.resolve({ duration: 0.01 });
  f.tts.synthesize = () => Promise.resolve(j); f.playback.speak('playback timeout'); await settle();
  assert.equal(f.events.filter(e => e.type === 'ended').length, 0);
  f.advance(30); assert.equal(f.events.filter(e => e.type === 'error').at(-1).error.code, 'SPEECH_PLAYBACK_TIMEOUT');
  assert.equal(j.aborts, 1); assert.equal(f.timers.size, 0);
});

test('queued chunk activation is cleared on cancel and rejected play releases its own output', async () => {
  const f = fixture(); const j = f.job(); j.task = Object.assign(new EventTarget(), { state: 'running', abort() { j.aborts++; } });
  f.tts.synthesize = () => Promise.resolve(j); f.playback.speak('chunk'); await settle();
  j.task.dispatchEvent(new Event('chunk')); f.playback.cancel(); f.advance(0); assert.equal(j.plays, 0); assert.equal(f.timers.size, 0);
  const next = f.job(); next.player.play = () => Promise.reject(Error('cannot play'));
  f.tts.synthesize = () => Promise.resolve(next); f.playback.speak('reject'); await settle();
  assert.equal(next.aborts, 1); assert.equal(next.destroys, 1); assert.equal(f.playback.getState().active, false);
});

test('startup callbacks can cancel without synthesis; disposal cannot admit replacement output', async () => {
  let playback;
  const f = fixture({ onEvent(e) { if (e.type === 'synthesizing') playback.cancel(); } });
  playback = f.playback; playback.speak('cancel in callback');
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  playback.dispose(); assert.throws(() => playback.speak('closed'), /SPEECH_PLAYBACK_CLOSED/);
});

test('runtime release owns cleanup exactly once while ASR and the model remain alive', async () => {
  const f = fixture(); let asrStops = 0, modelDestroyed = 0;
  const answer = deferred(), entered = deferred();
  const runtime = createAiuiAssistantRuntime({ asr: { createRound() { return {}; }, start() {}, stop() { asrStops++; } }, tts: f.tts });
  runtime.asr.start(runtime.asr.createRound());
  runtime.createSession({ profile: { systemPrompt: 'test' },
    createModel: () => ({ prompt() { entered.resolve(); return answer.promise; }, destroy() { modelDestroyed++; } }),
    discoverTools: () => ({ tools: [], executeTool() {}, toolPolicy: {
      classify: () => ({ mutation: false }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false })
    } }) });
  const running = runtime.session.run('keep working'); await entered.promise;
  const playback = createSpeechPlayback({ tts: runtime.tts, releaseSpeech: runtime.releaseSpeech, clock: { setTimeout: () => 0, clearTimeout() {} } });
  playback.speak('first'); await settle(); playback.cancel(); playback.cancel();
  assert.equal(f.jobs[0].aborts, 1); assert.equal(f.jobs[0].destroys, 1);
  assert.equal(asrStops, 0); assert.equal(modelDestroyed, 0); assert.equal(runtime.getState().hasRecognitionRound, true);
  assert.equal(runtime.getState().hasSpeechOutput, false);
  answer.resolve('answer'); assert.equal((await running).text, 'answer');
  playback.dispose(); runtime.dispose();
});

test('malformed output and cleanup exceptions do not wedge the queue', async () => {
  const f = fixture(); let aborted = 0;
  f.tts.synthesize = async () => ({ task: { abort() { aborted++; throw Error('cleanup'); } }, player: { destroy() {} } });
  f.playback.speak('invalid'); await settle();
  assert.equal(aborted, 1); assert.equal(f.errors.length, 1); assert.equal(f.playback.getState().active, false);
  assert.equal(f.events.find(e => e.type === 'error').error.code, 'SPEECH_JOB_INVALID');
  f.tts.canSynthesize = () => false;
  assert.equal(f.playback.speak('unavailable'), false); assert.equal(f.events.at(-1).type, 'unavailable');
});
