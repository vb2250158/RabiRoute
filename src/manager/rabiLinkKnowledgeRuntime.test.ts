import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { RabiLinkRelayRuntime } from './rabiLinkRelayRuntime.js';
import { executeKnowledgeQueue, probeKnowledgeBridge, type KnowledgeRuntimeContext } from './rabiLinkKnowledgeRuntime.js';

const metadata = { appId: 'app', deviceBindingId: 'device', ownerAccountId: 'owner', targetDeviceId: 'pc' };
const plan = { title: 'Goal', focus: 'One goal', keywords: ['goal'], steps: [{ id: 's', title: 'Step' }], activationStatus: '进行中', markerStatus: 'ready' };
type Result = { allowedRoles?: string[]; allowWrites?: boolean; tools?: Array<{ name: string; inputSchema: { properties: { roleId: { enum: string[] } } } }>; structuredContent?: { ok: boolean; uncertain: boolean; data?: { id: string }; etag?: string } };
async function fixture(t: test.TestContext, ownerEvents = false) {
  let generation = 'generation', ready = true, dropWrite = false, switchWrite = false;
  const calls: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const roles = ['one'];
  const server = http.createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json');
      if (ownerEvents && request.url === '/api/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: ready\ndata: {}\n\n');
        return;
      }
      if (request.url === '/meta') { response.end(JSON.stringify({ applicationGenerationId: generation, managerInstanceId: 'instance', health: { live: ready, requiredReady: ready, state: ready ? 'healthy' : 'starting' } })); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: request.method!, path: request.url!, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
      const mutation = request.method !== 'GET' || !!request.headers['idempotency-key'];
      if (switchWrite && mutation) generation = 'another-generation';
      if (dropWrite && mutation) { request.socket.destroy(); return; }
      response.writeHead(request.method === 'POST' ? 201 : 200, { etag: '"revision"', ...(request.headers['idempotency-key'] ? { 'idempotency-key': request.headers['idempotency-key'] as string } : {}) });
      response.end(JSON.stringify({ code: 0, data: { id: request.url!.split('/').at(-1) === 'plan' ? 'plan' : request.url!.split('/').at(-1) === 'memory' ? 'memory' : 'created' } }));
    })().catch(() => { if (!response.destroyed) response.writeHead(500).end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const managerBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const context: KnowledgeRuntimeContext = { endpoint: () => ({ managerBaseUrl, applicationGenerationId: 'generation', managerInstanceId: 'instance' }), roleIds: () => roles };
  return { context, calls, roles, setReady(value: boolean) { ready = value; }, dropWrite() { dropWrite = true; }, switchWrite() { switchWrite = true; } };
}
test('built-in direct catalog requires no MCP URL/token/policy and follows current persona owner', async t => {
  const f = await fixture(t);
  assert.equal(await probeKnowledgeBridge(f.context), true);
  const first = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'list' }, false) as Result;
  assert.equal(first.tools!.length, 10); assert.equal(first.allowWrites, true); assert.deepEqual(first.allowedRoles, ['one']);
  f.roles.push('two');
  const next = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'list' }, false) as Result;
  assert.deepEqual(next.allowedRoles, ['one', 'two']); assert.deepEqual(next.tools![0].inputSchema.properties.roleId.enum, ['one', 'two']);
  const created = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'call', name: 'plan_create', args: { roleId: 'two', idempotencyKey: 'saved-key', body: plan } }, true) as Result;
  assert.equal(created.structuredContent!.ok, true); assert.equal(created.structuredContent!.data!.id, 'created');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/roles/two/plans'); assert.equal(f.calls[0].headers['idempotency-key'], 'saved-key');
  assert.equal(f.calls[0].headers.authorization, undefined); assert.equal(f.calls[0].headers['x-rabiroute-agent-id'], undefined);
});
test('startup probe avoids requiredReady recursion; actual calls retain business health gate', async t => {
  const f = await fixture(t); f.setReady(false);
  assert.equal(await probeKnowledgeBridge(f.context), true);
  await assert.rejects(executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'list' }, false), /NOT_READY/);
  assert.equal(f.calls.length, 0);
  f.setReady(true);
  assert.equal((await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'list' }, false) as Result).tools!.length, 10);
});
test('stopping an owner probe aborts its actual pending Manager metadata fetch', async t => {
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/meta');
    request.once('close', disconnected);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    received();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const managerBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const context: KnowledgeRuntimeContext = { endpoint: () => ({ managerBaseUrl, applicationGenerationId: 'generation', managerInstanceId: 'instance' }), roleIds: () => [] };
  const controller = new AbortController();
  const probe = probeKnowledgeBridge(context, controller.signal);
  await arrived;
  const started = Date.now();
  controller.abort();
  assert.equal(await probe, false);
  await closed;
  assert.ok(Date.now() - started < 1000, 'probe waits for owner cancellation, not the 5s metadata timeout');
});
test('target/identity/schema/nonReplayable denial happens before business I/O', async t => {
  const f = await fixture(t);
  for (const [target, identity, request, nonReplayable] of [
    ['other', metadata, { operation: 'list' }, false],
    ['pc--invalid', metadata, { operation: 'list' }, false],
    ['pc', undefined, { operation: 'list' }, false],
    ['pc', { ...metadata, ownerAccountId: '' }, { operation: 'list' }, false],
    ['pc', metadata, { operation: 'call', name: 'plan_create', args: { roleId: 'one', idempotencyKey: 'key', body: plan } }, false],
    ['pc', metadata, { operation: 'call', name: 'memory_get', args: { roleId: 'one', kind: 'recent', id: 'memory', idempotencyKey: 'key' } }, false],
    ['pc', metadata, { operation: 'call', name: 'plan_get', args: { roleId: 'missing', id: 'plan' } }, false],
    ['pc', metadata, { operation: 'call', name: 'plan_get', args: { roleId: 'one', id: 'plan', url: 'https://invalid.test' } }, false]
  ] as const) await assert.rejects(executeKnowledgeQueue(f.context, target, identity, request, nonReplayable));
  assert.equal(f.calls.length, 0);
  const traversal = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'call', name: 'plan_get', args: { roleId: 'one', id: '../plan' } }, false) as { ok: boolean };
  assert.equal(traversal.ok, false);
  assert.equal(f.calls.length, 0);
});
test('direct updates retain strong ETag and recent detail retains touch key', async t => {
  const f = await fixture(t);
  const updated = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'call', name: 'plan_update', args: { roleId: 'one', id: 'plan', etag: '"before"', idempotencyKey: 'update', body: { title: 'Revised' } } }, true) as Result;
  assert.equal(updated.structuredContent!.ok, true); assert.equal(f.calls[0].headers['if-match'], '"before"');
  const touch = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'call', name: 'memory_get', args: { roleId: 'one', id: 'memory', kind: 'recent', idempotencyKey: 'view' } }, true) as Result;
  assert.equal(touch.structuredContent!.ok, true); assert.equal(f.calls[1].method, 'GET'); assert.equal(f.calls[1].headers['idempotency-key'], 'view');
});
for (const failure of ['dropped response', 'changed generation']) test(`direct ${failure} write remains uncertain and is dispatched once`, async t => {
  const f = await fixture(t); if (failure === 'dropped response') f.dropWrite(); else f.switchWrite();
  const result = await executeKnowledgeQueue(f.context, 'pc', metadata, { operation: 'call', name: 'plan_create', args: { roleId: 'one', idempotencyKey: 'original-key', body: plan } }, true) as Result;
  assert.equal(result.structuredContent!.ok, false); assert.equal(result.structuredContent!.uncertain, true); assert.equal(f.calls.length, 1);
});
test('connected relay queue advertises built-in knowledge and rejects generic proxy metadata forgery', async t => {
  const f = await fixture(t, true);
  let claimed = false, advertised = '';
  const finished: Array<{ statusCode: number }> = [];
  const relay = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://fixture.test');
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/rabilink/events') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: ready\ndata: {}\n\n'); return; }
      if (url.pathname === '/worker/webgui-requests') {
        advertised = url.searchParams.get('capabilities') || '';
        const requests = claimed ? [] : [{ id: 'authorized', method: 'POST', path: '/__rabilink/knowledge', knowledge: metadata, bodyBase64: Buffer.from('{"operation":"list"}').toString('base64') }, { id: 'generic', method: 'POST', path: '/__rabilink/knowledge', bodyBase64: Buffer.from(JSON.stringify({ operation: 'list', metadata })).toString('base64') }];
        claimed = true; response.end(JSON.stringify({ requests })); return;
      }
      if (url.pathname.endsWith('/response')) { const chunks = []; for await (const chunk of request) chunks.push(chunk); finished.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.end('{}'); return; }
      response.end('{"requests":[]}');
    })().catch(() => { if (!response.destroyed) response.writeHead(500).end(); });
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  t.after(async () => { relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const runtime = new RabiLinkRelayRuntime({ knowledge: f.context }); t.after(() => runtime.stop());
  await runtime.sync({ enabled: true, url: relayUrl, token: 'fixture-relay', deviceId: 'pc', deviceGuid: 'different-guid', deviceName: 'pc', claimWaitMs: 60000, localWebguiUrl: f.context.endpoint().managerBaseUrl, localSpeechUrl: '' });
  const deadline = Date.now() + 5000;
  while (finished.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished.length, 2); assert.ok(advertised.includes('knowledgebridge'));
  assert.equal(finished[0].statusCode, 200); assert.equal(finished[1].statusCode, 403); assert.equal(runtime.status().knowledgeBridgeReady, true);
  assert.equal(JSON.stringify(runtime.status()).includes('fixture-relay'), false);
  await runtime.stop(); assert.equal(runtime.status().knowledgeBridgeReady, false);
});
