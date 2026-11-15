import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelHistory } from '../utils/model-history.js';
const scope = 'a'.repeat(64);
const options = { initialPrompts: [{ role: 'system', content: 'persona' }] };
function fixture() {
  const values = new Map();
  const storage = { read: key => values.get(key), write: (key, value) => values.set(key, structuredClone(value)) };
  return { values, storage, history: () => createModelHistory({ ...storage, scope }) };
}
test('reopen restores exact hidden observations and completed exchanges, isolated by persona', async () => {
  const f = fixture(), first = f.history();
  const model = await first.createModel(async () => ({ prompt: async () => 'remembered', destroy() {} }), options);
  const input = JSON.stringify({ protocol: 'rabi-agent/v1', kind: 'input', text: 'hello',
    speechObservation: { source: 'speech-recognition', estimates: { emotion: 'happy' } } });
  await model.prompt(input); model.destroy();
  let received;
  await f.history().createModel(async value => { received = value; return {}; }, options);
  assert.deepEqual(received.initialPrompts, [...options.initialPrompts, { role: 'user', content: input }, { role: 'assistant', content: 'remembered' }]);
  assert.deepEqual(createModelHistory({ ...f.storage, scope: 'b'.repeat(64) }).seed(), []);
});
test('stream commits only at done; interruption/destroy never resurrect late text', async () => {
  const f = fixture(); let resolve;
  const model = await f.history().createModel(async () => ({ promptStreaming: () => ({ read: () => new Promise(r => resolve = r), cancel() {} }), destroy() {} }), options);
  const stream = model.promptStreaming('pending'); const reading = stream.read(); model.destroy();
  resolve({ done: false, value: 'late' });
  await assert.rejects(reading, { code: 'AIUI_MODEL_HISTORY_CLOSED' });
  assert.deepEqual(f.history().seed(), []);
  assert.equal(f.history().recent()[0].state, 'failed');
});
test('physical parts retain original order across reopen; context limit never deletes originals', async () => {
  const f = fixture(), h = f.history();
  const model = await h.createModel(async () => ({ prompt: async input => 'answer:' + input, destroy() {} }), options);
  for (let i = 0; i < 35; i++) await model.prompt('question:' + i);
  assert.equal(h.recent(64).length, 35);
  assert.deepEqual(h.recent(64).map(row => row.sequence), Array.from({ length: 35 }, (_, i) => i + 1));
  assert.equal(createModelHistory({ ...f.storage, scope, contextChars: 60 }).seed().length, 2);
  assert.equal(h.recent(64).length, 35);
});
test('storage failure prevents model dispatch, and failed request cannot replay', async () => {
  let called = false;
  const h = createModelHistory({ scope, read: () => undefined, write() { throw Error('full'); } });
  const model = await h.createModel(async () => ({ prompt() { called = true; }, destroy() {} }), options);
  await assert.rejects(model.prompt('test'), { code: 'AIUI_MODEL_HISTORY_STORAGE_FAILED' });
  assert.equal(called, false);
});
test('native JSON storage may reorder object keys without changing the persisted value', async () => {
  const f = fixture();
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value;
  const h = createModelHistory({ scope, read: key => reorder(f.storage.read(key)), write: f.storage.write });
  const model = await h.createModel(async () => ({ prompt: async () => 'answer', destroy() {} }), options);
  assert.equal(await model.prompt('hello'), 'answer');
  assert.equal(h.seed().length, 2);
});
test('an index publication failure never dispatches; retry reuses only the unpublished slot', async () => {
  const f = fixture(); let rejectIndex = true, calls = 0;
  const h = createModelHistory({ scope, read: f.storage.read, write(key, value) {
    if (key.endsWith(':index') && rejectIndex) { rejectIndex = false; throw Error('interrupted'); }
    f.storage.write(key, value);
  } });
  const model = await h.createModel(async () => ({ prompt: async () => { calls++; return 'done'; } }), options);
  await assert.rejects(model.prompt('not dispatched'), { code: 'AIUI_MODEL_HISTORY_STORAGE_FAILED' });
  assert.equal(calls, 0);
  await model.prompt('retry after storage recovers');
  assert.equal(calls, 1);
  assert.equal(h.recent().length, 1);
  assert.equal(h.recent()[0].sequence, 1);
  assert.equal(h.recent()[0].input[0].content, 'retry after storage recovers');
});
test('a late model owner cannot overwrite another owner or publish stale history', async () => {
  const f = fixture(); let release;
  const old = await f.history().createModel(async () => ({ prompt: () => new Promise(resolve => release = resolve) }), options);
  const pending = old.prompt('old');
  const newer = await f.history().createModel(async () => ({ prompt: async () => 'new reply' }), options);
  await newer.prompt('new'); release('old reply');
  await assert.rejects(pending, { code: 'AIUI_MODEL_HISTORY_OWNER_CHANGED' });
  assert.deepEqual(f.history().seed(), [{ role: 'user', content: 'new' }, { role: 'assistant', content: 'new reply' }]);
});
