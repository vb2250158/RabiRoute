import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantSession } from '../src/assistant-session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const decode = input => JSON.parse(input[0].content);
const tool = (input, text = 'original') => JSON.stringify({ protocol: decode(input).protocol,
  requestId: decode(input).requestId, kind: 'tool', name: 'work', arguments: { text } });
function setup({ reply, options = {}, assertCurrent } = {}) {
  const work = deferred(), prompts = [], spoken = [], dispatched = [];
  let modelActive = 0, maxModelActive = 0;
  const session = createAssistantSession({
    profile: { systemPrompt: 'Always preserve the test persona.' },
    limits: { interjectWhileWaiting: true, ...options },
    discoverTools: async () => ({ tools: [{ function: { name: 'work' } }],
      executeTool(event) { dispatched.push(event); return work.promise; },
      toolPolicy: { classify: () => ({ mutation: true }), inspectOutcome: result => ({ uncertain: result.status === 'unknown', failed: false, terminal: false }) } }),
    createModel: async config => {
      assert.match(config.initialPrompts[0].content, /Always preserve the test persona\.$/);
      return { async prompt(input) {
        const packet = decode(input); prompts.push(packet); modelActive++;maxModelActive=Math.max(maxModelActive,modelActive);
        try {
          if (packet.kind === 'user-input') return tool(input);
          if (packet.kind === 'user-interjection') return await (reply?.(input) || 'The answer is 42.');
          assert.equal(packet.kind, 'tool-observation');
          assert.equal(packet.observation.callId, dispatched[0].callId);
          assert.equal(packet.observation.outcome.receipt, 'original-receipt');
          return 'The original result is now available.';
        } finally { modelActive--; }
      } };
    },
    onText: value => spoken.push(value.text)
  });
  return { session, work, prompts, spoken, dispatched, maxActive: () => maxModelActive,
    run: extra => session.run('Do the original work.', { assertCurrent, ...extra }) };
}

test('same host answers two interjections before original tool completion without overlapping model requests', async () => {
  const secondReply = deferred();let interjections = 0;
  const f = setup({ reply: () => ++interjections === 1 ? 'First answer.' : secondReply.promise });
  const run = f.run();await tick();
  assert.equal(f.dispatched.length, 1);
  assert.deepEqual(f.session.guide('What is the answer?'), { accepted: true });await tick();
  assert.ok(f.spoken.includes('First answer.\n'));
  assert.equal(f.session.getState().turn.settledToolCount, 0);
  assert.deepEqual(f.session.guide('And the next question?'), { accepted: true });await tick();
  f.work.resolve({ status: 'completed', receipt: 'original-receipt' });await tick();
  assert.equal(f.prompts.length, 3, 'receipt waits until the active interjection request settles');
  secondReply.resolve('Second answer.');const result = await run;
  assert.equal(result.state, 'completed');assert.equal(f.dispatched.length, 1);assert.equal(f.maxActive(), 1);
  assert.deepEqual(result.toolResults, [{ status: 'completed', receipt: 'original-receipt' }]);
  assert.deepEqual(f.prompts.filter(p => p.kind === 'user-interjection').map(p => p.text), [['What is the answer?'], ['And the next question?']]);
});

test('caller-owned guidance wakes a pending tool without polling or moving the original operation', async () => {
  const f = setup(), queue = [];
  const run = f.run({ takeGuidance: () => queue.splice(0) });await tick();
  queue.push('External user input');assert.equal(f.session.notifyGuidance(), true);await tick();
  assert.ok(f.spoken.includes('The answer is 42.\n'));assert.equal(queue.length, 0);
  assert.equal(f.dispatched.length, 1);
  f.work.resolve({ status: 'completed', receipt: 'original-receipt' });await run;
  assert.equal(f.session.notifyGuidance(), false);
});

test('interjection tool frames are rejected without being spoken or dispatched', async () => {
  const f = setup({ reply: input => tool(input, 'duplicate') });
  const run = f.run();const rejected = assert.rejects(run, /TURN_INTERJECTION_TOOL_FORBIDDEN/);await tick();
  f.session.guide('Do another tool operation');await rejected;
  assert.equal(f.dispatched.length, 1);assert.deepEqual(f.spoken, []);
  f.work.resolve({ status: 'completed', receipt: 'original-receipt' });await tick();
  assert.equal(f.prompts.length, 2, 'late receipt does not restart a failed model turn');
});

test('cancellation while an interjection is pending suppresses late speech and leaves the dispatched work alone', async () => {
  const answer = deferred(), f = setup({ reply: () => answer.promise });
  const run = f.run();await tick();f.session.guide('New input');await tick();f.session.cancel();
  assert.equal((await run).state, 'cancelled');answer.resolve('Late reply');
  f.work.resolve({ status: 'completed', receipt: 'original-receipt' });await tick();
  assert.deepEqual(f.spoken, []);assert.equal(f.dispatched.length, 1);assert.equal(f.prompts.length, 2);
});

test('binding changes during an interjection reject stale output and cannot reassign the tool', async () => {
  let valid = true;const answer = deferred();
  const f = setup({ reply: () => answer.promise, assertCurrent: () => { if (!valid) throw Error('STALE_OWNER'); } });
  const run = f.run();const rejected = assert.rejects(run, /STALE_OWNER/);await tick();f.session.guide('New input');await tick();
  valid=false;answer.resolve('Stale reply');await rejected;
  f.work.resolve({ status: 'completed', receipt: 'original-receipt' });await tick();
  assert.deepEqual(f.spoken, []);assert.equal(f.dispatched.length, 1);
});

test('opt-out keeps legacy tool-wait guidance and uncertainty still gates subsequent work', async () => {
  const f = setup({ options: { interjectWhileWaiting: false } });
  const run = f.run();await tick();f.session.guide('Wait for the original receipt');await tick();
  assert.equal(f.prompts.length, 1);assert.equal(f.session.notifyGuidance(), false);
  f.work.resolve({ status: 'unknown', receipt: 'original-receipt' });
  const result = await run;assert.equal(result.state, 'uncertain');
  assert.deepEqual(f.prompts[1].steering, ['Wait for the original receipt']);
});
