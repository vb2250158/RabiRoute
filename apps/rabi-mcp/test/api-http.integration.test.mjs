import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { createManagerClient } from '../lib/manager-client.mjs';
import { createApiTools } from '../lib/api-tools.mjs';

async function fixture(t) {
  const calls = [], sockets = new Set();
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 1, 2]);
  const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-manager', health: { live: true, requiredReady: true, state: 'healthy' } };
  const operations = [
    ['fixture.json', 'PUT', '/fixture/json', 'http'], ['fixture.binary', 'POST', '/fixture/binary', 'http'],
    ['fixture.events', 'GET', '/fixture/events', 'sse'], ['fixture.socket', 'GET', '/fixture/socket', 'websocket'],
    ['fixture.large', 'GET', '/fixture/large', 'http'], ['fixture.skill', 'GET', '/api/roles/:roleId/skills/:skillId/download', 'http'],
    ['fixture.thread', 'POST', '/api/agent/threads', 'http']
  ].map(([id, method, pathTemplate, transport]) => ({ id, contractDigest: 'sha256:' + 'a'.repeat(64), contract: { operationId: id, contractVersion: '1.0.0', method, pathTemplate, transport, effects: { mode: method === 'GET' ? 'read' : 'mutation' }, ...(transport === 'websocket' ? { websocket: { framing: 'json', incomingSchema: { type: 'object' }, outgoingSchema: { type: 'object' }, maxMessageBytes: 3 * 1024 * 1024, maxBufferedBytes: 6 * 1024 * 1024, closeGraceMs: 50 } } : {}) } }));
  const server = http.createServer(async (req, res) => {
    const send = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/meta') return send(meta);
    if (req.url.startsWith('/api/agent/help')) return send({ code: 0, data: { schemaVersion: '2', ...meta, pluginGenerationId: 'fixture-plugin', catalogRevision: 1, catalogDigest: 'sha256:' + 'b'.repeat(64), operations } });
    calls.push({ method: req.method, path: req.url, key: req.headers['idempotency-key'], digest: req.headers['x-rabiroute-api-contract'] });
    if (req.url === '/api/roles/example/skills/example/download') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length), 'x-rabiroute-content-sha256': createHash('sha256').update(zip).digest('hex') }); res.end(zip); return;
    }
    if (req.url === '/fixture/large') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let i = 0; i < 64; i++) if (!res.write(Buffer.alloc(65536, i))) await once(res, 'drain');
      res.end(); return;
    }
    if (req.url === '/fixture/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === '/fixture/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(body); }
    else send({ code: 0, state: 'committed', data: JSON.parse(body.toString()) });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server, path: '/fixture/socket' });
  wss.on('connection', socket => { socket.on('message', message => socket.send(message.toString())); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const managerUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createManagerClient({ managerUrl, localHost: true, timeoutMs: 2000, endpointSession: { ensure: async () => ({ managerUrl, meta }) } });
  const tools = createApiTools({ client });
  t.after(async () => { await tools.close(); for (const socket of wss.clients) socket.terminate(); wss.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { tools, calls, zip };
}

async function frames(tools, sessionId) {
  for (let i = 0; i < 50; i++) {
    const receipt = await tools.call('rabi_api_session', { sessionId, action: 'read' });
    if (receipt.frames.length || receipt.ok === false) return receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture frame was not delivered.');
}

test('real shared HTTP transport carries contract/revision keys and raw binary through generic tools', async t => {
  const { tools, calls } = await fixture(t);
  assert.equal((await tools.call('rabi_api_list')).data.total, 7);
  const json = await tools.call('rabi_api_call', { operationId: 'fixture.json', options: { headers: { 'idempotency-key': 'original' }, body: { title: 'example' } } });
  assert.equal(json.ok, true); assert.equal(json.data.state, 'committed'); assert.equal(json.data.data.title, 'example');
  const binary = await tools.call('rabi_api_call', { operationId: 'fixture.binary', options: { bodyBase64: 'AP8=' } });
  assert.equal(binary.bodyBase64, 'AP8=');
  assert.equal(calls.length, 2); assert.equal(calls[0].key, 'original'); assert.match(calls[0].digest, /^sha256:/);
});

test('generic MCP uses the original thread HTTP endpoint and receives exact skill ZIP bytes', async t => {
  const { tools, calls, zip } = await fixture(t);
  const payload = { action: 'send', deliveryId: 'original-fixture-id', threadId: 'fixture-target', prompt: 'controlled owner fixture only' };
  const submitted = await tools.call('rabi_api_call', { operationId: 'fixture.thread', options: { body: payload } });
  assert.equal(submitted.ok, true); assert.equal(submitted.data.data.deliveryId, payload.deliveryId);
  const archive = await tools.call('rabi_api_call', { operationId: 'fixture.skill', options: { path: { roleId: 'example', skillId: 'example' } } });
  assert.deepEqual(Buffer.from(archive.bodyBase64, 'base64'), zip);
  assert.equal(calls.filter(call => call.path === '/api/agent/threads').length, 1);
  assert.equal(calls.filter(call => call.path === '/api/roles/example/skills/example/download').length, 1);
});

test('normal multi-megabyte HTTP streams pause for consumption and finish with exact bytes', async t => {
  const { tools, calls } = await fixture(t);
  const opened = await tools.call('rabi_api_call', { operationId: 'fixture.large', options: { responseMode: 'stream' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  const chunks = [];
  let completed;
  for (let i = 0; i < 300; i++) {
    const read = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'read' });
    assert.equal(read.ok, true);
    chunks.push(...read.frames.map(frame => Buffer.from(frame.data, 'base64')));
    if (read.released) { completed = read; break; }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(completed.receipt.ok, true);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.alloc(65536, i))));
  assert.equal(calls.filter(call => call.path === '/fixture/large').length, 1);
});

test('a native-legal WebSocket frame larger than the queue high-water mark is consumed and close wakes its waiting successor', async t => {
  const { tools } = await fixture(t);
  const opened = await tools.call('rabi_api_call', { operationId: 'fixture.socket' });
  const large = { payload: 'x'.repeat(2 * 1024 * 1024) };
  await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'send', json: large });
  await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'send', json: { tail: true } });
  const first = await frames(tools, opened.sessionId);
  assert.equal(first.ok, true); assert.deepEqual(first.frames[0].data, large);
  const tail = await frames(tools, opened.sessionId);
  assert.deepEqual(tail.frames[0].data, { tail: true });
  await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'send', json: large });
  await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'send', json: { wait: true } });
  await new Promise(resolve => setTimeout(resolve, 30));
  const closed = await tools.call('rabi_api_session', { sessionId: opened.sessionId, action: 'close' });
  assert.equal(closed.state, 'closed');
});

test('real shared SSE and WebSocket sessions preserve frames and close without replay', async t => {
  const { tools, calls } = await fixture(t);
  const stream = await tools.call('rabi_api_call', { operationId: 'fixture.events' });
  const chunk = await frames(tools, stream.sessionId);
  assert.equal(Buffer.from(chunk.frames[0].data, 'base64').toString(), 'data: first\n\n');
  await tools.call('rabi_api_session', { sessionId: stream.sessionId, action: 'close' });
  const socket = await tools.call('rabi_api_call', { operationId: 'fixture.socket' });
  assert.equal(socket.state, 'open');
  await tools.call('rabi_api_session', { sessionId: socket.sessionId, action: 'send', json: { ping: 'original' } });
  const received = await frames(tools, socket.sessionId);
  assert.deepEqual(received.frames[0], { encoding: 'json', data: { ping: 'original' } });
  await tools.call('rabi_api_session', { sessionId: socket.sessionId, action: 'close' });
  assert.equal(calls.filter(call => call.path === '/fixture/events').length, 1);
});
