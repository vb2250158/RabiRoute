import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';
import { createVoiceInteraction, splitSpeechText } from '../src/voice-interaction.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const rounds = [], jobs = [], timers = new Map(), inputs = [], events = [], errors = [];
  let nextTimer = 0, time = 0;
  const clock = { now: () => time, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id) };
  const asr = { createRound(handlers) { const round = { handlers, stopped: 0 }; rounds.push(round); return round; },
    start(round) { round.handlers.onStart(); }, stop(round) { round.stopped++; } };
  const tts = { async synthesize(text, options) {
    const audio = new EventTarget();
    const job = { text, options, played: 0, aborted: 0, destroyed: 0,
      task: { abort() { job.aborted++; } },
      player: { audioPlayer: audio, play() { job.played++; }, destroy() { job.destroyed++; } },
      end() { audio.dispatchEvent(new Event('ended')); } };
    jobs.push(job); return job;
  } };
  const runtime = createAiuiAssistantRuntime({ asr, tts });
  const voice = createVoiceInteraction({ runtime, listening: { clock }, playback: { clock },
    onInput: input => inputs.push(input), onEvent: event => events.push(event), onError: error => errors.push(error), ...options });
  const clean = () => { voice.dispose(); runtime.dispose(); assert.equal(timers.size, 0); };
  return { voice, runtime, rounds, jobs, timers, inputs, events, errors, clock, clean,
    advance() { time += 300; const pending = [...timers]; timers.clear(); for (const [, callback] of pending) callback(); } };
}

test('short sentences stream immediately while decimal/URL chunk boundaries retain their period', async () => {
  assert.deepEqual(splitSpeechText('好的。3.'), { parts: ['好的。'], rest: '3.' });
  const f = fixture(); const output = f.voice.beginResponse();
  output.append('好的。3.'); await flush(); assert.equal(f.jobs[0].text, '好的。');
  output.append('14 和 example.com'); output.finish();
  f.jobs[0].end(); await flush(); assert.equal(f.jobs[1].text, '3.14 和 example.com');
  assert.equal(f.jobs[1].played, 1); f.jobs[1].end(); f.clean();
});

test('speech onset interrupts only playback; late original text is retained without restarting TTS', async () => {
  const f = fixture(); f.voice.activate({ continuous: true });
  const output = f.voice.beginResponse({ id: 'original-work' }); output.append('原任务开始。'); await flush();
  f.rounds[0].handlers.onSpeechStart();
  assert.equal(f.jobs[0].aborted, 1); assert.equal(f.jobs[0].destroyed, 1);
  assert.equal(f.rounds[0].stopped, 0);
  output.append('原任务仍然继续。'); output.finish(); await flush();
  assert.equal(f.jobs.length, 1); assert.equal(output.getState().text, '原任务开始。原任务仍然继续。');
  f.rounds[0].handlers.onFinal({ text: '用户的新话' }); f.rounds[0].handlers.onSpeechEnd();
  assert.equal(f.inputs[0].text, '用户的新话'); assert.equal(f.runtime.getState().inputPending, false);
  f.clean();
});

test('a completed response still stops queued audio on later onset, without a second microphone', async () => {
  const f = fixture(); f.voice.activate();
  const output = f.voice.beginResponse(); output.append('第一句。第二句。'); output.finish(); await flush();
  assert.equal(f.voice.playback.getState().queued, 1);
  f.rounds[0].handlers.onSpeechStart(); await flush();
  assert.equal(f.voice.playback.getState().queued, 0); assert.equal(output.getState().suppressed, true);
  assert.equal(f.rounds.length, 1); f.clean();
});

test('non-echo interim stops audio and stays visible; rejected transcript never reaches the assistant', async () => {
  const f = fixture({ acceptTranscript: text => text !== '回声' }); f.voice.activate();
  const output = f.voice.beginResponse(); output.append('正在播报。'); await flush();
  f.rounds[0].handlers.onInterim({ text: '回声' }); assert.equal(f.jobs[0].aborted, 0);
  f.rounds[0].handlers.onInterim({ text: '新输入' }); assert.equal(f.jobs[0].aborted, 1);
  assert.equal(f.voice.getState().transcript, '新输入');
  f.rounds[0].handlers.onFinal({ text: '回声' }); assert.equal(f.inputs.length, 0); f.clean();
});

test('speechend before final retains foreground input ownership and does not mistake silence for final text', () => {
  const f = fixture(); f.voice.activate(); const handlers = f.rounds[0].handlers;
  handlers.onSpeechStart(); handlers.onInterim({ text: '未完' }); handlers.onSpeechEnd();
  assert.equal(f.runtime.getState().inputPending, true); assert.equal(f.inputs.length, 0);
  handlers.onFinal({ text: '完整输入' }); assert.equal(f.runtime.getState().inputPending, false);
  assert.equal(f.inputs.length, 1); f.clean();
});

test('input callback may create a response synchronously; final event bookkeeping does not permanently mute it', async () => {
  let output;
  const f = fixture({ onInput: () => { output = f.voice.beginResponse(); } }); f.voice.activate();
  const handlers = f.rounds[0].handlers; handlers.onInterim({ text: '你好' }); handlers.onFinal({ text: '你好' });
  output.append('你好。'); output.finish(); await flush(); assert.equal(f.jobs.length, 1); f.clean();
});

test('GUI and optional pet subscribe to one owner; unsubscribing does not stop capture or create another session', () => {
  const f = fixture(), gui = [], pet = [];
  const unGui = f.voice.subscribe(event => gui.push(event)); const unPet = f.voice.subscribe(event => pet.push(event));
  f.voice.activate(); f.voice.submitText('第一句'); unPet(); f.voice.submitText('第二句');
  assert.equal(gui.filter(event => event.type === 'input').length, 2);
  assert.equal(pet.filter(event => event.type === 'input').length, 1);
  assert.equal(f.rounds.length, 1); assert.equal(f.rounds[0].stopped, 0);
  assert.throws(() => createVoiceInteraction({ runtime: f.runtime, onInput() {} }), /ALREADY_ATTACHED/);
  unGui(); f.clean();
});

test('hide retires capture and response callbacks; a new activation cannot revive the old output', async () => {
  const f = fixture(); f.voice.activate(); const old = f.rounds[0].handlers, output = f.voice.beginResponse();
  output.append('开始。'); await flush(); f.voice.suspend();
  old.onFinal({ text: '晚到输入' }); assert.equal(f.inputs.length, 0);
  f.voice.activate(); assert.equal(output.append('晚到输出。'), false);
  assert.equal(f.jobs.length, 1); f.rounds[1].handlers.onFinal({ text: '新输入' });
  assert.equal(f.inputs.length, 1); f.clean();
});

test('normal recognition end resumes through the same lifecycle; errors do not retry forever', () => {
  const f = fixture(); f.voice.activate(); f.rounds[0].handlers.onFinal({ text: '第一轮' });
  f.rounds[0].handlers.onEnd(); f.advance(); assert.equal(f.rounds.length, 2);
  f.rounds[1].handlers.onError(new Error('permission')); f.advance();
  assert.equal(f.rounds.length, 2); assert.equal(f.voice.listening.getState().desired, false); f.clean();
});

test('reentrant disposal during input publication never dispatches an assistant callback', () => {
  const f = fixture(); f.voice.subscribe(event => { if (event.type === 'input') f.voice.dispose(); });
  assert.equal(f.voice.submitText('不派发'), false); assert.equal(f.inputs.length, 0); f.clean();
});

test('a stale response limit cannot cancel the newer response audio; speech options are captured', async () => {
  const f = fixture({ maxResponseChars: 5 }), speech = { voice: 'original', audio: { preferredFormat: 'mp3' } };
  const old = f.voice.beginResponse({ id: 'old' }), next = f.voice.beginResponse({ id: 'next', speech });
  speech.voice = 'changed'; speech.audio.preferredFormat = 'wav';
  next.append('新回复。'); await flush(); assert.equal(f.jobs[0].options.voice, 'original');
  assert.equal(f.jobs[0].options.audio.preferredFormat, 'mp3');
  assert.throws(() => old.append('超过旧回复限制。'), /RESPONSE_LIMIT/);
  assert.equal(f.jobs[0].aborted, 0); f.clean();
});

test('disposal releases only voice resources, retaining the separately owned assistant session', async () => {
  const f = fixture(); let destroyed = 0;
  const session = f.runtime.createSession({ profile: { systemPrompt: 'fixture' },
    createModel: () => ({ prompt: async () => '继续回答', destroy() { destroyed++; } }),
    discoverTools: () => ({ tools: [], executeTool() {}, toolPolicy: { classify: () => ({ mutation: false }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false }) } }) });
  await session.ready(); f.voice.activate(); f.voice.dispose();
  assert.equal(destroyed, 0); assert.equal((await session.run('语音已关闭，工作继续')).text, '继续回答');
  f.runtime.dispose(); assert.equal(destroyed, 1); assert.equal(f.timers.size, 0);
});

test('failed reply tokens close without speaking a tail or cancelling newer audio', async () => {
  const f = fixture();
  const old = f.voice.beginResponse({ id: 'old' }); old.append('未完成尾句');
  const next = f.voice.beginResponse({ id: 'new' }); next.append('当前回答。'); await flush();
  old.finish({ speak: false }); assert.equal(f.jobs[0].aborted, 0);
  next.finish(); next.finish({ speak: false }); assert.equal(f.jobs[0].aborted, 0);
  f.jobs[0].end();
  for (let i = 0; i < 20; i++) {
    const failed = f.voice.beginResponse(); failed.append('不播出的尾句'); failed.finish({ speak: false });
    assert.equal(failed.append('迟到文字'), false);
  }
  await flush(); assert.equal(f.jobs.length, 1); f.clean();
});

test('hidden host preserves both existing and newly arriving text without starting audio', async () => {
  const f = fixture(); f.voice.activate();
  const old = f.voice.beginResponse({ id: 'before-hide' }); old.append('开始播放。'); await flush();
  f.voice.setOutputEnabled(false); f.voice.pauseListening();
  assert.equal(f.jobs[0].destroyed, 1); assert.equal(f.rounds[0].stopped, 1);
  old.append('后台工作仍继续。'); old.finish();
  const hidden = f.voice.beginResponse({ id: 'while-hidden' }); hidden.append('隐藏期间的新结果。'); hidden.finish();
  await flush();
  assert.equal(f.jobs.length, 1);
  assert.equal(old.getState().text, '开始播放。后台工作仍继续。');
  assert.equal(hidden.getState().text, '隐藏期间的新结果。');
  assert.equal(f.events.filter(event => event.type === 'response' && event.finished).length, 2);
  f.clean();
});

test('show enables future audio without opening a microphone or replaying a muted response tail', async () => {
  const f = fixture({ outputEnabled: false });
  const muted = f.voice.beginResponse(); muted.append('隐藏时的未完文字');
  f.voice.setOutputEnabled(true);
  muted.append('现在收尾。'); muted.finish(); await flush();
  assert.equal(f.jobs.length, 0); assert.equal(f.rounds.length, 0);
  const fresh = f.voice.beginResponse(); fresh.append('新的回复。'); fresh.finish(); await flush();
  assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].text, '新的回复。');
  f.jobs[0].end(); f.clean();
});

test('muting output leaves ASR running and input admission independent', async () => {
  const f = fixture(); f.voice.activate(); f.voice.setOutputEnabled(false);
  f.rounds[0].handlers.onFinal({ text: '继续输入' });
  assert.equal(f.rounds[0].stopped, 0); assert.equal(f.inputs[0].text, '继续输入');
  assert.equal(f.voice.submitText('键盘输入'), true); assert.equal(f.inputs.length, 2);
  f.clean();
});

test('reentrant hide during response publication prevents synthesis and retains text', async () => {
  const f = fixture();
  f.voice.subscribe(event => { if (event.type === 'response' && event.text) f.voice.setOutputEnabled(false); });
  const output = f.voice.beginResponse(); output.append('事件回调中隐藏。'); output.finish(); await flush();
  assert.equal(f.jobs.length, 0); assert.equal(output.getState().text, '事件回调中隐藏。');
  f.clean();
});

test('output permission is validated and cannot reactivate a suspended or disposed owner', async () => {
  const f = fixture();
  assert.throws(() => f.voice.setOutputEnabled('true'), /OUTPUT_ENABLED_INVALID/);
  f.voice.suspend(); f.voice.setOutputEnabled(false); f.voice.setOutputEnabled(true);
  assert.equal(f.voice.getState().enabled, false);
  assert.throws(() => f.voice.beginResponse(), /INACTIVE/);
  f.voice.activate(); f.voice.setOutputEnabled(false); f.voice.dispose(); f.voice.setOutputEnabled(true);
  assert.equal(f.voice.getState().outputEnabled, false);
  assert.throws(() => f.voice.beginResponse(), /CLOSED/); f.clean();
});

test('repeated mute is idempotent and actual ended cannot revive the old queue', async () => {
  const f = fixture(); const output = f.voice.beginResponse(); output.append('第一句。第二句。'); output.finish(); await flush();
  f.voice.setOutputEnabled(false); f.voice.setOutputEnabled(false);
  assert.equal(f.jobs[0].aborted, 1); assert.equal(f.jobs[0].destroyed, 1);
  f.voice.setOutputEnabled(true); f.jobs[0].end(); await flush();
  assert.equal(f.jobs.length, 1); assert.equal(f.voice.playback.getState().queued, 0); f.clean();
});

test('a model request accepted before hide completes and projects text without audio', async () => {
  const f = fixture(); let complete, destroyed = 0;
  const session = f.runtime.createSession({ profile: { systemPrompt: 'fixture' },
    createModel: () => ({ prompt: () => new Promise(resolve => { complete = resolve; }), destroy() { destroyed++; } }),
    discoverTools: () => ({ tools: [], executeTool() {}, toolPolicy: { classify: () => ({ mutation: false }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false }) } }) });
  await session.ready();
  const output = f.voice.beginResponse({ id: 'accepted-work' });
  const pending = session.run('继续工作'); await flush();
  assert.equal(typeof complete, 'function');
  f.voice.setOutputEnabled(false); f.voice.pauseListening();
  complete('后台任务已完成。'); const result = await pending;
  output.append(result.text); output.finish(); await flush();
  assert.equal(result.text, '后台任务已完成。'); assert.equal(output.getState().text, result.text);
  assert.equal(destroyed, 0); assert.equal(f.jobs.length, 0);
  f.voice.setOutputEnabled(true); assert.equal(f.rounds.length, 0);
  f.clean(); assert.equal(destroyed, 1);
});
