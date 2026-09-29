import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createManagerClient } from '../lib/manager-client.mjs';
import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';

const planBody = { title: 'Fixture plan', focus: 'HTTP contract', keywords: ['fixture'], steps: [{ id: 's1', title: 'Verify' }], activationStatus: '进行中', markerStatus: 'ready' };
const memoryBody = { title: 'Fixture memory', focus: 'HTTP contract', keywords: ['fixture'], content: 'Temporary in-memory fixture only.' };

async function fixture(t) {
  const state = { generation: 1, mode: 'normal', calls: [], records: new Map(), receipts: new Map(), commits: 0 };
  const meta = () => ({ applicationGenerationId: `generation-${state.generation}`, managerInstanceId: `instance-${state.generation}`, health: { live: true, requiredReady: true, state: 'healthy' } });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/meta') return send(res, 200, meta());
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      if (state.mode === 'switch') state.generation++;
      if (state.mode === '503') return send(res, 503, { code: -1, commitState: 'unknown' });
      const prefix = '/api/roles/example/';
      if (!url.pathname.startsWith(prefix)) return send(res, 404, { code: -1 });
      const relative = url.pathname.slice(prefix.length);
      if (req.method === 'GET') {
        if (relative === 'knowledge/search') return send(res, 200, { code: 0, data: { items: [...state.records.values()].map(r => r.data), cursor: null } });
        const record = state.records.get(relative);
        return record ? send(res, 200, { code: 0, data: record.data }, { etag: record.etag }) : send(res, 404, { code: -1 });
      }
      const key = req.headers['idempotency-key'];
      const intent = JSON.stringify([req.method, relative, body]);
      const previous = state.receipts.get(key);
      if (previous) {
        if (previous.intent !== intent) return send(res, 409, { code: -1, commitState: 'not_started' });
        return send(res, previous.status, previous.body, previous.headers);
      }
      const existing = state.records.get(relative);
      if (req.method === 'PATCH' && (!existing || req.headers['if-match'] !== existing.etag)) return send(res, 412, { code: -1, commitState: 'not_started' });
      const id = req.method === 'POST' ? `resource-${state.commits + 1}` : existing.data.id;
      const record = { data: { ...existing?.data, ...body, id }, etag: `"revision-${++state.commits}"` };
      state.records.set(req.method === 'POST' ? `${relative}/${id}` : relative, record);
      const receipt = { intent, status: req.method === 'POST' ? 201 : 200, body: { code: 0, data: record.data }, headers: { etag: record.etag, 'idempotency-key': key } };
      state.receipts.set(key, receipt);
      // Simulate a committed operation whose HTTP response never reaches its caller.
      if (state.mode === 'drop') return req.socket.destroy();
      send(res, receipt.status, receipt.body, receipt.headers);
    })().catch(() => { if (!res.destroyed) send(res, 500, { code: -1, commitState: 'unknown' }); });
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const managerUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createManagerClient({ managerUrl, localHost: true, timeoutMs: 2000, endpointSession: { ensure: async () => ({ managerUrl, meta: meta() }) } });
  return { state, tools: createKnowledgeTools({ client, allowedRoles: ['example'], allowWrites: true }) };
}

for (const [label, createName, updateName, body, resourcePath] of [
  ['plan', 'plan_create', 'plan_update', planBody, 'plans'],
  ['recent memory', 'recent_memory_create', 'recent_memory_update', memoryBody, 'memory/recent']
]) test(`real HTTP ${label} create/update carries exact headers and verified receipts`, async t => {
  const { state, tools } = await fixture(t);
  const created = await tools.call(createName, { roleId: 'example', idempotencyKey: 'create-key', body });
  assert.equal(created.ok, true);
  assert.equal(created.statusCode, 201);
  assert.equal(created.commitState, 'committed');
  assert.equal(created.etag, '"revision-1"');
  const updated = await tools.call(updateName, { roleId: 'example', id: created.data.id, idempotencyKey: 'update-key', etag: created.etag, body: { title: 'Updated fixture' } });
  assert.equal(updated.ok, true);
  assert.equal(updated.data.title, 'Updated fixture');
  assert.equal(updated.etag, '"revision-2"');
  assert.equal(state.calls[0].path, `/api/roles/example/${resourcePath}`);
  assert.equal(state.calls[0].headers['idempotency-key'], 'create-key');
  assert.equal(state.calls[0].headers['content-type'], 'application/json');
  assert.equal(state.calls[0].headers['if-match'], undefined);
  assert.equal(state.calls[0].headers.authorization, undefined);
  assert.equal(state.calls[0].headers['x-rabiroute-agent-id'], undefined);
  assert.equal(state.calls[1].headers['if-match'], created.etag);
  assert.equal(state.calls[1].headers['idempotency-key'], 'update-key');
  assert.equal(state.commits, 2);
});

test('real HTTP search and plan detail preserve query and resource identity', async t => {
  const { state, tools } = await fixture(t);
  const created = await tools.call('plan_create', { roleId: 'example', idempotencyKey: 'create', body: planBody });
  const found = await tools.call('knowledge_search', { roleId: 'example', query: 'fixture + value', kind: 'plan', limit: 3 });
  assert.equal(found.ok, true);
  assert.equal(found.data.items[0].id, created.data.id);
  assert.equal(state.calls[1].query.query, 'fixture + value');
  assert.equal(state.calls[1].query.limit, '3');
  assert.equal(state.calls[1].headers['idempotency-key'], undefined);
  const detail = await tools.call('plan_get', { roleId: 'example', id: created.data.id });
  assert.equal(detail.ok, true);
  assert.equal(detail.etag, created.etag);
});

test('same key/body is deduplicated by HTTP Manager and changed intent conflicts', async t => {
  const { state, tools } = await fixture(t);
  const args = { roleId: 'example', idempotencyKey: 'stable-key', body: planBody };
  const first = await tools.call('plan_create', args);
  const duplicate = await tools.call('plan_create', args); // Explicit caller replay, not automatic transport retry.
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.data, first.data);
  assert.equal(duplicate.etag, first.etag);
  const conflict = await tools.call('plan_create', { ...args, body: { ...planBody, title: 'Different intent' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.ok, false);
  assert.equal(state.commits, 1);
  assert.equal(state.calls.length, 3);
});

test('stale If-Match returns 412 without committing or retrying', async t => {
  const { state, tools } = await fixture(t);
  const created = await tools.call('plan_create', { roleId: 'example', idempotencyKey: 'create', body: planBody });
  const result = await tools.call('plan_update', { roleId: 'example', id: created.data.id, idempotencyKey: 'stale', etag: '"old"', body: { title: 'Rejected' } });
  assert.equal(result.statusCode, 412);
  assert.equal(result.commitState, 'not_started');
  assert.equal(result.uncertain, false);
  assert.equal(result.ok, false);
  assert.equal(state.commits, 1);
  assert.equal(state.calls.length, 2);
});

for (const mode of ['503', 'drop']) test(`uncertain HTTP ${mode} mutation is sent exactly once`, async t => {
  const { state, tools } = await fixture(t);
  state.mode = mode;
  const result = await tools.call('recent_memory_create', { roleId: 'example', idempotencyKey: 'uncertain-key', body: memoryBody });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.commitState, 'unknown');
  assert.equal(result.idempotencyKey, 'uncertain-key');
  assert.equal(state.calls.length, 1);
  assert.equal(state.commits, mode === 'drop' ? 1 : 0);
});

test('continuously changing HTTP identity rejects reads after bounded recovery', async t => {
  const { state, tools } = await fixture(t);
  state.mode = 'switch';
  const result = await tools.call('knowledge_search', { roleId: 'example' });
  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(state.calls.length, 2); // One safe read recovery, still fenced against the next generation.
  assert.equal(state.commits, 0);
});

test('HTTP generation change after a committed write is uncertain and never replayed', async t => {
  const { state, tools } = await fixture(t);
  state.mode = 'switch';
  const result = await tools.call('plan_create', { roleId: 'example', idempotencyKey: 'generation-key', body: planBody });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.commits, 1);
});
