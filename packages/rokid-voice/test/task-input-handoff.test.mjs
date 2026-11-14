import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskInputHandoffBuffer } from '../src/task-input-handoff.js';
import { createTaskUtteranceBuffer } from '../src/task-input.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
function fixture(options = {}) {
  let sequence = 0;
  return createTaskInputHandoffBuffer({ scope: 'backend/host/generation/task',
    createHandoffId: () => 'handoff-' + (++sequence), schedule: () => 1, unschedule() {},
    retain: async input => ({ status: 'retained', handoffId: input.handoffId }), ...options });
}

test('asynchronous retention keeps the original batch while receiving new speech', async () => {
  const pending = deferred(), requests = [];
  const buffer = fixture({ retain: input => { requests.push(input); return pending.promise; } });
  buffer.final({ resultId: 'one', text: '  C:\\My Folder\\file.js\n  next();  ' });
  const completion = buffer.flush();
  await tick();
  buffer.speechStart();
  assert.equal(buffer.final({ resultId: 'two', text: '第二批' }).accepted, true);
  buffer.speechEnd();
  assert.equal(buffer.peek().text, '第二批');
  assert.equal(buffer.handoffs()[0].packet.text, '  C:\\My Folder\\file.js\n  next();  ');
  assert.equal(requests.length, 1);
  pending.resolve({ status: 'retained', handoffId: 'handoff-1' });
  assert.equal((await completion).status, 'retained');
  assert.equal(buffer.handoffs().length, 0);
  assert.equal(buffer.dispose().draft.text, '第二批');
});

test('failed retention preserves text and retries only explicitly with the same id', async () => {
  const requests = [];
  const buffer = fixture({ retain: async input => {
    requests.push(input);
    if (requests.length === 1) throw Object.assign(new Error('write failed'), { code: 'STORE_FAILED' });
    return { status: 'retained', handoffId: input.handoffId };
  } });
  buffer.final({ resultId: 'one', text: '保留\n  原文' });
  const failed = await buffer.flush();
  assert.equal(failed.status, 'unconfirmed');
  assert.equal(failed.code, 'STORE_FAILED');
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(buffer.handoffs()[0].packet.text, '保留\n  原文');
  assert.equal((await buffer.retryHandoff(failed.handoffId)).status, 'retained');
  assert.deepEqual(requests[0], requests[1]);
  buffer.dispose();
});

test('dispose returns unresolved ownership and late receipts do not touch another task', async () => {
  const pending = deferred(), notices = [];
  const buffer = fixture({ retain: () => pending.promise, onSettled: result => notices.push(result) });
  buffer.final({ resultId: 'one', text: '原任务' });
  const completion = buffer.flush();
  buffer.final({ resultId: 'two', text: '尚未交接' });
  const released = buffer.dispose();
  assert.equal(released.draft.text, '尚未交接');
  assert.equal(released.handoffs[0].packet.text, '原任务');
  const other = fixture({ scope: 'backend/host/next/task' });
  assert.throws(() => other.restoreHandoff(released.handoffs[0]), /DRAFT_INVALID/);
  pending.resolve({ status: 'retained', handoffId: 'handoff-1' });
  assert.equal((await completion).status, 'retained');
  assert.equal((await released.handoffs[0].completion).packet.scope, 'backend/host/generation/task');
  assert.equal(notices.length, 0);
  assert.equal(other.handoffs().length, 0);
  other.dispose();
});

test('restored handoffs retain their original id, conflict checks and explicit retry', async () => {
  const source = fixture({ retain: async () => { throw new Error('offline'); } });
  source.final({ resultId: 'one', text: '旧草稿' });
  await source.flush();
  const original = source.dispose().handoffs[0];
  let writes = 0;
  const next = fixture({ retain: async value => { writes++; return { status: 'retained', handoffId: value.handoffId }; } });
  next.restoreHandoff(original);
  next.restoreHandoff(original);
  await tick();
  assert.equal(writes, 0);
  assert.throws(() => next.restoreHandoff({ ...original,
    packet: { ...original.packet, text: '冲突', segments: [{ resultId: 'one', text: '冲突' }] } }), /ID_CONFLICT/);
  await next.retryHandoff(original.handoffId);
  assert.equal(writes, 1);
  next.dispose();
});

test('capacity, invalid receipts and colliding IDs preserve the untransferred batch', async () => {
  const buffer = fixture({ capacity: 1, createHandoffId: () => 'fixed',
    retain: async () => ({ status: 'retained', handoffId: 'wrong' }) });
  buffer.final({ resultId: 'one', text: '第一批' });
  assert.equal((await buffer.flush()).code, 'TASK_HANDOFF_RECEIPT_INVALID');
  buffer.final({ resultId: 'two', text: '第二批' });
  assert.equal((await buffer.flush()).accepted, false);
  const released = buffer.dispose();
  assert.equal(released.draft.text, '第二批');
  assert.equal(released.handoffs[0].packet.text, '第一批');
  const reused = fixture({ createHandoffId: () => 'fixed' });
  reused.final({ resultId: 'one', text: '先保存' });
  await reused.flush();
  reused.final({ resultId: 'two', text: '后保存' });
  assert.equal((await reused.flush()).accepted, false);
  assert.equal(reused.dispose().draft.text, '后保存');
});

test('raw whitespace survives current drafts and normalized legacy drafts still restore', () => {
  const buffer = createTaskUtteranceBuffer({ scope: 'scope', schedule: () => 1, unschedule() {}, onReady: () => false });
  buffer.final({ resultId: 'one', text: '\tif (x) {\n  run();\n}\n' });
  const draft = buffer.dispose();
  const next = createTaskUtteranceBuffer({ scope: 'scope', onReady: () => false });
  next.restoreDraft(draft);
  assert.equal(next.peek().text, draft.text);
  next.dispose();
  const legacy = createTaskUtteranceBuffer({ scope: 'scope', onReady: () => false });
  legacy.restoreDraft({ scope: 'scope', silenceMs: 5000, text: 'old normalized text',
    segments: [{ resultId: 'old', text: 'old normalized text' }] });
  assert.equal(legacy.peek().text, 'old normalized text');
  legacy.dispose();
});
