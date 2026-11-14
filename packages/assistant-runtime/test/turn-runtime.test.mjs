import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProtocol, getAgentProtocolFailureReason } from '../src/decision-protocol.js';
import { createAgentTurnRuntime } from '../src/turn-runtime.js';

const message = input => JSON.parse(input[0].content);
const action = (input, name, args = {}) => JSON.stringify({
  protocol: message(input).protocol, requestId: message(input).requestId,
  kind: 'tool', name, arguments: args
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const protocol = createAgentProtocol();
test('decision failures expose only a closed reason and retain strict action rejection', async () => {
  const sensitive = 'private-fixture-value';
  const valid = { protocol: protocol.id, requestId: sensitive, kind: 'final', text: sensitive };
  const cases = [
    ['framing', 'prefix ' + JSON.stringify(valid)],
    ['json-syntax', '{"private-fixture-value":'],
    ['protocol-mismatch', JSON.stringify({ ...valid, protocol: sensitive })],
    ['request-mismatch', JSON.stringify({ ...valid, requestId: 'other' })],
    ['unexpected-interjection', JSON.stringify({ ...valid, kind: 'interjection' })],
    ['unsupported-kind', JSON.stringify({ ...valid, kind: sensitive })],
    ['extra-fields', JSON.stringify({ ...valid, [sensitive]: sensitive })],
    ['final-text', JSON.stringify({ ...valid, text: null })],
    ['tool-fields', JSON.stringify({ protocol: protocol.id, requestId: sensitive, kind: 'tool', name: 'tasks.send', arguments: sensitive })]
  ];
  for (const [reason, raw] of cases) {
    assert.throws(() => protocol.parseDecision(raw, sensitive), error => {
      assert.equal(error.code, 'TURN_DECISION_INVALID');
      assert.equal(getAgentProtocolFailureReason(error), reason);
      assert.equal(error.message, 'TURN_DECISION_INVALID');
      assert.doesNotMatch(JSON.stringify(error), /private-fixture-value|other|tasks.send/);
      return true;
    });
  }
  assert.equal(getAgentProtocolFailureReason({ code: 'TURN_DECISION_INVALID', protocolFailureReason: sensitive }), null);
  assert.equal(getAgentProtocolFailureReason({ code: sensitive, protocolFailureReason: 'framing' }), null);
  assert.equal(getAgentProtocolFailureReason(null), null);
  assert.equal(protocol.parseDecision(JSON.stringify(valid), sensitive).text, sensitive);
  let executions = 0;
  const turn = createAgentTurnRuntime({ protocol, tools: ['tasks.send'],
    model: { async prompt() { return cases[3][1]; } },
    executeTool() { executions++; }, toolPolicy: {
      classify: () => ({ mutation: true }), inspectOutcome: () => ({ uncertain: false, failed: false, terminal: false })
    } });
  await assert.rejects(turn.run('test'), error => getAgentProtocolFailureReason(error) === 'request-mismatch');
  assert.equal(executions, 0);
  assert.equal(turn.getState().state, 'failed');
});
const policy = {
  classify: decision => ({ mutation: decision.name === 'tasks.send' }),
  inspectOutcome: result => ({
    uncertain: !result || result.status === 'unknown',
    failed: result?.status === 'failed', terminal: false
  })
};

test('profiles isolate protocol and instructions without introducing a second execution path', () => {
  const first = createAgentProtocol({ id: 'fixture-a/v1', introduction: '人格甲', toolInstructions: '先核对甲工具。' });
  const second = createAgentProtocol({ id: 'fixture-b/v1', introduction: '人格乙', toolInstructions: '使用乙任务工具。' });
  const options = { initialPrompts: [{ role: 'system', content: '原人格' }] };
  const configured = second.modelOptions(options, [{ function: { name: 'tasks.send' } }]);
  assert.match(configured.options.initialPrompts[0].content, /人格乙[\s\S]*\n\n原人格$/);
  assert.doesNotMatch(configured.options.initialPrompts[0].content, /Rabi|rabi_api|人格甲/);
  assert.deepEqual(configured.options.tools, []);
  assert.equal(options.initialPrompts[0].content, '原人格');
  const input = first.input('request-1', { protocol: 'spoof', requestId: 'spoof', kind: 'user-input', text: '查询' });
  assert.equal(message(input).protocol, 'fixture-a/v1');
  assert.equal(message(input).requestId, 'request-1');
  assert.throws(() => second.parseDecision(action(input, 'tasks.send'), 'request-1'), /TURN_DECISION_INVALID/);
});

test('a persona prefix before an action frame cannot become a successful spoken answer', async () => {
  for (const truncated of [false, true]) {
  const spoken = []; let dispatched = 0;
  const model = { promptStreaming(input) {
    const pieces = ['【测试人格】', truncated ? '{"protocol":"assistant-agent/v1",' : action(input, 'tasks.send', { text: '任务' })];
    return { async read() { return pieces.length ? { value: pieces.shift(), done: false } : { done: true }; } };
  } };
  const turn = createAgentTurnRuntime({ model, protocol, toolPolicy: policy, tools: ['tasks.send'],
    executeTool() { dispatched++; return { status: 'ok' }; }, onText: value => spoken.push(value.delta) });
  await assert.rejects(turn.run('执行任务'), /TURN_DECISION_INVALID/);
  assert.equal(dispatched, 0); assert.doesNotMatch(spoken.join(''), /protocol|requestId|tasks.send/);
  assert.equal(turn.getState().state, 'failed');
  }
});

test('ordinary prose containing JSON still returns its complete visible text', async () => {
  const expected = '这是数据示例：{"count":3}。', spoken = [];
  const model = { promptStreaming() {
    const pieces = ['这是数据示例：', '{"count":', '3}。'];
    return { async read() { return pieces.length ? { value: pieces.shift() } : { done: true }; } };
  } };
  const turn = createAgentTurnRuntime({ model, protocol, toolPolicy: policy, executeTool() {}, onText: value => spoken.push(value.delta) });
  assert.equal((await turn.run('说明数据')).text, expected); assert.equal(spoken.join(''), expected);
});

test('non-Rabi tools preserve accepted task references and backend-specific receipt data', async () => {
  const ref = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: 'session-a', generation: 7 };
  const receipt = { status: 'accepted', taskRef: ref, receiptId: 'receipt-a' };
  const calls = []; let step = 0;
  const model = { async prompt(input) {
    if (++step === 1) return action(input, 'tasks.send', { taskRef: ref, text: '继续查证' });
    const observed = message(input).observation;
    assert.deepEqual(observed.outcome, receipt);
    assert.equal(observed.outcome.status, 'accepted', 'Assistant turn completion must not fabricate backend completion');
    assert.equal(observed.outcomeStatus.terminal, false);
    return '任务已接收，结果尚待回报。';
  } };
  const result = await createAgentTurnRuntime({ model, protocol, toolPolicy: policy, tools: ['tasks.send'],
    executeTool: async event => { calls.push(event); return receipt; }
  }).run('继续任务');
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.toolResults, [receipt]);
  assert.deepEqual(calls[0].arguments.taskRef, ref);
});

test('backend outcome uncertainty blocks other writes while permitting original receipt readback', async () => {
  const calls = []; let step = 0;
  const model = { async prompt(input) {
    if (++step === 1) return action(input, 'tasks.send', { text: 'first' });
    if (step === 2) return action(input, 'tasks.send', { text: 'different' });
    if (step === 3) {
      assert.equal(message(input).observation.dispatched, false);
      assert.equal(message(input).observation.outcome.code, 'WRITE_RECONCILIATION_REQUIRED');
      return action(input, 'tasks.readReceipt', { receiptId: 'original' });
    }
    return '结果仍未确认。';
  } };
  const result = await createAgentTurnRuntime({ model, protocol, toolPolicy: policy,
    tools: ['tasks.send', 'tasks.readReceipt'], executeTool: async event => {
      calls.push(event.functionName);
      return { status: 'unknown', receiptId: 'original' };
    }
  }).run('任务');
  assert.equal(result.state, 'uncertain');
  assert.deepEqual(calls, ['tasks.send', 'tasks.readReceipt']);
});

test('executor exceptions and unreadable receipt classifications cannot become successful writes', async () => {
  for (const mode of ['throw-executor', 'throw-inspector', 'invalid-inspector']) {
    let step = 0, calls = 0;
    const badPolicy = { ...policy, inspectOutcome() {
      if (mode === 'throw-inspector') throw Error('invalid receipt');
      return mode === 'invalid-inspector' ? {} : { uncertain: false, failed: false, terminal: true };
    } };
    const model = { async prompt(input) {
      if (++step <= 2) return action(input, 'tasks.send', { step });
      assert.equal(message(input).observation.outcome.code, 'WRITE_RECONCILIATION_REQUIRED');
      return '需要核对原操作。';
    } };
    const result = await createAgentTurnRuntime({ model, protocol, toolPolicy: badPolicy, tools: ['tasks.send'],
      executeTool: async () => { calls++; if (mode === 'throw-executor') throw Error('connection lost'); return { status: 'accepted' }; }
    }).run('任务');
    assert.equal(result.state, 'uncertain', mode);
    assert.equal(calls, 1, mode);
  }
});

test('missing or invalid backend classification fails before dispatch', async () => {
  const model = { prompt: async input => action(input, 'tasks.send') };
  assert.throws(() => createAgentTurnRuntime({ model, protocol, executeTool() {} }), /TURN_DEPENDENCIES_REQUIRED/);
  let calls = 0;
  await assert.rejects(createAgentTurnRuntime({ model, protocol, tools: ['tasks.send'],
    toolPolicy: { ...policy, classify: () => ({ mutation: 'yes' }) }, executeTool() { calls++; }
  }).run('任务'), /TURN_TOOL_POLICY_INVALID/);
  assert.equal(calls, 0);
});

test('unavailable or rejected actions cannot narrate execution before validation', async () => {
  for (const name of ['not-connected', 'tasks.send']) {
    const shown = []; let calls = 0;
    const model = { prompt: async input => JSON.stringify({ ...JSON.parse(action(input, name)), say: '正在执行。' }) };
    await assert.rejects(createAgentTurnRuntime({ model, protocol, tools: ['tasks.send'],
      toolPolicy: { ...policy, classify() { throw Error('invalid arguments'); } },
      executeTool() { calls++; }, onText: value => shown.push(value.text)
    }).run('任务'));
    assert.equal(calls, 0); assert.deepEqual(shown, []);
  }
});

test('cancellation from a presentation callback prevents an undispatched tool', async () => {
  for (const phase of ['text', 'state']) {
    let calls = 0, turn;
    const model = { prompt: async input => JSON.stringify({ ...JSON.parse(action(input, 'tasks.send')), say: '准备调用。' }) };
    turn = createAgentTurnRuntime({ model, protocol, toolPolicy: policy, tools: ['tasks.send'],
      executeTool() { calls++; return { status: 'accepted' }; },
      onText() { if (phase === 'text') turn.cancel(); },
      onState(value) { if (phase === 'state' && value.state === 'executing-tool') turn.cancel(); }
    });
    assert.equal((await turn.run('任务')).state, 'cancelled'); assert.equal(calls, 0);
  }
});

test('cancelling presentation while a task is dispatched does not cancel or duplicate backend work', async () => {
  let resolve, requests = 0, calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const model = { async prompt(input) { requests++; return action(input, 'tasks.send'); } };
  const turn = createAgentTurnRuntime({ model, protocol, toolPolicy: policy, tools: ['tasks.send'],
    executeTool: async () => { calls++; await pending; return { status: 'accepted', receiptId: 'original' }; }
  });
  const running = turn.run('任务'); await tick(); turn.cancel();
  assert.equal((await running).state, 'cancelled');
  resolve(); await tick();
  assert.equal(calls, 1); assert.equal(requests, 1);
});
