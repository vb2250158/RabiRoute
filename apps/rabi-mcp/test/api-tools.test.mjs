import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiTools, combineMcpTools } from '../lib/api-tools.mjs';
import { createManagerClient } from '../lib/manager-client.mjs';

const operation = (id, method = 'GET', transport = 'http', pathTemplate = '/fixture/:id', mode = method === 'GET' ? 'read' : 'mutation') => ({ id, contract: { operationId: id, method, transport, pathTemplate, effects: { mode } } });
function fixture(entries = [operation('fixture.read'), operation('fixture.save', 'PUT')], settings = {}) {
  const calls = [];
  const client = { catalog: { refresh: async () => ({ operations: entries, catalogDigest: 'fixture', applicationGenerationId: 'generation', managerInstanceId: 'manager' }) }, invokeOperation: async (id, options) => { calls.push({ id, options }); return { ok: true, statusCode: 200, uncertain: false, headers: { 'content-type': 'application/json' }, bodyBytes: Buffer.from('{"code":0,"data":{"saved":true}}') }; }, openOperation: async () => { throw new Error('not configured'); } };
  return { client, calls, tools: createApiTools({ client, ...settings }) };
}

test('public discovery is dynamic, paginated and describes original contracts', async () => {
  const entries = [operation('fixture.read'), operation('fixture.save', 'PUT')];
  const { tools } = fixture(entries);
  const first = await tools.call('rabi_api_list', { limit: 1 });
  assert.equal(first.data.total, 2); assert.equal(first.data.nextCursor, 1);
  entries.push(operation('new.plugin'));
  const last = await tools.call('rabi_api_list', { cursor: 2 });
  assert.equal(last.data.operations[0].id, 'new.plugin');
  assert.deepEqual((await tools.call('rabi_api_describe', { operationId: 'new.plugin' })).data, entries[2]);
});

test('generic call preserves business headers, original receipt and JSON/text/binary bodies without replay', async () => {
  const { tools, calls, client } = fixture();
  const result = await tools.call('rabi_api_call', { operationId: 'fixture.save', options: { path: { id: 'one' }, body: { content: 'changed' }, headers: { 'if-match': 'revision', 'idempotency-key': 'stable' } } });
  assert.equal(result.data.code, 0); assert.equal(result.businessCompletion, 'inspect_original_receipt');
  assert.equal(calls[0].options.headers['idempotency-key'], 'stable');
  client.invokeOperation = async (_id, options) => { calls.push(options); return { ok: false, statusCode: 503, uncertain: true, headers: { 'content-type': 'application/octet-stream' }, bodyBytes: Uint8Array.of(0, 255) }; };
  const uncertain = await tools.call('rabi_api_call', { operationId: 'fixture.save', options: { bodyBase64: 'AP8=' } });
  assert.equal(uncertain.uncertain, true); assert.equal(uncertain.bodyBase64, 'AP8=');
  assert.deepEqual([...calls[1].bodyBytes], [0, 255]); assert.equal(calls.length, 2);
});

test('explicit policy constrains its configured role/write scope and names the setting', async () => {
  const { tools, calls } = fixture([operation('role.read', 'GET', 'http', '/api/roles/:roleId/configuration'), operation('other.read'), operation('role.save', 'PUT', 'http', '/api/roles/:roleId/configuration'), operation('recent.touch', 'GET', 'http', '/api/roles/:roleId/recent', 'native-recent-memory-touch-unless-read-only')], { allowedRoles: ['allowed'], allowWrites: false });
  await tools.call('rabi_api_call', { operationId: 'role.read', options: { path: { roleId: 'allowed' } } });
  await tools.call('rabi_api_call', { operationId: 'other.read', options: { path: { id: 'unscoped' } } });
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'role.read', options: { path: { roleId: 'excluded' } } }), /RABI_MCP_ALLOWED_ROLES/);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'role.save', options: { path: { roleId: 'allowed' } } }), /RABI_MCP_ALLOW_WRITES/);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'recent.touch', options: { path: { roleId: 'allowed' } } }), /RABI_MCP_ALLOW_WRITES/);
  assert.equal(calls.length, 2);
});

test('explicit read policy follows fixed operation effects for POST queries and refuses touching GETs and wildcard writes', async () => {
  const { tools, calls } = fixture([
    operation('query.post', 'POST', 'http', '/query', 'read'),
    operation('touch.get', 'GET', 'http', '/touch', 'native-recent-memory-touch-unless-read-only'),
    operation('proxy', '*', 'http', '/proxy', 'read')
  ], { allowWrites: false });
  assert.equal((await tools.call('rabi_api_call', { operationId: 'query.post', options: { body: { query: 'example' } } })).ok, true);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'touch.get' }), /RABI_MCP_ALLOW_WRITES/);
  assert.equal((await tools.call('rabi_api_call', { operationId: 'proxy', options: { method: 'GET' } })).ok, true);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'proxy', options: { method: 'POST' } }), /RABI_MCP_ALLOW_WRITES/);
  assert.equal(calls.length, 2);
});

test('role policy checks equivalent JSON payload encodings and rejects ignored query role scope', async () => {
  const create = { ...operation('roles.create', 'POST', 'http', '/api/roles'), contract: { ...operation('roles.create', 'POST', 'http', '/api/roles').contract, request: { body: { kind: 'json', schema: { type: 'object', properties: { roleId: { type: 'string' }, title: { type: 'string' } } } } } } };
  const list = { ...operation('roles.list', 'GET', 'http', '/api/roles'), contract: { ...operation('roles.list', 'GET', 'http', '/api/roles').contract, request: { query: { type: 'object', properties: { query: { type: 'string' } } } } } };
  const query = { ...operation('role.query'), contract: { ...operation('role.query').contract, request: { query: { type: 'object', properties: { roleId: { type: 'string' } } } } } };
  const { tools, calls } = fixture([create, list, query], { allowedRoles: ['allowed'] });
  const excluded = JSON.stringify({ roleId: 'excluded', title: 'excluded' });
  for (const options of [{ body: JSON.parse(excluded) }, { bodyText: excluded }, { bodyBase64: Buffer.from(excluded).toString('base64') }]) {
    await assert.rejects(tools.call('rabi_api_call', { operationId: create.id, options }), /RABI_MCP_ALLOWED_ROLES/);
  }
  await assert.rejects(tools.call('rabi_api_call', { operationId: list.id, options: { query: { roleId: 'allowed' } } }), /RABI_MCP_ALLOWED_ROLES/);
  await assert.rejects(tools.call('rabi_api_call', { operationId: query.id, options: { query: { roleId: ['excluded', 'allowed'] } } }), /RABI_MCP_ALLOWED_ROLES/);
  const allowed = JSON.stringify({ roleId: 'allowed', title: 'allowed' });
  for (const options of [{ body: JSON.parse(allowed) }, { body: allowed }, { bodyText: allowed }, { bodyBase64: Buffer.from(allowed).toString('base64') }]) {
    assert.equal((await tools.call('rabi_api_call', { operationId: create.id, options })).ok, true);
  }
  assert.equal(calls.length, 4);
  const unscoped = fixture([create, list]);
  assert.equal((await unscoped.tools.call('rabi_api_call', { operationId: create.id, options: { bodyText: excluded } })).ok, true);
  assert.equal((await unscoped.tools.call('rabi_api_call', { operationId: list.id, options: { query: { roleId: 'anything' } } })).ok, true);
});

test('stream sessions expose actual chunks and final receipt, close cancels original work', async () => {
  const { tools, client } = fixture([operation('events', 'GET', 'sse')]);
  let started, cancelled = 0;
  const available = new Promise(resolve => { started = resolve; });
  client.invokeOperation = async (_id, options) => {
    options.onChunk(Buffer.from('data: first\n\n')); started();
    await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled++; resolve(); }, { once: true }));
    return { ok: false, statusCode: 200, uncertain: false, transportError: 'CANCELLED' };
  };
  const opened = await tools.call('rabi_api_call', { operationId: 'events' }); await available;
  assert.equal(opened.businessCompletion, false);
  const read = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' });
  assert.equal(Buffer.from(read.frames[0].data, 'base64').toString(), 'data: first\n\n');
  await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'close' });
  assert.equal(cancelled, 1);
  await assert.rejects(tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' }), /not found/);
});

test('WebSocket sessions send actual frames and release on adapter shutdown', async () => {
  const { tools, client } = fixture([operation('socket', 'GET', 'websocket')]);
  let end, sent, closed = 0;
  client.openOperation = async (_id, options) => {
    options.onMessage({ hello: true }, { binary: false });
    return { closed: new Promise(resolve => { end = resolve; }), sendJsonAsync: async value => { sent = value; }, close: () => { closed++; end({ code: 1000 }); } };
  };
  const opened = await tools.call('rabi_api_call', { operationId: 'socket' });
  const read = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' });
  assert.deepEqual(read.frames[0], { encoding: 'json', data: { hello: true } });
  const result = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'send', json: { action: 'ping' } });
  assert.equal(result.businessCompletion, false); assert.deepEqual(sent, { action: 'ping' });
  await tools.close(); assert.equal(closed, 1);
});

test('stream high-water marks apply backpressure without discarding large frames and completed sessions release capacity', async t => {
  const { client } = fixture([operation('events', 'GET', 'sse')]);
  let calls = 0, produced = 0;
  client.invokeOperation = async (_id, options) => { calls++; for (let i = 0; i < 4; i++) { await options.onChunk(Buffer.alloc(100, i)); produced++; } return { ok: true, statusCode: 200 }; };
  const tools = createApiTools({ client, maxSessions: 1, maxSessionBytes: 20 });
  t.after(() => tools.close());
  const open = await tools.call('rabi_api_call', { operationId: 'events' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(produced, 1);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'events' }), /capacity/);
  const received = [];
  let final;
  for (let i = 0; i < 6; i++) {
    const read = await tools.call('rabi_api_session', { sessionId: open.sessionId, action: 'read' });
    received.push(...read.frames.map(frame => Buffer.from(frame.data, 'base64')));
    if (read.released) { final = read; break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(final.receipt.ok, true); assert.equal(received.length, 4);
  for (let i = 0; i < 4; i++) assert.deepEqual(received[i], Buffer.alloc(100, i));
  const next = await tools.call('rabi_api_call', { operationId: 'events' });
  assert.equal(next.state, 'running');
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'missing' }), /absent/);
  await tools.close();
  assert.equal(calls, 2);
});

test('combined tools preserve existing knowledge behavior and close both owners', async () => {
  let closed = 0;
  const knowledge = { list: () => [{ name: 'knowledge_search' }], call: async () => ({ ok: true, commitState: 'committed' }), close: () => { closed++; } };
  const { tools } = fixture();
  const combined = combineMcpTools(knowledge, tools);
  assert.ok(combined.list().some(item => item.name === 'knowledge_search'));
  assert.ok(combined.list().some(item => item.name === 'rabi_api_call'));
  assert.equal((await combined.call('knowledge_search')).commitState, 'committed');
  await combined.close(); assert.equal(closed, 1);
});

test('discovery-only native listeners expose their actual connector requirements without false invocation', async () => {
  const entry = { ...operation('native.listener'), binding: { invocation: 'discovery-only', protocol: 'mqtt', authentication: { kind: 'native', description: 'Use the native listener credential.' } } };
  const { tools, calls } = fixture([entry]);
  const receipt = await tools.call('rabi_api_call', { operationId: entry.id });
  assert.equal(receipt.ok, false); assert.equal(receipt.state, 'not_started'); assert.equal(receipt.error, 'NATIVE_CONNECTOR_REQUIRED');
  assert.equal(receipt.binding.protocol, 'mqtt'); assert.equal(calls.length, 0);
});

test('warm generic calls reuse the shared catalog without extra HTTP trips and discover additions/removals without replay', async () => {
  const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-manager', health: { live: true, requiredReady: true, state: 'healthy' } };
  const entry = id => ({ id, contractDigest: 'sha256:' + 'a'.repeat(64), contract: { operationId: id, contractVersion: '1.0.0', method: 'GET', pathTemplate: '/fixture/' + id, transport: 'http', effects: { mode: 'read' } } });
  let operations = [entry('original')], counts = {};
  const client = createManagerClient({ managerUrl: 'http://127.0.0.1:1', credential: 'fixture-only', fetchImpl: async url => {
    const target = new URL(url).pathname; counts[target] = (counts[target] ?? 0) + 1;
    if (target === '/meta') return Response.json(meta);
    if (target === '/api/agent/help') return Response.json({ code: 0, data: { schemaVersion: '2', ...meta, pluginGenerationId: 'fixture', catalogRevision: operations.length, catalogDigest: 'sha256:' + 'b'.repeat(64), operations } });
    return Response.json({ code: target === '/fixture/original' && !operations.some(item => item.id === 'original') ? -1 : 0 }, { status: target === '/fixture/original' && !operations.some(item => item.id === 'original') ? 404 : 200 });
  } });
  const tools = createApiTools({ client });
  await tools.call('rabi_api_call', { operationId: 'original' });
  counts = {}; await client.invokeOperation('original'); const direct = { ...counts };
  counts = {}; await tools.call('rabi_api_call', { operationId: 'original' }); assert.deepEqual(counts, direct);
  operations.push(entry('added')); counts = {};
  assert.equal((await tools.call('rabi_api_call', { operationId: 'added' })).ok, true);
  assert.equal(counts['/api/agent/help'], 1);
  operations = operations.filter(item => item.id !== 'original'); counts = {};
  assert.equal((await tools.call('rabi_api_call', { operationId: 'original' })).statusCode, 404);
  assert.equal(counts['/fixture/original'], 1); assert.equal(client.catalog.getSnapshot(), undefined);
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'original' }), /absent/);
  assert.equal(counts['/fixture/original'], 1);
  await tools.close();
});

test('raw finite JSON errors and unknown receipts remain failures after bytes decoding', async () => {
  const { client, tools } = fixture();
  client.invokeOperation = async () => ({ ok: true, statusCode: 200, uncertain: false, headers: { 'content-type': 'application/json' }, bodyBytes: Buffer.from('{"code":-1,"uncertain":true,"mutationOutcome":"unknown"}') });
  const receipt = await tools.call('rabi_api_call', { operationId: 'fixture.save', options: { body: { value: 'fixture' } } });
  assert.equal(receipt.ok, false); assert.equal(receipt.uncertain, true); assert.equal(receipt.data.code, -1); assert.equal(receipt.data.mutationOutcome, 'unknown');
});

test('adapter shutdown waits for cancellation of the original WebSocket opening attempt', async () => {
  const { client, tools } = fixture([operation('socket', 'GET', 'websocket')]);
  let entered, released = false;
  const started = new Promise(resolve => { entered = resolve; });
  client.openOperation = async (_id, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { setImmediate(() => { released = true; reject(new Error('cancelled')); }); }, { once: true });
    entered();
  });
  const original = tools.call('rabi_api_call', { operationId: 'socket' });
  await started; await tools.close();
  assert.equal(released, true); assert.equal((await original).ok, false);
});

test('unread terminal results retain a bounded payload budget and terminal read releases the original result', async t => {
  const { client } = fixture([operation('events', 'GET', 'sse')]);
  client.invokeOperation = async (_id, options) => { await options.onChunk(Buffer.alloc(100)); return { ok: true, originalReceipt: 'retained' }; };
  const tools = createApiTools({ client, maxSessions: 1, maxSessionBytes: 20 }); t.after(() => tools.close());
  const opened = await tools.call('rabi_api_call', { operationId: 'events' }); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(tools.call('rabi_api_call', { operationId: 'events' }), /Unread completed/);
  const final = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' });
  assert.equal(final.released, true); assert.equal(final.frames.length, 1); assert.equal(final.receipt.originalReceipt, 'retained');
  assert.equal((await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'close' })).state, 'not_present');
  const next = await tools.call('rabi_api_call', { operationId: 'events' });
  assert.ok(next.sessionId);
});


test('shutdown during discovery cannot start a later business request or stream', async () => {
  let release;
  const discovery = new Promise(resolve => { release = resolve; });
  let invoked = 0;
  const tools = createApiTools({ progressive: true, client: {
    operations: { describe: async () => { await discovery; return { operation: operation('late-write', 'POST') }; } },
    invokeOperation: async () => { invoked++; return { ok: true }; },
    openOperation: async () => { invoked++; throw new Error('must not open'); }
  } });
  const pending = tools.call('rabi_api_call', { operationId: 'late-write' });
  await tools.close(); release();
  await assert.rejects(pending, /closed/); assert.equal(invoked, 0);
});


test('a rejected native stream reports its original identity and releases after terminal read', async () => {
  const { tools, client } = fixture([operation('failed-events', 'GET', 'sse')]);
  client.invokeOperation = async () => { throw new Error('controlled stream failure'); };
  const opened = await tools.call('rabi_api_call', {operationId:'failed-events',options:{headers:{'idempotency-key':'request-original'}}});
  await new Promise(resolve => setImmediate(resolve));
  const result = await tools.call('rabi_api_session', {sessionId:opened.sessionId,action:'read'});
  assert.equal(result.ok, false); assert.equal(result.released, true); assert.equal(result.operation, 'failed-events');
  assert.equal(result.requestId, 'request-original');
  await assert.rejects(tools.call('rabi_api_session', {sessionId:opened.sessionId,action:'read'}), /not found/);
  assert.equal((await tools.call('rabi_api_session', {sessionId:opened.sessionId,action:'close'})).state, 'not_present');
  await tools.close();
});
