import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantSession } from '../src/assistant-session.js';
import { createAssistantConversation } from '../src/conversation-runtime.js';
import { createAgentProtocol } from '../src/decision-protocol.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = JSON.stringify(['backend', 'host-a', 1, 'task-a']);
const input = (id = 'input-1', text = 'What is six times seven?') => ({ id, scope, text });
const answer = (packet, text = '42') => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId,
  kind: 'interjection', inputId: packet.input.id, disposition: 'answer', text });
const postpone = packet => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId,
  kind: 'interjection', inputId: packet.input.id, disposition: 'defer' });
const tool = (packet, text = packet.text) => JSON.stringify({ protocol: packet.protocol,
  requestId: packet.requestId, kind: 'tool', name: 'work', arguments: { text } });

function fixture({ reply = answer, onState, limits = {}, modelReply, execute, protocol } = {}) {
  const pending = deferred(), prompts = [], dispatches = [], spoken = [];
  let modelActive = 0, maxModelActive = 0;
  const session = createAssistantSession({ profile: { systemPrompt: 'Keep the configured global prompt.' }, protocol,
    limits: { interjectWhileWaiting: true, ...limits },
    discoverTools: () => ({ tools: [{ function: { name: 'work' } }],
      toolPolicy: { classify: () => ({ mutation: true }), inspectOutcome: result => ({ uncertain: result.status === 'unknown', failed: false, terminal: false }) },
      executeTool: event => { dispatches.push(event); return execute ? execute(event, pending) : pending.promise; } }),
    createModel: options => {
      assert.ok(options.initialPrompts[0].content.endsWith('Keep the configured global prompt.'));
      assert.doesNotMatch(options.initialPrompts[0].content, /kind:\s*"interjection"/);
      return { async prompt(messages) {
        const packet = JSON.parse(messages[0].content); prompts.push(packet);
        if (packet.kind === 'independent-input') {
          assert.deepEqual(packet.responseFormats, [
            JSON.parse(answer(packet, '<实际回复>')), { ...JSON.parse(postpone(packet)), text: '<可选，延后原因；不是答案或完成回执>' }
          ]);
        } else assert.equal(packet.responseFormats, undefined);
        modelActive++; maxModelActive = Math.max(modelActive, maxModelActive);
        try {
          if (modelReply) return await modelReply(packet);
          if (packet.kind === 'user-input') return tool(packet);
          if (packet.kind === 'independent-input') return await reply(packet);
          if (packet.kind === 'task-observation') return 'A background update.';
          assert.equal(packet.kind, 'tool-observation');
          return 'Original task result.';
        } finally { modelActive--; }
      }, destroy() {} };
    }, onText: value => spoken.push(value.text), onState });
  const conversation = createAssistantConversation({ session, scope: 'assistant-domain',
    receipts: { has: () => false, acknowledge: () => true } });
  return { session, conversation, pending, prompts, dispatches, spoken, maxActive: () => maxModelActive,
    run: (options = {}) => conversation.run('original', { inputScope: scope, turnId: 'original-turn', ...options }) };
}

test('independent answers retain identity, deduplicate and never enter the original text or tool receipt', async () => {
  const f = fixture(), run = f.run(); await tick();
  const packet = input(), options = { assertCurrent() {} };
  const first = f.conversation.interject(packet, options);
  assert.equal(f.conversation.interject({ ...packet }, options), first);
  assert.throws(() => f.conversation.interject(input('input-1', 'different')), /ID_CONFLICT/);
  packet.text = 'mutated'; packet.scope = 'other'; options.assertCurrent = () => { throw Error('replaced'); };
  const result = await first;
  assert.deepEqual(result, { input: input(), status: 'answered', modelInvoked: true, toolDispatched: false, text: '42' });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.input));
  assert.equal(f.conversation.interject(input()), first);
  assert.deepEqual(f.spoken, []); assert.equal(f.dispatches.length, 1);
  assert.equal(f.session.getState().turn.settledToolCount, 0);
  f.pending.resolve({ status: 'completed', receipt: 'original' });
  const original = await run;
  assert.equal(original.text, 'Original task result.'); assert.deepEqual(original.toolResults, [{ status: 'completed', receipt: 'original' }]);
  assert.equal(f.maxActive(), 1); f.conversation.dispose();
});

test('a proposed new action defers the original input and does not fail or duplicate the pending task', async () => {
  const f = fixture({ reply: packet => tool(packet, 'must never dispatch') });
  const run = f.run(); await tick();
  const result = await f.conversation.interject(input('write', 'Do another operation'));
  assert.equal(result.status, 'deferred'); assert.equal(result.modelInvoked, true); assert.equal(result.toolDispatched, false);
  assert.equal(result.input.text, 'Do another operation'); assert.equal(f.dispatches.length, 1);
  assert.deepEqual(f.spoken, []);
  f.pending.resolve({ status: 'completed' }); assert.equal((await run).state, 'completed');
  assert.match(f.prompts.at(-1).instruction, /only the original task/); f.conversation.dispose();
});

test('deferred input re-enters under its original turn ID and guard only after the original receipt', async () => {
  const f = fixture({ reply: postpone, execute: (event, pending) => event.callId.startsWith('original-turn') ? pending.promise : { status: 'completed' } });
  const run = f.run(); await tick(); const packet = input('handoff-7', 'A new task');
  const result = await f.conversation.interject(packet);
  assert.equal(result.status, 'deferred');
  const second = f.conversation.run(result.input.text, { inputScope: result.input.scope, turnId: 'voice-handoff-7', assertCurrent() {} });
  await tick(); assert.equal(f.dispatches.length, 1);
  f.pending.resolve({ status: 'completed' }); await run; await second;
  assert.deepEqual(f.dispatches.map(x => [x.callId, x.arguments.text]), [['original-turn:call-1', 'original'], ['voice-handoff-7:call-1', 'A new task']]);
  assert.equal(f.maxActive(), 1); f.conversation.dispose();
});

test('receipt racing with an in-flight answer returns queued unsubmitted inputs independently', async () => {
  const response = deferred(), f = fixture({ reply: () => response.promise });
  const run = f.run(); await tick(); const first = f.conversation.interject(input()); await tick();
  const second = f.conversation.interject(input('input-2', 'Next question'));
  f.pending.resolve({ status: 'completed' }); await tick();
  const late = await f.conversation.interject(input('input-3'));
  assert.equal(late.status, 'unavailable'); assert.equal(late.modelInvoked, false);
  assert.equal(f.prompts.length, 2, 'original receipt cannot overlap the active model request');
  response.resolve(answer(f.prompts[1]));
  assert.equal((await first).status, 'answered');
  assert.equal((await second).status, 'returned'); assert.equal((await second).modelInvoked, false);
  await run; assert.equal(f.prompts.length, 3); assert.equal(f.maxActive(), 1); f.conversation.dispose();
});

test('closing a view returns unsubmitted input and leaves submitted input unconfirmed without late output', async () => {
  const response = deferred(), f = fixture({ reply: () => response.promise });
  const run = f.run(); await tick(); const first = f.conversation.interject(input()); await tick();
  const second = f.conversation.interject(input('input-2')); f.conversation.dispose();
  assert.equal((await first).status, 'unconfirmed'); assert.equal((await first).modelInvoked, true);
  assert.equal((await second).status, 'returned'); assert.equal((await second).modelInvoked, false);
  assert.equal((await run).state, 'cancelled');
  response.resolve(answer(f.prompts[1])); f.pending.resolve({ status: 'completed' }); await tick();
  assert.deepEqual(f.spoken, []); assert.equal(f.prompts.length, 2); assert.equal(f.dispatches.length, 1);
});

test('scope mismatch, missing scope, observation turns and older sessions cannot consume independent inputs', async () => {
  const f = fixture(); let run = f.run({ inputScope: undefined }); await tick();
  assert.equal((await f.conversation.interject(input())).status, 'unavailable');
  f.pending.resolve({ status: 'completed' }); await run;
  const notification = deferred(); const observed = fixture({ modelReply: () => notification.promise });
  run = observed.conversation.observe({ id: 'notice', scope: 'assistant-domain', kind: 'done', status: 'completed', body: {} }); await tick();
  assert.equal((await observed.conversation.interject(input())).status, 'unavailable');
  notification.resolve('Update'); await run; observed.conversation.dispose(); f.conversation.dispose();
  const legacy = createAssistantConversation({ session: { run() {}, observe() {}, guide() {}, dispose() {} }, scope: 'domain', receipts: { has() {}, acknowledge() {} } });
  assert.equal(legacy.supportsInterjectionReceipts, false);
  assert.equal((await legacy.interject(input())).status, 'unavailable'); legacy.dispose();
  const scoped = fixture(), active = scoped.run(); await tick();
  assert.equal((await scoped.conversation.interject({ ...input(), scope: 'other-task' })).status, 'unavailable');
  assert.equal(scoped.prompts.length, 1); scoped.pending.resolve({ status: 'completed' }); await active; scoped.conversation.dispose();
});

test('only a matching explicit answer frame can settle an input as answered', async () => {
  for (const [reason, invalid] of [
    ['json-syntax', () => 'private-raw-error'],
    ['unexpected-final', packet => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId, kind: 'final', text: 'private-raw-error' })],
    ['input-mismatch', packet => answer({ ...packet, input: { id: 'private-raw-error' } })],
    ['request-mismatch', packet => answer({ ...packet, requestId: 'private-raw-error' })],
    ['defer-text', packet => JSON.stringify({ ...JSON.parse(postpone(packet)), text: { value: 'private-raw-error' } })],
    ['defer-text', packet => JSON.stringify({ ...JSON.parse(postpone(packet)), text: '' })],
    ['defer-text', packet => JSON.stringify({ ...JSON.parse(postpone(packet)), text: 'x'.repeat(16001) })],
    ['extra-fields', packet => JSON.stringify({ ...JSON.parse(postpone(packet)), 'private-raw-error': true })]
  ]) {
    const f = fixture({ reply: invalid }), run = f.run(); await tick();
    const result = await f.conversation.interject(input());
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.modelInvoked, true); assert.equal(result.text, undefined);
    assert.equal(result.protocolFailureReason, reason);
    assert.doesNotMatch(JSON.stringify(result), /private-raw-error/);
    assert.deepEqual(f.spoken, []); f.pending.resolve({ status: 'completed' }); assert.equal((await run).state, 'completed'); f.conversation.dispose();
  }
});

test('a bounded defer explanation stays deferred and never becomes an answer or a dispatched action', async () => {
  for (const text of [undefined, 'Global prefix: this independent request needs a later tool turn.']) {
    const f = fixture({ reply: packet => JSON.stringify({ ...JSON.parse(postpone(packet)), ...(text === undefined ? {} : { text }) }) });
    const run = f.run(); await tick();
    const result = await f.conversation.interject(input());
    assert.deepEqual(result, { input: input(), status: 'deferred', modelInvoked: true, toolDispatched: false });
    assert.equal(f.dispatches.length, 1); assert.deepEqual(f.spoken, []);
    f.pending.resolve({ status: 'completed' });
    assert.equal((await run).text, 'Original task result.'); f.conversation.dispose();
  }
});

test('an input guard invalidated while queued returns it without submitting, while the original task continues', async () => {
  let valid = true;
  const response = deferred(), f = fixture({ reply: () => response.promise }), run = f.run(); await tick();
  const first = f.conversation.interject(input()); await tick();
  const second = f.conversation.interject(input('input-2'), { assertCurrent() { if (!valid) throw Error('view exited'); } });
  valid = false; response.resolve(answer(f.prompts[1])); await first;
  assert.equal((await second).status, 'returned'); assert.equal(f.prompts.length, 2);
  f.pending.resolve({ status: 'completed' }); assert.equal((await run).state, 'completed'); f.conversation.dispose();
});

test('a binding change after submission suppresses the independent answer without reassigning its input', async () => {
  let valid = true;
  const response = deferred(), f = fixture({ reply: () => response.promise }), run = f.run(); await tick();
  const result = f.conversation.interject(input(), { assertCurrent() { if (!valid) throw Error('binding changed'); } }); await tick();
  valid = false; response.resolve(answer(f.prompts[1]));
  assert.equal((await result).status, 'unconfirmed'); assert.deepEqual((await result).input, input());
  assert.deepEqual(f.spoken, []); f.pending.resolve({ status: 'completed' }); await run; f.conversation.dispose();
});

test('stale original binding fails its own turn and returns every independent input without replay', async () => {
  let valid = true;
  const response = deferred(), f = fixture({ reply: () => response.promise });
  const run = f.run({ assertCurrent() { if (!valid) throw Error('ORIGINAL_BINDING_STALE'); } });
  const rejection = assert.rejects(run, /ORIGINAL_BINDING_STALE/); await tick();
  const first = f.conversation.interject(input()); await tick();
  const second = f.conversation.interject(input('input-2')); valid = false; response.resolve(answer(f.prompts[1]));
  await rejection; assert.equal((await first).status, 'unconfirmed'); assert.equal((await second).status, 'returned');
  f.pending.resolve({ status: 'completed' }); await tick(); assert.equal(f.dispatches.length, 1); assert.deepEqual(f.spoken, []); f.conversation.dispose();
});

test('model disconnection settles each input and prevents automatic resubmission', async () => {
  const response = deferred(), f = fixture({ reply: () => response.promise });
  const run = f.run(); const rejected = assert.rejects(run, /DISCONNECTED/); await tick();
  const first = f.conversation.interject(input()); await tick(); const second = f.conversation.interject(input('input-2'));
  response.reject(Error('DISCONNECTED')); await rejected;
  assert.equal((await first).status, 'unconfirmed'); assert.equal((await second).status, 'returned');
  f.pending.resolve({ status: 'completed' }); await tick(); assert.equal(f.prompts.length, 2); f.conversation.dispose();
});

test('input guards are checked before admission and immediately before model dispatch after callbacks', async () => {
  let valid = true;
  const f = fixture({ onState(value) { if (value.state === 'interjecting') valid = false; } });
  const run = f.run(); await tick();
  assert.equal((await f.conversation.interject(input('stale'), { assertCurrent() { throw Error('already stale'); } })).status, 'unavailable');
  const result = f.conversation.interject(input(), { assertCurrent() { if (!valid) throw Error('STALE_AFTER_CALLBACK'); } });
  assert.equal((await result).status, 'returned'); assert.equal((await result).modelInvoked, false);
  assert.equal(f.prompts.length, 1); f.pending.resolve({ status: 'completed' });
  assert.equal((await run).state, 'completed'); f.conversation.dispose();
});

test('capacity and opt-out return original inputs without hidden queuing or model submission', async () => {
  const response = deferred(), f = fixture({ reply: () => response.promise }), run = f.run(); await tick();
  const entries = Array.from({ length: 16 }, (_, n) => f.conversation.interject(input('input-' + n)));
  const full = await f.conversation.interject(input('overflow')); assert.equal(full.status, 'unavailable'); assert.match(full.code, /FULL/);
  f.conversation.dispose(); const outcomes = await Promise.all(entries); assert.ok(outcomes.every(x => ['returned', 'unconfirmed'].includes(x.status)));
  await run; f.pending.resolve({ status: 'completed' }); response.resolve('late'); await tick();
  const disabled = fixture({ limits: { interjectWhileWaiting: false } }), original = disabled.run(); await tick();
  assert.equal((await disabled.conversation.interject(input())).status, 'unavailable');
  assert.equal(disabled.prompts.length, 1); disabled.pending.resolve({ status: 'completed' }); await original; disabled.conversation.dispose();
});

test('custom legacy protocols without an interjection parser retain ordinary run behavior', async () => {
  const { parseInterjection, ...legacy } = createAgentProtocol();
  const f = fixture({ protocol: legacy }), run = f.run(); await tick();
  assert.equal((await f.conversation.interject(input())).status, 'unavailable');
  assert.equal(f.prompts.length, 1); f.pending.resolve({ status: 'completed' }); await run; f.conversation.dispose();
});

test('a submitted interjection timeout cannot claim an answer or resubmit the pending work', async () => {
  const response = deferred(), f = fixture({ reply: () => response.promise, limits: { requestTimeoutMs: 60 } });
  const run = f.run(); const rejected = assert.rejects(run, /TURN_TIMEOUT/); await tick();
  const first = f.conversation.interject(input()); await tick(); const second = f.conversation.interject(input('input-2'));
  await rejected;
  assert.equal((await first).status, 'unconfirmed'); assert.equal((await second).status, 'returned');
  response.resolve(answer(f.prompts[1])); f.pending.resolve({ status: 'completed' }); await tick();
  assert.deepEqual(f.spoken, []); assert.equal(f.dispatches.length, 1); assert.equal(f.prompts.length, 2); f.conversation.dispose();
});

test('cancellation during interjection presentation returns it before any model invocation', async () => {
  let f;
  f = fixture({ onState(value) { if (value.state === 'interjecting') f.session.cancel(); } });
  const run = f.run(); await tick(); const result = await f.conversation.interject(input());
  assert.equal(result.status, 'returned'); assert.equal(result.modelInvoked, false);
  assert.equal((await run).state, 'cancelled');
  f.pending.resolve({ status: 'completed' }); await tick(); assert.equal(f.prompts.length, 1); assert.deepEqual(f.spoken, []); f.conversation.dispose();
});
