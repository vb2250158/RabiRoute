import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createTaskFollowRuntime } from '../utils/task-follow-runtime.js';
import { createAiuiAssistantRuntime } from '../../../packages/assistant-runtime/src/aiui-runtime.js';
import { rabiAgentProtocol } from '../utils/agent-decision-protocol.js';
import { rabiAgentToolPolicy } from '../utils/rabi-agent-tool-policy.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const done = (status = 'done', value = 'original result') => ({ structuredContent: { ok: true, data: { code: 0, data: { status, value } } } });
const watch = extra => ({ action: 'watch', taskId: 'original-job', path: '/api/jobs/original-job',
  statusPointer: '/data/status', terminalValues: ['done', 'failed'], resultPointer: '/data', ...extra });
const invoke = (runtime, args) => runtime.handleToolCall({ isComplete: true, functionName: 'rabi_task_follow', arguments: args });
function fixture(extra = {}) {
  const data = new Map(), requests = [];
  const storage = { getStorageSync: key => structuredClone(data.get(key)), setStorageSync: (key, value) => data.set(key, structuredClone(value)) };
  const options = { storage, scope: 'fixture-bound-profile', ownerId: 'owner-1', defaultTargetDeviceId: 'pc-original',
    read: async packet => { requests.push(packet); return done(); }, isCurrent: () => true, now: () => 1000, ...extra };
  return { data, storage, options, requests, runtime: createTaskFollowRuntime(options) };
}

test('a saved original subscription reads only its original target and survives restart without redispatching work', async () => {
  const f = fixture();
  const row = (await invoke(f.runtime, watch({}))).result.structuredContent.data;
  assert.equal((await invoke(f.runtime, watch({}))).result.structuredContent.data.id, row.id);
  assert.equal(f.requests.length, 0);
  f.runtime.dispose();
  const restored = createTaskFollowRuntime({ ...f.options, ownerId: 'owner-2' });
  await restored.poll();
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/api/jobs/original-job', targetDeviceId: 'pc-original' }]);
  assert.equal(restored.pending()[0].observation.body.result.value, 'original result');
  restored.saveSummary(row.id, '原任务已经完成。');
  restored.dispose();
  const again = createTaskFollowRuntime({ ...f.options, ownerId: 'owner-3' });
  assert.equal(again.pending()[0].summary, '原任务已经完成。');
  await again.poll(); assert.equal(f.requests.length, 1);
  assert.equal(again.receipts.acknowledge(f.options.scope, row.id), true);
  assert.equal(again.pending().length, 0);
  const saved = (await invoke(again, { action: 'read', id: row.id })).result.structuredContent.data;
  assert.equal(saved.state, 'announced'); assert.equal(saved.summary, '原任务已经完成。');
});

test('storage failure prevents polling an unsaved subscription; stopping during a read prevents notification', async () => {
  const f = fixture(), setter = f.storage.setStorageSync;
  f.storage.setStorageSync = () => {};
  await assert.rejects(invoke(f.runtime, watch({})), /TASK_SAVE_UNCONFIRMED/);
  await f.runtime.poll(); assert.equal(f.requests.length, 0);
  f.storage.setStorageSync = setter;
  const pending = deferred();
  const runtime = createTaskFollowRuntime({ ...f.options, ownerId: 'owner-2', read: () => pending.promise });
  const row = (await invoke(runtime, watch({}))).result.structuredContent.data;
  const polling = runtime.poll(); await tick();
  await invoke(runtime, { action: 'stop', id: row.id });
  pending.resolve(done()); await polling;
  assert.deepEqual(runtime.pending(), []);
});

test('replacement ownership rejects a late status and isolates another persona scope', async () => {
  const pending = deferred(), f = fixture({ read: () => pending.promise });
  await invoke(f.runtime, watch({}));
  const polling = f.runtime.poll(); await tick();
  const replacement = createTaskFollowRuntime({ ...f.options, ownerId: 'owner-2', read: async () => done() });
  const before = structuredClone([...f.data]);
  pending.resolve(done('done', 'obsolete'));
  await assert.rejects(polling, /TASK_SCOPE_CHANGED/);
  assert.deepEqual([...f.data], before);
  assert.deepEqual(replacement.pending(), []);
  const other = createTaskFollowRuntime({ ...f.options, scope: 'another-persona', ownerId: 'owner-3' });
  assert.equal((await invoke(other, { action: 'list' })).result.structuredContent.data.records.length, 0);
});

test('invalid pointers, unknown states and oversized results never become a completion notification', async () => {
  for (const response of [done(42), done('done', 'x'.repeat(61000)), { structuredContent: { ok: false, uncertain: true } }]) {
    const f = fixture({ read: async () => response });
    await invoke(f.runtime, watch({})); await f.runtime.poll();
    assert.equal(f.runtime.pending().length, 0);
    assert.ok((await invoke(f.runtime, { action: 'list' })).result.structuredContent.data.records[0].lastError);
  }
  const f = fixture();
  for (const extra of [{ statusPointer: '/bad~escape' }, { terminalValues: [1] }, { method: 'POST' },
    { headers: { authorization: 'do-not-store' } }, { intervalMs: 0 }, { path: '//other.invalid' }]) {
    await assert.rejects(invoke(f.runtime, watch(extra)));
  }
  assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify([...f.data]).includes('do-not-store'));
});

test('tool registration snapshots the original arguments before asynchronous processing', async () => {
  const f = fixture(), args = watch({});
  const pending = invoke(f.runtime, args);
  args.path = '/api/jobs/replaced'; args.terminalValues.push('running');
  const saved = (await pending).result.structuredContent.data;
  assert.equal(saved.task.path, '/api/jobs/original-job');
  assert.deepEqual(saved.task.terminalValues, ['done', 'failed']);
  await assert.rejects(invoke(f.runtime, '{broken JSON'), /TASK_ARGUMENTS_INVALID/);
  await f.runtime.poll(); assert.equal(f.requests[0].path, '/api/jobs/original-job');
});

test('an announced journal row without a persisted summary cannot suppress a notification', async () => {
  const f = fixture(); await invoke(f.runtime, watch({})); await f.runtime.poll();
  const [key, journal] = [...f.data][0]; journal.rows[0].state = 'announced';
  f.data.set(key, journal);
  assert.throws(() => createTaskFollowRuntime({ ...f.options, ownerId: 'replacement' }), /TASK_JOURNAL_INVALID/);
});

test('sixteen active subscriptions are bounded while original reads and stop remain available', async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) await invoke(f.runtime, watch({ taskId: 'job-' + i, path: '/api/jobs/' + i }));
  await assert.rejects(invoke(f.runtime, watch({})), /TASK_WATCH_FULL/);
  const rows = (await invoke(f.runtime, { action: 'list' })).result.structuredContent.data.records;
  await invoke(f.runtime, { action: 'stop', id: rows[0].id });
  await invoke(f.runtime, watch({}));
  assert.equal((await invoke(f.runtime, { action: 'read', id: rows[0].id })).result.structuredContent.data.state, 'stopped');
});

async function pageFixture(f = fixture()) {
  const timers = new Map(), spoken = [], modelInputs = [], patches = [];
  let nextTimer = 0, acknowledgeRender = null, finishModel = null;
  const source = (await fs.readFile(new URL('../utils/task-follow-page.js', import.meta.url), 'utf8'))
    .replace('export const taskFollowPageMethods', 'const taskFollowPageMethods');
  const methods = vm.runInNewContext(source + '\ntaskFollowPageMethods', {
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id), Set
  });
  const aiui = createAiuiAssistantRuntime({ asr: { createRound: handlers => handlers, start() {}, stop() {} },
    tts: { synthesize: async () => ({ task: {}, player: {} }) } });
  const assistant = aiui.createSession({ profile: { systemPrompt: 'Always retain the configured prefix.' }, protocol: rabiAgentProtocol,
    discoverTools: () => ({ tools: [], executeTool: () => { throw Error('no notification tools'); }, toolPolicy: rabiAgentToolPolicy }),
    createModel: () => ({ prompt(input) { const value = JSON.parse(input[0].content); modelInputs.push(value);
      if (value.kind === 'user-input') return '前台回答';
      return new Promise(resolve => { finishModel = resolve; }); }, destroy() {} }) });
  await assistant.ready();
  const p = { ...methods, pageVisible: true, destroyed: false, data: {}, aiuiRuntime: aiui,
    chatAssistant: assistant, taskFollowRuntime: f.runtime, deviceAgentTurnActive: false,
    setData(patch, callback) { patches.push(patch); Object.assign(this.data, patch); acknowledgeRender = callback; },
    speakText(text) { spoken.push(text); }, cleanupChatModel() { this.stopTaskFollow(); } };
  const runTimer = () => { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback(); };
  return { ...f, p, aiui, spoken, modelInputs, patches, runTimer,
    finishSummary: text => finishModel(text), rendered: () => acknowledgeRender?.() };
}

test('page waits for speech input, serializes the same model and acknowledges only after durable summary plus UI callback', async () => {
  const f = await pageFixture();
  const row = (await invoke(f.runtime, watch({}))).result.structuredContent.data;
  const round = f.aiui.asr.createRound({}); round.onSpeechStart();
  f.p.startTaskFollow(); await f.runTimer();
  assert.equal(f.modelInputs.length, 0);
  round.onFinal('用户先说'); round.onSpeechEnd();
  assert.equal((await f.p.chatConversation.run('用户先说')).text, '前台回答');
  const notification = f.runTimer(); await tick();
  assert.equal(f.modelInputs[1].kind, 'task-observation');
  assert.equal(f.modelInputs[1].observation.body.result.value, 'original result');
  f.finishSummary('原任务完成了。'); await tick();
  assert.equal(f.runtime.pending()[0].summary, '原任务完成了。');
  assert.equal(f.runtime.receipts.has(f.options.scope, row.id), false);
  assert.equal(f.spoken.length, 0);
  f.rendered(); await notification;
  assert.equal(f.runtime.receipts.has(f.options.scope, row.id), true);
  assert.deepEqual(f.spoken, ['原任务完成了。']);
  f.p.stopTaskFollow(); f.aiui.dispose();
});

test('new user speech during summary defers presentation and saved summary does not invoke the model again', async () => {
  const f = await pageFixture(); await invoke(f.runtime, watch({}));
  f.p.startTaskFollow(); const notification = f.runTimer(); await tick();
  f.p.deviceAgentTurnActive = true;
  f.finishSummary('保存的后台结果'); await notification;
  assert.equal(f.patches.length, 0); assert.equal(f.runtime.pending()[0].summary, '保存的后台结果');
  f.p.deviceAgentTurnActive = false;
  const display = f.runTimer(); await tick(); f.rendered(); await display;
  assert.equal(f.modelInputs.length, 1); assert.deepEqual(f.spoken, ['保存的后台结果']);
  f.p.stopTaskFollow(); f.aiui.dispose();
});

test('page reopen presents a durably saved summary without regenerating or repolling it', async () => {
  const original = fixture();
  const row = (await invoke(original.runtime, watch({}))).result.structuredContent.data;
  await original.runtime.poll(); original.runtime.saveSummary(row.id, '重开后仍保存的结果'); original.runtime.dispose();
  const runtime = createTaskFollowRuntime({ ...original.options, ownerId: 'replacement' });
  const f = await pageFixture({ ...original, runtime });
  f.p.startTaskFollow(); const display = f.runTimer(); await tick(); f.rendered(); await display;
  assert.equal(f.modelInputs.length, 0); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.spoken, ['重开后仍保存的结果']);
  f.p.stopTaskFollow(); f.aiui.dispose();
});

test('stopping while the model summarizes retires its observation without presentation or a leaked queue slot', async () => {
  const f = await pageFixture();
  const row = (await invoke(f.runtime, watch({}))).result.structuredContent.data;
  f.p.startTaskFollow(); const notification = f.runTimer(); await tick();
  await invoke(f.runtime, { action: 'stop', id: row.id });
  f.finishSummary('不会显示的旧结果'); await notification;
  assert.equal(f.patches.length, 0); assert.equal(f.spoken.length, 0);
  assert.equal(f.p.chatConversation.getState().retainedObservations, 0);
  f.p.stopTaskFollow(); f.aiui.dispose();
});

test('stopping while the display callback is pending prevents speech and retires the observation', async () => {
  const f = await pageFixture();
  const row = (await invoke(f.runtime, watch({}))).result.structuredContent.data;
  f.p.startTaskFollow(); const notification = f.runTimer(); await tick();
  f.finishSummary('即将停掉的通知'); await tick();
  await invoke(f.runtime, { action: 'stop', id: row.id });
  f.rendered(); await notification; await f.runTimer();
  assert.equal(f.spoken.length, 0);
  assert.equal(f.p.chatConversation.getState().retainedObservations, 0);
  assert.equal((await invoke(f.runtime, { action: 'read', id: row.id })).result.structuredContent.data.state, 'stopped');
  f.p.stopTaskFollow(); f.aiui.dispose();
});

test('queued playback blocks background generation even before speaking flags update', async () => {
  const f = await pageFixture(); await invoke(f.runtime, watch({}));
  f.p.speechPlayback = { getState: () => ({ active: false, queued: 1 }) };
  f.p.startTaskFollow(); await f.runTimer();
  assert.equal(f.modelInputs.length, 0); assert.equal(f.patches.length, 0);
  f.p.stopTaskFollow(); f.aiui.dispose();
});
