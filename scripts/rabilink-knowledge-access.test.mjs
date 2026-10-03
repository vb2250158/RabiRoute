import test from 'node:test';
import assert from 'node:assert/strict';
import { definitions } from '../packages/rabi-knowledge-contract/schema.mjs';
import { authorizeKnowledgeRequest, rejectReservedKnowledgePath } from './rabilink-knowledge-access.mjs';

const binding = { id: 'device', credentialHash: 'fixture-credential' };
const app = { id: 'app', ownerAccountId: 'owner', targetDeviceId: 'pc', deviceBindings: [binding] };
const worker = { id: 'pc', appId: 'app' };
const roleId = 'example';
const createPlan = { title: 'Fixture', focus: 'Fixture', keywords: ['test'], steps: [{ id: 'step', title: 'Step' }], activationStatus: '进行中', markerStatus: 'waiting' };
const createMemory = { title: 'Fixture', focus: 'Fixture', keywords: ['test'], content: 'Synthetic fixture' };
const requests = {
  knowledge_search: { roleId }, plan_list: { roleId }, plan_get: { roleId, id: 'plan' }, plan_statuses: { roleId },
  memory_list: { roleId, kind: 'recent' }, memory_get: { roleId, id: 'memory', kind: 'consolidated' },
  plan_create: { roleId, idempotencyKey: 'create-plan', body: createPlan },
  plan_update: { roleId, id: 'plan', etag: '"v1"', idempotencyKey: 'update-plan', body: { title: 'Changed' } },
  recent_memory_create: { roleId, idempotencyKey: 'create-memory', body: createMemory },
  recent_memory_update: { roleId, id: 'memory', etag: '"v1"', idempotencyKey: 'update-memory', body: { content: 'Changed' } }
};

test('bound application devices use every registered knowledge tool without additional grants', () => {
  assert.deepEqual(Object.keys(requests).sort(), Object.keys(definitions).sort());
  for (const [name, args] of Object.entries(requests)) {
    const result = authorizeKnowledgeRequest(app, binding, worker, { operation: 'call', name, args });
    assert.deepEqual(result.metadata, { appId: 'app', deviceBindingId: 'device', ownerAccountId: 'owner', targetDeviceId: 'pc' });
    assert.equal('grant' in result, false);
    assert.equal(result.nonReplayable, name.endsWith('_create') || name.endsWith('_update'));
    assert.notEqual(result.request.args, args);
  }
  assert.equal(authorizeKnowledgeRequest(app, binding, worker, { operation: 'list' }).nonReplayable, false);
  const recent = { ...requests.memory_get, kind: 'recent', idempotencyKey: 'touch-original' };
  assert.equal(authorizeKnowledgeRequest(app, binding, worker, { operation: 'call', name: 'memory_get', args: recent }).nonReplayable, true);
});

test('retired role, tool and write grants do not restrict current application membership', () => {
  const member = { ...binding, knowledgeGrantState: { revision: 1, grant: { allowedRoles: [], allowedTools: [], allowWrites: false }, operations: [] } };
  const legacyApp = { ...app, deviceBindings: [member] };
  assert.equal(authorizeKnowledgeRequest(legacyApp, member, worker, { operation: 'call', name: 'recent_memory_create', args: requests.recent_memory_create }).nonReplayable, true);
});

test('device credential, application ownership and selected PC remain required', () => {
  for (const value of [undefined, { ...binding, enabled: false }, { ...binding, credentialHash: '' }, { ...binding, credentialHash: 'changed' }, { ...binding, id: 'another' }])
    assert.throws(() => authorizeKnowledgeRequest(app, value, worker, { operation: 'list' }), error => error.statusCode === 403);
  for (const value of [{ ...app, enabled: false }, { ...app, ownerAccountId: '' }, { ...app, deviceBindings: [] }])
    assert.throws(() => authorizeKnowledgeRequest(value, binding, worker, { operation: 'list' }), error => error.statusCode === 403);
  for (const value of [undefined, { id: 'other', appId: 'app' }, { id: 'pc', appId: 'other' }])
    assert.throws(() => authorizeKnowledgeRequest(app, binding, value, { operation: 'list' }), error => error.statusCode === 409);
  assert.throws(() => authorizeKnowledgeRequest({ ...app, targetDeviceId: '' }, binding, worker, { operation: 'list' }), error => error.statusCode === 409);
});

test('untrusted fields, malformed tool arguments and unstable mutation keys are rejected before queueing', () => {
  for (const body of [
    { operation: 'list', appId: 'other' }, { operation: 'list', knowledge: { appId: 'other' } },
    { operation: 'list', name: 'plan_list' }, { operation: 'list', url: 'http://invalid' },
    { operation: 'call', name: 'shell', args: {} }, { operation: 'call', name: 'plan_list', args: { roleId, token: 'injected' } },
    { operation: 'call', name: 'plan_create', args: { roleId, idempotencyKey: 'a' } },
    { operation: 'call', name: 'recent_memory_create', args: { ...requests.recent_memory_create, idempotencyKey: 'a/b' } },
    { operation: 'call', name: 'recent_memory_create', args: { ...requests.recent_memory_create, idempotencyKey: 'a'.repeat(201) } },
    { operation: 'call', name: 'memory_get', args: { ...requests.memory_get, kind: 'recent' } }
  ]) assert.throws(() => authorizeKnowledgeRequest(app, binding, worker, body), error => error.statusCode === 400);
});

test('generic reserved paths remain unavailable to ordinary proxy requests', () => {
  for (const value of ['/__rabilink/knowledge', '/%5f%5frabilink/knowledge', '/__rabilink/knowledge/a', '/a/../__rabilink/knowledge'])
    assert.throws(() => rejectReservedKnowledgePath(value));
  rejectReservedKnowledgePath('/meta');
});
