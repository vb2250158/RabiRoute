import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';
function fixture(allowWrites = false) {
  const calls = [], allowedRoles = ['demo'];
  const tools = createKnowledgeTools({ allowWrites, allowedRoles, client: { async invoke(method, path, options) {
    calls.push({ method, path, options });
    return { ok: true, statusCode: method === 'POST' ? 201 : 200, body: JSON.stringify({ code: 0, data: { id: 'p1' } }), headers: { etag: '"v2"', 'idempotency-key': options.headers?.['Idempotency-Key'] } };
  } } });
  return { tools, calls, allowedRoles };
}
const plan = () => ({ title: 'Plan', focus: 'One goal', keywords: ['goal'], activationStatus: '进行中', markerStatus: 'analysis', steps: [{ id: 'inspect', title: 'Inspect' }] });
test('startup authorization is copied and writes are opt-in', async () => {
  const { tools, calls, allowedRoles } = fixture(); allowedRoles.push('other');
  assert.equal(tools.list().some(t => t.name === 'plan_create'), false);
  await assert.rejects(tools.call('plan_get', { roleId: 'other', id: 'p1' }));
  await assert.rejects(tools.call('plan_create', { roleId: 'demo', idempotencyKey: 'k', body: plan() }));
  await assert.rejects(tools.call('memory_get', { roleId: 'demo', kind: 'recent', id: 'p1' }));
  assert.equal(calls.length, 0);
});
test('typed whitelist rejects unknown fields, traversal and legacy state', async () => {
  const { tools, calls } = fixture(true);
  for (const args of [{ roleId: 'demo', id: '../p' }, { roleId: 'demo', id: '%2f' }, { roleId: 'demo', id: 'p1', headers: {} }]) await assert.rejects(tools.call('plan_get', args));
  await assert.rejects(tools.call('arbitrary', {}));
  for (const body of [{ ...plan(), status: 'analysis' }, { ...plan(), activationStatus: '已归档' }, { ...plan(), attachments: [] }, { ...plan(), focus: 'two\nlines' }, { ...plan(), importance: '1' }]) await assert.rejects(tools.call('plan_create', { roleId: 'demo', idempotencyKey: 'k', body }));
  assert.equal(calls.length, 0);
});
test('query mappings are bounded and explicit', async () => {
  const { tools, calls } = fixture();
  await tools.call('knowledge_search', { roleId: 'demo', query: 'a&b', archived: true });
  assert.match(calls[0].path, /query=a%26b&mode=keywords&archived=1&limit=10/);
  await tools.call('plan_list', { roleId: 'demo' }); assert.match(calls[1].path, /plans\?detail=summary&limit=20/);
  await tools.call('plan_statuses', { roleId: 'demo' }); assert.ok(calls[2].path.endsWith('/plan-marker-statuses'));
  await tools.call('memory_list', { roleId: 'demo', kind: 'recent' }); assert.match(calls[3].path, /memory\?kind=recent&limit=20/);
  await tools.call('memory_get', { roleId: 'demo', kind: 'consolidated', id: 'p1' }); assert.equal(calls[4].options.replaySafe, true);
});
test('mutations require stable key, strong etag; touch is non-replayable', async () => {
  const { tools, calls } = fixture(true);
  const result = await tools.call('plan_create', { roleId: 'demo', idempotencyKey: 'create-1', body: plan() });
  assert.equal(result.ok, true); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].options.replaySafe, false);
  assert.equal(calls[0].options.headers['If-Match'], undefined);
  for (const etag of ['*', 'W/"v1"', 'v1']) await assert.rejects(tools.call('plan_update', { roleId: 'demo', id: 'p1', etag, idempotencyKey: 'update-1', body: { nextAction: 'Review' } }));
  await tools.call('plan_update', { roleId: 'demo', id: 'p1', etag: '"v1"', idempotencyKey: 'update-1', body: { nextAction: 'Review' } });
  assert.equal(calls[1].options.headers['If-Match'], '"v1"');
  await assert.rejects(tools.call('memory_get', { roleId: 'demo', kind: 'recent', id: 'p1' }));
  await tools.call('memory_get', { roleId: 'demo', kind: 'recent', id: 'p1', idempotencyKey: 'touch-1' });
  assert.equal(calls[2].method, 'GET'); assert.equal(calls[2].options.replaySafe, false);
  await tools.call('recent_memory_create', { roleId: 'demo', idempotencyKey: 'memory-1', body: { title: 'Fact', focus: 'Fact', content: 'Content', keywords: ['fact'] } });
  assert.ok(calls[3].path.endsWith('/memory/recent'));
  await tools.call('recent_memory_update', { roleId: 'demo', id: 'p1', idempotencyKey: 'memory-2', etag: '"v1"', body: { content: 'Correction' } });
  assert.equal(calls[4].method, 'PATCH');
});
test('read-only Manager recent detail without a touch receipt is not confirmed', async () => {
  let count = 0;
  const tools = createKnowledgeTools({ allowedRoles: ['demo'], allowWrites: true, client: { async invoke(method, target, options) {
    count++; assert.equal(method, 'GET'); assert.equal(options.replaySafe, false);
    return { ok: true, statusCode: 200, headers: {}, body: { code: 0, data: { id: 'p1' } } };
  } } });
  const result = await tools.call('memory_get', { roleId: 'demo', kind: 'recent', id: 'p1', idempotencyKey: 'touch-1' });
  assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal(count, 1);
});
test('transport exceptions are redacted and never replayed', async () => {
  let count = 0;
  const tools = createKnowledgeTools({ allowedRoles: ['demo'], allowWrites: true, client: { invoke: async () => { count++; throw new Error('secret'); } } });
  const result = await tools.call('plan_create', { roleId: 'demo', idempotencyKey: 'stable', body: plan() });
  assert.equal(count, 1); assert.equal(result.uncertain, true); assert.equal(result.idempotencyKey, 'stable'); assert.ok(!JSON.stringify(result).includes('secret'));
});
