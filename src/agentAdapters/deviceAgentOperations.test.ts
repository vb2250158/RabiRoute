import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAgentOwner } from './deviceAgentOwner.js';
import { createDeviceAgentOperations } from './deviceAgentOperations.js';
import { ManagerPluginRouteRegistry } from '../manager/managerPluginRouteRegistry.js';

function temporary(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'device-agent-contract-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('device-agent-contract-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
async function serve(t: test.TestContext, current: () => ReturnType<typeof createDeviceAgentOwner>) {
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations('fixture-device-operations', createDeviceAgentOperations(current));
  const server = http.createServer((req, res) => { if (!registry.handle(req, new URL(req.url!, 'http://fixture.invalid'), res)) res.writeHead(404).end('{}'); });
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const raw = (suffix: string, method = 'GET', auth = 'device', body?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(base + '/api/device-agents' + suffix, { method, headers: { authorization: auth, 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (cause) { reject(cause); } });
    }); req.on('error', reject); req.end(body);
  });
  return { base, registry, registration, raw };
}
const principal = (req: http.IncomingMessage) => req.headers.authorization === 'device' ? { scope: 'scope-one', sourceDeviceId: 'device-one', deviceOwner: true }
  : req.headers.authorization === 'remote' ? { scope: 'scope-one', sourceDeviceId: 'application', deviceOwner: false } : null;

test('all thirteen executable device operations install together and ordinary connections read exact native session identities', async t => {
  const dataDir = temporary(t), owner = createDeviceAgentOwner({ dataDir, ownerInstanceId: 'owner-one', authorize: principal,
    authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => {} });
  const definitions = createDeviceAgentOperations(() => owner); assert.equal(definitions.length, 13); assert.equal(new Set(definitions.map(row => row.contract.operationId)).size, 13);
  assert.ok(definitions.every(row => row.contract.exposure === 'public'));
  const f = await serve(t, () => owner), sessionId = 'native-full-session-' + 'a'.repeat(140), name = 'Native named device session';
  const published = await f.raw('/device-one/session', 'PUT', 'device', JSON.stringify({ sessionId, name, loaded: true, capabilities: ['language-model', 'language-model'] }));
  assert.equal(published.status, 200); assert.equal(published.body.data.session.sessionId, sessionId); assert.equal(published.body.data.session.name, name);
  assert.deepEqual(published.body.data.session.capabilities, ['language-model']);
  const listed = await f.raw('', 'GET', 'remote'); assert.equal(listed.status, 200); assert.equal(listed.body.data.agents[0].sessionId, sessionId);
  const read = await f.raw('/device-one/session', 'GET', 'remote'); assert.equal(read.status, 200); assert.equal(read.body.data.session.sessionId, sessionId); assert.equal(read.body.data.session.name, name);
  const denied = await f.raw('/device-one/session', 'PUT', 'remote', JSON.stringify({ sessionId, name: 'Forged native owner', loaded: true, capabilities: [] }));
  assert.equal(denied.status, 403); assert.equal(owner.sessions('scope-one')[0].name, name);
});

test('device admission rejects an unauthorized incomplete body before decoding JSON', { timeout: 3000 }, async t => {
  const dataDir = temporary(t), owner = createDeviceAgentOwner({ dataDir, ownerInstanceId: 'owner-one', authorize: principal,
    authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => {} });
  const f = await serve(t, () => owner);
  const result = await new Promise<number>((resolve, reject) => {
    const req = http.request(f.base + '/api/device-agents/device-one/session', { method: 'PUT', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => { resolve(res.statusCode!); req.destroy(); });
    }); req.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    req.write('{'); // Deliberately never send EOF; admission must not wait for body parsing.
  });
  assert.equal(result, 401); assert.equal(fs.existsSync(path.join(dataDir, 'device-agent-owner')), false);
});

test('a body already admitted by the original device owner cannot switch to a replacement generation', { timeout: 5000 }, async t => {
  const dataDir = temporary(t); let generation = 1, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const create = (original: number) => createDeviceAgentOwner({ dataDir: path.join(dataDir, String(original)), ownerInstanceId: 'owner-' + original,
    assertCurrent: () => { if (generation !== original) throw Object.assign(new Error('changed'), { code: 'DEVICE_AGENT_OWNER_CHANGED', statusCode: 409 }); },
    authorize: req => { entered(); return principal(req); }, authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => {} });
  let current = create(1); const f = await serve(t, () => current);
  let req!: http.ClientRequest;
  const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
    req = http.request(f.base + '/api/device-agents/device-one/session', { method: 'PUT', headers: { authorization: 'device', 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (cause) { reject(cause); } });
    }); req.on('error', reject); req.write('{"sessionId":');
  });
  await ready; generation = 2; current = create(2);
  req.end('"original-session","name":"Original native session","loaded":true,"capabilities":[]}');
  const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.code, 'DEVICE_AGENT_OWNER_CHANGED');
  assert.equal(fs.existsSync(path.join(dataDir, '1', 'device-agent-owner')), false); assert.equal(fs.existsSync(path.join(dataDir, '2', 'device-agent-owner')), false);
});

test('disconnect cancels native long-poll timers before operation registration retirement', { timeout: 4000 }, async t => {
  const dataDir = temporary(t); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = createDeviceAgentOwner({ dataDir, ownerInstanceId: 'owner-one', authorize: principal,
    authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => { entered(); } });
  const f = await serve(t, () => owner);
  const req = http.request(f.base + '/api/device-agents/device-one/pending?waitMs=12000', { headers: { authorization: 'device' } });
  req.on('error', () => {}); req.end(); await ready;
  assert.equal(f.registration.activeOperationCount(), 1); req.destroy();
  await f.registration.dispose(); assert.equal(f.registration.activeOperationCount(), 0);
  // A new request is no longer admitted after retiring the original operation owner.
  assert.equal((await f.raw('/device-one/session')).status, 404);
});

test('an owner generation change after durable session publication reports uncertain without writing to its replacement', async t => {
  const dataDir = temporary(t); let currentGeneration = 1;
  const owner = createDeviceAgentOwner({ dataDir, ownerInstanceId: 'owner-one', authorize: principal,
    assertCurrent: () => { if (currentGeneration !== 1) throw Object.assign(new Error('changed'), { code: 'DEVICE_AGENT_OWNER_CHANGED', statusCode: 409 }); },
    authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => {} });
  const release = owner.onChange(() => { currentGeneration = 2; }); t.after(release);
  const f = await serve(t, () => owner);
  const reply = await f.raw('/device-one/session', 'PUT', 'device', JSON.stringify({ sessionId: 'original-session', name: 'Original', loaded: true, capabilities: [] }));
  assert.equal(reply.status, 409); assert.equal(reply.body.code, 'DEVICE_AGENT_OWNER_CHANGED'); assert.equal(reply.body.uncertain, true);
  assert.equal(owner.sessions('scope-one')[0].sessionId, 'original-session');
  const stored = fs.readdirSync(path.join(dataDir, 'device-agent-owner'));
  assert.equal(stored.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'device-agent-owner', stored[0]), 'utf8')).agents['device-one'].session.name, 'Original');
});

test('an invalid receipt wait query terminates at the native zero-wait boundary instead of spinning', { timeout: 3000 }, async t => {
  const dataDir = temporary(t), owner = createDeviceAgentOwner({ dataDir, ownerInstanceId: 'owner-one', authorize: principal,
    authorizeDelivery: async req => principal(req), assertDeviceAssignment: async () => {} });
  const f = await serve(t, () => owner), deliveryId = 'queued-without-owner';
  const enqueue = await f.raw('/device-one/deliveries', 'POST', 'remote', JSON.stringify({ deliveryId, envelope: { deliveryId,
    messageSource: { type: 'system', eventType: 'fixture', eventName: 'Fixture', eventId: deliveryId }, messageContent: 'Synthetic queued input' } }));
  assert.equal(enqueue.status, 202);
  const receipt = await f.raw('/device-one/deliveries/' + deliveryId + '?waitMs=invalid', 'GET', 'remote');
  assert.equal(receipt.status, 200); assert.equal(receipt.body.data.receipt.status, 'queued'); assert.equal(receipt.body.data.receipt.ownerAccepted, false);
});
