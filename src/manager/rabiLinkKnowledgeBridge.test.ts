import test from 'node:test';
import assert from 'node:assert/strict';
import { validateKnowledgeArguments } from '../../packages/rabi-knowledge-contract/schema.mjs';
import { createRabiLinkKnowledgeBridge } from './rabiLinkKnowledgeBridge.js';

const metadata = { appId: 'app', deviceBindingId: 'device', ownerAccountId: 'owner', targetDeviceId: 'pc' };
const plan = { title: 'Goal', focus: 'One goal', keywords: ['goal'], steps: [{ id: 's', title: 'Step' }], activationStatus: '进行中', markerStatus: 'ready' };
test('authenticated connected device uses every existing knowledge tool without a second grant', async () => {
  const requests: unknown[] = [];
  const bridge = createRabiLinkKnowledgeBridge(['one', 'two'], { validate: validateKnowledgeArguments, async request(request) { requests.push(request); return { ok: true }; } });
  await bridge.execute(metadata, { operation: 'call', name: 'plan_get', args: { roleId: 'two', id: 'plan' } });
  await bridge.execute(metadata, { operation: 'call', name: 'plan_create', args: { roleId: 'one', idempotencyKey: 'create', body: plan } });
  await bridge.execute(metadata, { operation: 'call', name: 'memory_get', args: { roleId: 'two', id: 'memory', kind: 'recent', idempotencyKey: 'touch' } });
  assert.equal(requests.length, 3);
});
test('missing trusted identity, unknown tools and invalid role/schema never reach the owner', async () => {
  let calls = 0;
  const bridge = createRabiLinkKnowledgeBridge(['one'], { validate: validateKnowledgeArguments, async request() { calls++; return {}; } });
  for (const identity of [{ ...metadata, ownerAccountId: '' }, { ...metadata, appId: '' }, { ...metadata, deviceBindingId: '' }, { ...metadata, targetDeviceId: '' }, { ...metadata, grant: {} }]) {
    await assert.rejects(bridge.execute(identity, { operation: 'list' }));
  }
  for (const request of [
    { operation: 'call', name: 'plan_get', args: { roleId: 'other', id: 'plan' } },
    { operation: 'call', name: 'plan_get', args: { roleId: 'one', id: 'plan', url: 'https://invalid.test' } },
    { operation: 'call', name: 'execute', args: { roleId: 'one' } },
    { operation: 'list', appId: 'forged' },
    { operation: 'call', name: 'plan_create', args: { roleId: 'one', body: plan } }
  ]) await assert.rejects(bridge.execute(metadata, request));
  assert.equal(calls, 0);
});
test('uncertain write reaches transport once and never leaks its exception', async () => {
  let calls = 0;
  const bridge = createRabiLinkKnowledgeBridge(['one'], { validate: validateKnowledgeArguments, async request() { calls++; throw Error('private credential'); } });
  const result = await bridge.execute(metadata, { operation: 'call', name: 'plan_create', args: { roleId: 'one', idempotencyKey: 'saved-key', body: plan } });
  assert.deepEqual(result, { ok: false, uncertain: true, code: 'KNOWLEDGE_OUTCOME_UNCERTAIN' });
  assert.equal(calls, 1);
});
