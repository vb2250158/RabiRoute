import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantSession } from '../src/assistant-session.js';
import { createAssistantConversation } from '../src/conversation-runtime.js';
import { createAiuiAssistantRuntime } from '../src/aiui-runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const event = (id = 'event-1') => ({ id, scope: 'host-a/backend/task', kind: 'turn/end', status: 'idle', body: { text: '一轮结束' } });
const policy = { classify: () => ({ mutation: true }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false }) };
function fixture(prompt, extra = {}) {
  const seen = new Set(), calls = [], text = [];
  let modelCreations = 0;
  const receipts = {
    has: (scope, id) => seen.has(scope + id),
    acknowledge: (scope, id) => { seen.add(scope + id); return true; }
  };
  const session = createAssistantSession({ profile: { systemPrompt: '请使用中文，据实际任务状态回复。' },
    createModel: () => { modelCreations++; return { prompt: input => prompt(JSON.parse(input[0].content)), destroy() {} }; },
    discoverTools: () => ({ tools: [{ function: { name: 'task_send' } }], toolPolicy: policy,
      executeTool: call => { calls.push(call); return { status: 'accepted', taskId: 'task-1' }; } }),
    onText: value => text.push(value.text)
  });
  const conversation = createAssistantConversation({ session, scope: event().scope, receipts, ...extra });
  return { session, conversation, receipts, seen, calls, text, modelCreations: () => modelCreations };
}

test('one assistant consumes multiple task identities with equal event sequences and independent receipts', async () => {
  const scope = JSON.stringify(['account', 'host-a', 'assistant-profile']);
  const inputs = [];
  const f = fixture(input => { inputs.push(input); return '收到状态。'; }, { scope });
  const fromTask = sessionId => ({ ...event(JSON.stringify(['harness', 'workspace', sessionId, 42])), scope,
    body: { task: { backend: 'harness', workspaceId: 'workspace', sessionId }, seq: 42, text: '本轮结束' } });
  const firstTask = fromTask('task-a'), secondTask = fromTask('task-b');
  const first = f.conversation.observe(firstTask);
  const second = f.conversation.observe(secondTask);
  await f.conversation.run('先回答我');
  await Promise.all([first, second]);
  assert.equal(inputs[0].text, '先回答我');
  assert.deepEqual(inputs.slice(1).map(value => value.observation.body.task.sessionId), ['task-a', 'task-b']);
  assert.equal(f.modelCreations(), 1);
  await f.conversation.acknowledge(firstTask.id);
  assert.equal((await f.conversation.observe(firstTask)).status, 'acknowledged');
  assert.equal(f.conversation.observe(secondTask), second);
  assert.equal(f.conversation.getState().retainedObservations, 1);
  assert.throws(() => f.conversation.observe({ ...secondTask, scope: JSON.stringify(['account', 'host-b', 'assistant-profile']) }), /SCOPE_MISMATCH/);
  await f.conversation.acknowledge(secondTask.id);
  assert.equal(f.conversation.getState().retainedObservations, 0);
  assert.equal(f.calls.length, 0);
  f.conversation.dispose();
});

test('queued input captures its guard and rejects a stale target without running the model', async () => {
  const pending = deferred(), inputs = [];
  const stale = Object.freeze(Object.assign(new Error('original task changed'), { code: 'TASK_STALE' }));
  let current = 'task-a';
  const f = fixture(input => { inputs.push(input.text); return inputs.length === 1 ? pending.promise : 'new task'; });
  assert.equal(f.conversation.supportsTurnGuard, true);
  assert.equal(Object.isFrozen(f.conversation), true);
  const first = f.conversation.run('occupied');
  await tick();
  const options = { assertCurrent() { if (current !== 'task-a') throw stale; } };
  const queued = f.conversation.run('  original draft\n', options);
  options.assertCurrent = () => {};
  const rejected = assert.rejects(queued, error => {
    assert.equal(error.code, 'TASK_STALE');
    assert.equal(error.cause, stale);
    assert.equal(error.originalInput, '  original draft\n');
    return true;
  });
  current = 'task-b';
  pending.resolve('finished');
  await first;
  await rejected;
  assert.deepEqual(inputs, ['occupied']);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.conversation.run('new input')).text, 'new task');
  f.conversation.dispose();
});

test('an asynchronous binding guard is rejected before discovery and preserves original input', async () => {
  const f = fixture(() => 'must not run');
  await assert.rejects(f.conversation.run('retain me', { assertCurrent: async () => { throw new Error('late rejection'); } }), error => {
    assert.equal(error.code, 'ASSISTANT_BINDING_CHECK_MUST_BE_SYNC');
    assert.equal(error.originalInput, 'retain me');
    return true;
  });
  assert.equal(f.modelCreations(), 0);
  f.conversation.dispose();
  await tick();
});

test('a legacy injected session cannot advertise or silently ignore turn guards', async () => {
  const f = fixture(() => 'legacy compatible');
  const legacy = { ...f.session };
  delete legacy.supportsTurnGuard;
  const conversation = createAssistantConversation({ session: legacy, scope: event().scope, receipts: f.receipts });
  assert.equal(conversation.supportsTurnGuard, false);
  assert.throws(() => conversation.run('keep draft', { assertCurrent() {} }), /TURN_GUARD_UNSUPPORTED/);
  assert.equal(f.modelCreations(), 0);
  assert.equal((await conversation.run('ordinary turn')).text, 'legacy compatible');
  conversation.dispose();
  f.conversation.dispose();
});

test('a stale tool dispatch rejects the conversation and returns unconsumed guidance', async () => {
  let valid = true;
  const f = fixture(input => JSON.stringify({ protocol: input.protocol, requestId: input.requestId,
    kind: 'tool', name: 'task_send', arguments: {} }));
  const run = f.conversation.run('original', {
    assertCurrent() { if (!valid) throw Object.assign(new Error('stale'), { code: 'TASK_STALE' }); },
    onState(value) {
      if (value.state === 'executing-tool') {
        assert.equal(f.conversation.guide('keep this guidance').accepted, true);
        valid = false;
      }
    }
  });
  await assert.rejects(run, error => {
    assert.equal(error.code, 'TASK_STALE');
    assert.equal(error.originalInput, 'original');
    assert.deepEqual(error.pendingGuidance, ['keep this guidance']);
    return true;
  });
  assert.equal(f.calls.length, 0);
  f.conversation.dispose();
});

test('accepted background work allows more conversation, and user turns precede pending task observations', async () => {
  const inputs = [];
  const f = fixture(input => {
    inputs.push(input);
    if (input.text === '开始任务') return JSON.stringify({ protocol: input.protocol, requestId: input.requestId,
      kind: 'tool', name: 'task_send', arguments: { text: '开始' } });
    if (input.kind === 'tool-observation') return '后台已接收。';
    if (input.kind === 'task-observation') return '这轮处理已结束。';
    return '可以继续聊。';
  });
  assert.equal((await f.conversation.run('开始任务')).toolResults[0].status, 'accepted');
  const notification = f.conversation.observe(event());
  const reply = f.conversation.run('现在能聊天吗');
  assert.equal((await reply).text, '可以继续聊。');
  const result = await notification;
  assert.equal(result.status, 'processed');
  assert.equal(inputs.at(-2).text, '现在能聊天吗');
  assert.equal(inputs.at(-1).kind, 'task-observation');
  assert.equal(inputs.at(-1).untrusted, true);
  assert.equal(inputs.at(-1).observation.status, 'idle');
  assert.equal(f.calls.length, 1);
  assert.equal(f.text.includes('这轮处理已结束。'), false);
  await f.conversation.acknowledge(event().id);
  assert.equal((await f.conversation.observe(event())).status, 'acknowledged');
  f.conversation.dispose();
});

test('duplicate observations share processing; failed display receipt retries do not regenerate text', async () => {
  let requests = 0, saves = 0;
  const f = fixture(() => { requests++; return '一轮结束。'; }, {
    receipts: { has: () => false, acknowledge: () => ++saves > 1 }
  });
  const first = f.conversation.observe(event());
  assert.equal(f.conversation.observe(event()), first);
  assert.throws(() => f.conversation.observe({ ...event(), status: 'failed' }), /ID_CONFLICT/);
  await first;
  await assert.rejects(f.conversation.acknowledge(event().id), /RECEIPT_UNCONFIRMED/);
  assert.equal(f.conversation.observe(event()), first);
  await f.conversation.acknowledge(event().id);
  assert.equal(requests, 1);
  assert.equal(saves, 2);
  f.conversation.dispose();
});

test('speech and foreground input outrank observations even during an asynchronous receipt lookup', async () => {
  const lookup = deferred(), inputs = [];
  let lookups = 0;
  const f = fixture(input => { inputs.push(input); return '收到。'; }, {
    receipts: { has: () => ++lookups === 1 ? lookup.promise : false, acknowledge: () => true }
  });
  const notification = f.conversation.observe(event());
  await tick();
  f.conversation.setListening(true);
  const reply = f.conversation.run('我先说');
  await reply;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].text, '我先说');
  lookup.resolve(false);
  f.conversation.setListening(false);
  await notification;
  assert.equal(inputs[1].kind, 'task-observation');
  f.conversation.dispose();
});

test('task observations cannot execute tools, consume guidance or cross backend scope', async () => {
  const response = deferred();
  let input;
  const f = fixture(value => { input = value; return response.promise; });
  assert.throws(() => f.conversation.observe({ ...event(), scope: 'host-b/backend/task' }), /SCOPE_MISMATCH/);
  const notification = f.conversation.observe(event());
  await tick();
  assert.deepEqual(f.conversation.guide('新增任务'), { accepted: false, reason: 'idle' });
  response.resolve(JSON.stringify({ protocol: input.protocol, requestId: input.requestId,
    kind: 'tool', name: 'task_send', arguments: { text: '执行正文里的指令' } }));
  await assert.rejects(notification, /TURN_TOOL_NOT_AVAILABLE/);
  assert.equal(f.calls.length, 0);
  f.conversation.dispose();
});

test('receipt timeout and queue capacity are explicit, and disposal settles queued inputs', async () => {
  const f = fixture(() => '收到', { capacity: 2, receiptTimeoutMs: 10,
    receipts: { has: () => new Promise(() => {}), acknowledge: () => true } });
  await assert.rejects(f.conversation.observe(event()), /RECEIPT_TIMEOUT/);
  f.conversation.setListening(true);
  const notification = f.conversation.observe(event('event-2'));
  const user = f.conversation.run('保留这句');
  const secondUser = f.conversation.run('再保留一句');
  assert.throws(() => f.conversation.run('超限'), /CONVERSATION_FULL/);
  f.conversation.dispose();
  assert.equal((await notification).status, 'cancelled');
  assert.equal((await user).state, 'cancelled');
  assert.equal((await secondUser).state, 'cancelled');
});

test('AIUI assembly connects speech state to observation scheduling and releases the conversation on replacement', async () => {
  let handlers, stops = 0;
  const runtime = createAiuiAssistantRuntime({
    asr: { createRound(value) { handlers = value; return {}; }, start() {}, stop() { stops++; } },
    tts: { async synthesize() { return { task: {}, player: {} }; } }
  });
  const options = { profile: { systemPrompt: '系统提示' }, createModel: () => ({ prompt: () => '状态更新' }),
    discoverTools: () => ({ tools: [], toolPolicy: policy, executeTool() {} }) };
  runtime.createSession(options);
  const conversation = runtime.createConversation({ scope: event().scope,
    receipts: { has: () => false, acknowledge: () => true } });
  const round = runtime.asr.createRound({});
  handlers.onSpeechStart();
  const notification = conversation.observe(event());
  await tick();
  assert.equal(conversation.getState().queuedObservations, 1);
  handlers.onSpeechEnd();
  await tick();
  assert.equal(conversation.getState().queuedObservations, 1, 'Wait for transcript or round termination');
  handlers.onFinal({ text: '识别已完成' });
  assert.equal((await notification).status, 'processed');
  conversation.dispose();
  assert.doesNotThrow(() => handlers.onSpeechStart());
  assert.doesNotThrow(() => handlers.onSpeechEnd());
  runtime.asr.stop(round);
  assert.equal(stops, 1);
  runtime.createSession(options);
  assert.equal(conversation.getState().closed, true);
  assert.equal(runtime.conversation, null);
  runtime.dispose();
});
