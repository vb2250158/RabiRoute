import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';
import { createVoiceInteraction } from '../src/voice-interaction.js';

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// Same lifecycle expectations for AIUI callbacks, browser media events and
// desktop queue receipts. These adapters are fixtures, not hardware acceptance.
function host(kind, deferred = false) {
  const rounds = [], jobs = [], inputs = [], text = [];
  let resolveJob;
  const asr = { createRound(handlers) { const round = { handlers, stopped: 0 }; rounds.push(round); return round; },
    start(round) { round.handlers.onStart(); }, stop(round) { round.stopped++; } };
  const tts = { synthesize(value) {
    const callbacks = {};
    const audio = kind === 'browser' ? new EventTarget() : {
      onEnded(fn) { callbacks.ended = fn; }, offEnded(fn) { if (callbacks.ended === fn) delete callbacks.ended; },
      onError(fn) { callbacks.error = fn; }, offError(fn) { if (callbacks.error === fn) delete callbacks.error; },
      ...(kind === 'aiui' ? { onCanplay(fn) { callbacks.ready = fn; }, offCanplay(fn) { if (callbacks.ready === fn) delete callbacks.ready; } } : {})
    };
    const job = { text: value, played: 0, stopped: 0, destroyed: 0, aborted: 0,
      task: { abort() { job.aborted++; } },
      player: { audioPlayer: audio, play() { job.played++; }, stop() { job.stopped++; }, destroy() { job.destroyed++; } },
      ready() { callbacks.ready?.(); },
      end() { if (kind === 'browser') audio.dispatchEvent(new Event('ended')); else callbacks.ended?.(); }
    };
    jobs.push(job);
    return deferred ? new Promise(resolve => { resolveJob = () => resolve(job); }) : Promise.resolve(job);
  } };
  const runtime = createAiuiAssistantRuntime({ asr, tts });
  const voice = createVoiceInteraction({ runtime, onInput: input => inputs.push(input),
    onEvent: event => { if (event.type === 'response') text.push(event); } });
  return { voice, runtime, rounds, jobs, inputs, text, resolve: () => resolveJob(),
    dispose() { voice.dispose(); runtime.dispose(); } };
}

for (const kind of ['aiui', 'browser', 'desktop-queue']) {
  test(`${kind}: hide/show retains assistant text, releases audio once and never opens capture on show`, async () => {
    const f = host(kind); f.voice.activate(); const callbacks = f.rounds[0].handlers;
    const current = f.voice.beginResponse({ id: 'current' }); current.append('第一句。'); await flush(); f.jobs[0].ready();
    assert.equal(f.jobs[0].played, 1);
    f.voice.setOutputEnabled(false); f.voice.pauseListening();
    current.append('隐藏后继续的文字。'); current.finish();
    const next = f.voice.beginResponse({ id: 'next' }); next.append('新的后台结果。'); next.finish();
    callbacks.onFinal({ text: '旧识别结果' }); f.jobs[0].ready(); f.jobs[0].end(); await flush();
    assert.equal(f.inputs.length, 0); assert.equal(f.jobs.length, 1);
    assert.equal(f.jobs[0].stopped, 1); assert.equal(f.jobs[0].destroyed, 1);
    assert.ok(f.text.some(event => event.id === 'next' && event.text === '新的后台结果。'));
    f.voice.setOutputEnabled(true); await flush(); assert.equal(f.rounds.length, 1); assert.equal(f.jobs.length, 1);
    const fresh = f.voice.beginResponse({ id: 'fresh' }); fresh.append('重新打开后的新结果。'); fresh.finish();
    await flush(); f.jobs[1].ready(); assert.equal(f.jobs[1].played, 1); f.jobs[1].end();
    f.dispose();
  });

  test(`${kind}: pending synthesis resolving after hide cannot play after show`, async () => {
    const f = host(kind, true); const output = f.voice.beginResponse(); output.append('合成尚未完成。'); await flush();
    f.voice.setOutputEnabled(false); f.voice.setOutputEnabled(true); f.resolve(); await flush();
    f.jobs[0].ready(); f.jobs[0].end();
    assert.equal(f.jobs[0].played, 0); assert.equal(f.jobs[0].destroyed, 1);
    output.append('迟到的完整文字。'); output.finish(); await flush();
    assert.equal(f.jobs.length, 1); assert.equal(output.getState().text, '合成尚未完成。迟到的完整文字。');
    f.dispose();
  });
}
