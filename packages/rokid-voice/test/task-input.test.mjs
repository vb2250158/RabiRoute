import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskUtteranceBuffer } from '../src/task-input.js';
import { createAiuiAsrInputAdapter } from '../src/voice-runtime.js';

function fixture(options = {}) {
  let now = 0, id = 0, interruptions = 0;
  const jobs = new Map(), history = [], delivered = [];
  const buffer = createTaskUtteranceBuffer({ scope: 'dsh/host-a/generation-1/task-a',
    schedule(fn, ms) { const handle = ++id; jobs.set(handle, { fn, at: now + ms }); history.push(fn); return handle; },
    unschedule: handle => jobs.delete(handle), onInterrupt: () => { interruptions++; },
    onReady: packet => { delivered.push(packet); return true; }, ...options });
  function advance(ms) {
    now += ms;
    for (const [handle, job] of [...jobs]) if (job.at <= now) { jobs.delete(handle); job.fn(); }
  }
  return { buffer, delivered, advance, history, interruptions: () => interruptions };
}
const final = (buffer, resultId, text) => buffer.final({ resultId, text });

test('speech interrupts immediately and continuous finals merge only after five seconds of silence', () => {
  const f = fixture(); f.buffer.speechStart(); assert.equal(f.interruptions(), 1);
  final(f.buffer, 'one', '先查文档'); f.advance(6000); assert.equal(f.delivered.length, 0);
  f.buffer.speechEnd(); f.advance(4000); assert.equal(f.delivered.length, 0);
  f.buffer.speechStart(); f.advance(5000); assert.equal(f.delivered.length, 0);
  final(f.buffer, 'two', '再核对接口'); f.buffer.speechEnd();
  f.advance(4999); assert.equal(f.delivered.length, 0); f.advance(1);
  assert.equal(f.delivered[0].text, '先查文档 再核对接口'); assert.equal(f.delivered[0].segments.length, 2);
});

test('configuration changes apply to the next utterance and do not shorten a pending batch', () => {
  const f = fixture(); f.buffer.speechStart();
  assert.equal(f.buffer.configure({ silenceMs: 1000 }).deferred, true);
  final(f.buffer, 'one', '第一段'); f.buffer.speechEnd(); f.advance(1000); assert.equal(f.delivered.length, 0);
  f.advance(4000); assert.equal(f.delivered[0].silenceMs, 5000);
  final(f.buffer, 'two', '第二段'); f.advance(1000); assert.equal(f.delivered[1].silenceMs, 1000);
});

test('interim text and speech-end cannot submit before final recognition arrives', () => {
  const f = fixture(); f.buffer.speechStart(); f.buffer.interim('未确认文字'); f.buffer.speechEnd();
  f.advance(20000); assert.equal(f.delivered.length, 0); assert.equal(f.buffer.flush().accepted, false);
  final(f.buffer, 'one', '完整最终文字'); f.advance(5000);
  assert.equal(f.delivered[0].text, '完整最终文字');
});

test('a timer invalidated by fresh speech cannot submit even if its callback arrives late', () => {
  const f = fixture(); final(f.buffer, 'one', '先查'); const late = f.history.at(-1);
  f.buffer.speechStart(); late(); assert.equal(f.delivered.length, 0);
  final(f.buffer, 'two', '等等'); f.buffer.speechEnd(); f.advance(5000);
  assert.equal(f.delivered[0].text, '先查 等等');
});

test('duplicate ASR result IDs are not appended and conflicting reuse fails explicitly', () => {
  const f = fixture(); final(f.buffer, 'one', '查询');
  assert.equal(final(f.buffer, 'one', '查询').duplicate, true);
  assert.throws(() => final(f.buffer, 'one', '另一条'), /TASK_INPUT_SEGMENT_CONFLICT/);
  f.advance(5000); assert.equal(f.delivered[0].segments.length, 1);
  assert.equal(final(f.buffer, 'one', '查询').duplicate, true); f.advance(5000); assert.equal(f.delivered.length, 1);
});

test('a busy receiver retains input without automatic retries or invented delivery receipts', () => {
  let ready = false, attempts = 0;
  const f = fixture({ onReady: () => { attempts++; return ready; } }); final(f.buffer, 'one', '等待接收');
  f.advance(5000); assert.equal(attempts, 1); assert.equal(f.buffer.peek().text, '等待接收');
  f.advance(30000); assert.equal(attempts, 1);
  ready = true; assert.equal(f.buffer.flush().accepted, true); assert.equal(f.buffer.peek(), null);
});

test('overflow retains accepted text but never automatically dispatches a truncated command', () => {
  const f = fixture(); final(f.buffer, 'one', '字'.repeat(16000));
  assert.equal(final(f.buffer, 'two', '不应丢失后半句').reason, 'input-full');
  f.advance(10000); assert.equal(f.delivered.length, 0); assert.equal(f.buffer.peek().text.length, 16000);
});

test('leaving, muting or recognition failure fences late events and returns only unsent finals', () => {
  for (const cause of ['leave', 'mute', 'recognition-error']) {
    const f = fixture(); final(f.buffer, cause, '未发出的输入'); const late = f.history.at(-1);
    f.buffer.interim('未确认的后半句');
    const draft = f.buffer.dispose(); late();
    assert.equal(final(f.buffer, 'late', '迟到').reason, 'closed');
    assert.equal(f.buffer.speechStart(), false); f.advance(10000);
    assert.equal(draft.text, '未发出的输入'); assert.equal(f.delivered.length, 0);
  }
});

test('a draft cannot cross task/Host bindings and restoring it requires explicit resumption', () => {
  const old = fixture(); final(old.buffer, 'one', '保留草稿'); const draft = old.buffer.dispose();
  const other = fixture({ scope: 'dsh/host-b/generation-2/task-b' });
  assert.throws(() => other.buffer.restoreDraft(draft), /TASK_INPUT_DRAFT_INVALID/);
  const restored = fixture(); restored.buffer.restoreDraft(draft); restored.advance(10000);
  assert.equal(restored.delivered.length, 0); restored.buffer.resumeDraft(); restored.advance(5000);
  assert.equal(restored.delivered[0].scope, draft.scope); assert.equal(restored.delivered[0].text, draft.text);
});

test('receiver exceptions retain the draft and callback reentrancy cannot inject a second batch', () => {
  const bad = fixture({ onReady() { throw Error('queue storage failed'); } });
  final(bad.buffer, 'one', '保留'); bad.advance(5000);
  assert.equal(bad.buffer.getState().retainedReason, 'receiver-error'); assert.ok(bad.buffer.peek());
  let reply; const f = fixture({ onReady() { reply = final(f.buffer, 'two', '重入'); return true; } });
  final(f.buffer, 'one', '原始'); f.advance(5000); assert.equal(reply.reason, 'offering');
});

test('host speech-end forwards to the buffer and stopped rounds ignore late boundaries', () => {
  class Recognition { start() {} abort() {} }
  const asr = createAiuiAsrInputAdapter({ SpeechRecognitionCtor: Recognition });
  const f = fixture();
  const round = asr.createRound({ onSpeechStart: () => f.buffer.speechStart(), onSpeechEnd: () => f.buffer.speechEnd(), onFinal: value => f.buffer.final(value) });
  round.onspeechstart({}); round.onresult({ results: [Object.assign([{ transcript: '真实事件形状' }], { isFinal: true })] });
  f.advance(5000); assert.equal(f.delivered.length, 0);
  round.onspeechend({}); f.advance(5000); assert.equal(f.delivered[0].text, '真实事件形状');
  asr.stop(round); round.onspeechstart({}); assert.equal(f.buffer.getState().speaking, false);
});

test('invalid configuration and drafts cannot alter active state', () => {
  const f = fixture(); assert.throws(() => f.buffer.configure({ silenceMs: -1 }), /INTERVAL_INVALID/);
  assert.equal(f.buffer.getState().silenceMs, 5000);
  assert.throws(() => f.buffer.restoreDraft({ scope: 'other', segments: [] }), /DRAFT_INVALID/);
  assert.equal(f.buffer.peek(), null);
});
