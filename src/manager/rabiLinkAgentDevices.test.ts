import { createHash } from "node:crypto";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRabiLinkAgentDevices } from './rabiLinkAgentDevices.js';
import { createRabiLinkAgentDeviceOperations } from './rabiLinkAgentDeviceOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';

test('PC owns scoped profile CAS, signed self receipts, source validation and restart-safe operations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-pc-profile-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const make = () => createRabiLinkAgentDevices({ dataDir: directory, sourceDeviceId: 'pc-owner',
    deviceOwnerTarget: async id => id === 'other-owner-device' ? 'other-pc' : 'pc-owner',
    authorize: req => req.headers['x-test-auth'] === '1' ? { scope: String(req.headers['x-test-scope'] || 'app-one'), sourceDeviceId: String(req.headers['x-test-device'] || 'glasses-one'), deviceOwner: req.headers['x-test-admin'] !== '1' } : null,
    readLocal: async pathname => pathname === '/api/personas' ? { personas: [{ personaId: 'Local' }] } : {},
    readTarget: async (id, pathname) => { assert.equal(id, 'pc-persona'); assert.equal(pathname, '/api/personas'); return { personas: [{ personaId: 'Remote' }] }; }
  });
  let owner = make();
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('fixture-profiles', createRabiLinkAgentDeviceOperations(() => owner));
  const server = http.createServer(async (req, res) => {
    if (!registry.handle(req, new URL(req.url || '/', 'http://fixture'), res)) res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const url = '/api/rabilink/agent-devices/self/profile';
  async function call(route: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-test-auth': '1' }) {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await call(url, 'GET', undefined, {})).status, 401);
  assert.equal((await call(url)).body.data.savedRevision, 0);
  const profile = { revision: 1, id: 'Remote', name: 'Remote', systemPrompt: 'Fixture', skills: [], mcp: [], personaRef: { roleId: 'Remote', sourceDeviceId: 'pc-persona' } };
  const write = { expectedRevision: 0, idempotencyKey: 'profile-one', profile };
  assert.equal((await call(url, 'PUT', write)).body.data.savedRevision, 1);
  owner = make();
  assert.deepEqual((await call(url)).body.data.profile, profile);
  assert.equal((await call(url, 'PUT', write)).status, 200);
  assert.equal((await call(url, 'PUT', { ...write, profile: { ...profile, name: 'changed' } })).body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await call(url, 'PUT', { expectedRevision: 0, idempotencyKey: 'new-key', profile })).status, 412);
  const ack = { idempotencyKey: 'applied-one', appliedRevision: 1, status: 'applied' };
  assert.equal((await call(url + '/receipt', 'POST', ack)).status, 200);
  assert.equal((await call('/api/rabilink/agent-devices/glasses-one/profile/receipt', 'POST', ack, { 'x-test-auth': '1', 'x-test-device': 'phone' })).status, 403);
  assert.equal((await call(url + '/receipt', 'POST', ack, { 'x-test-auth': '1', 'x-test-admin': '1' })).status, 403);
  assert.equal((await call(url, 'GET', undefined, { 'x-test-auth': '1', 'x-test-scope': 'other-app' })).body.data.savedRevision, 0);
  assert.equal((await call(url + '/operations/profile-one')).body.data.receipt.savedRevision, 1);
  const listed = (await call('/api/rabilink/agent-devices')).body.data;
  assert.equal(listed.sourceDeviceId, 'pc-owner'); assert.equal(listed.devices[0].id, 'glasses-one');
  assert.equal(listed.devices[0].historyPersonas[0].sourceDeviceId, 'pc-persona');
  const storeFile = path.join(directory, 'rabilink-agent-devices', createHash('sha256').update('app-one').digest('hex') + '.json');
  const damaged = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  damaged.devices['bad-device'] = { profile: null, retainedEvidence: 'original' };
  fs.writeFileSync(storeFile, JSON.stringify(damaged));
  const partial = await call('/api/rabilink/agent-devices');
  assert.equal(partial.status, 200); assert.equal(partial.body.data.devices.length, 1);
  assert.deepEqual(partial.body.data.coverage.invalidDeviceIds, ['bad-device']);
  assert.equal((await call('/api/rabilink/agent-devices/bad-device/profile')).status, 503);
  assert.equal((await call('/api/rabilink/agent-devices/bad-device/profile', 'PUT', write)).status, 503);
  assert.equal((await call(url + '/receipt', 'POST', { ...ack, idempotencyKey: 'still-healthy' })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).devices['bad-device'], damaged.devices['bad-device']);

  assert.equal((await call(url, 'PUT', { expectedRevision: 1, idempotencyKey: 'invalid-source', profile: { ...profile, revision: 2, personaRef: { roleId: 'Missing', sourceDeviceId: 'pc-persona' } } })).status, 404);
  assert.equal((await call('/api/rabilink/agent-devices/other-owner-device/profile', 'PUT', write)).status, 409);
});
