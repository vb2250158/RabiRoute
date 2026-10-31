import { createHash } from "node:crypto";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRabiLinkMobileOwner } from './rabiLinkMobileOwner.js';
import { createRabiLinkMobileOperations } from './rabiLinkMobileOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';

test('PC mobile owner persists native state and original receipts without Relay business state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-mobile-owner-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('rabi-mobile-owner-')); fs.rmSync(directory, { recursive: true, force: true }); });
  let allowed = true, ownerTarget = 'pc-owner';
  const module = createRabiLinkMobileOwner({ dataDir: directory, sourceDeviceId: 'pc-owner',
    authorize: () => allowed ? { scope: 'synthetic-scope', sourceDeviceId: 'phone' } : null,
    applicationOwnerTarget: async () => ownerTarget,
    peers: async () => [{ id: 'asr-one', online: true, capabilities: ['asr'] }, { id: 'asr-two', online: false, capabilities: ['asr'] }]
  });
  const routes = new ManagerPluginRouteRegistry();
  const registration = routes.registerOperations('fixture-mobile', createRabiLinkMobileOperations(() => module));
  t.after(() => registration.dispose());
  const server = http.createServer((req, res) => { if (!routes.handle(req, new URL(req.url || '/', 'http://fixture'), res)) res.writeHead(404).end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  async function call(suffix: string, method = 'GET', body?: unknown, key?: string) {
    const reply = await fetch(base + '/api/rabilink/mobile/' + suffix, { method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: reply.status, body: await reply.json() };
  }
  assert.deepEqual((await call('asr-settings')).body.priority, []);
  const changed = await call('asr-settings', 'PATCH', { priority: ['asr-one'] }, 'asr-change'); assert.equal(changed.status, 200);
  await call('asr-settings', 'PATCH', { priority: ['asr-two'] }, 'asr-other');
  assert.deepEqual((await call('asr-settings', 'PATCH', { priority: ['asr-one'] }, 'asr-change')).body.priority, ['asr-one']);
  assert.equal((await call('asr-settings', 'PATCH', { priority: ['asr-two'] }, 'asr-change')).status, 409);
  assert.equal((await call('asr-settings', 'PATCH', { priority: ['unknown'] }, 'asr-invalid')).status, 400);
  const proof = { event: 'fixture', detail: 'Synthetic proof' };
  const one = await call('proof', 'POST', proof, 'proof-one'), two = await call('proof', 'POST', proof, 'proof-one');
  assert.equal(one.body.proof.id, two.body.proof.id);
  assert.equal((await call('proofs')).body.proofs.length, 1);
  assert.equal((await call('device-status', 'POST', { batteryLevel: 53, charging: false }, 'status-one')).body.deviceStatus.batteryLevel, 53);
  assert.equal((await call('device-status')).body.deviceStatus.stale, false);
  assert.equal((await fetch(base + '/api/rabilink/mobile/routes')).status, 404);
  assert.equal((await call('proof', 'POST', proof)).status, 400);
  const storeFile = path.join(directory, 'rabilink-mobile-owner', createHash('sha256').update('synthetic-scope').digest('hex') + '.json');
  const damaged = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  damaged.proofs.push({ id: 'broken-proof', detail: 123 });
  damaged.operations.push({ key: 'broken-operation', fingerprint: 'bad', result: null });
  damaged.deviceStatus = { batteryLevel: 'bad', retainedEvidence: 'original' };
  fs.writeFileSync(storeFile, JSON.stringify(damaged));
  const partial = await call('proofs');
  assert.equal(partial.status, 200); assert.equal(partial.body.proofs.length, 1); assert.equal(partial.body.invalidRecords, 1);
  assert.equal((await call('device-status')).status, 503);
  assert.equal((await call('device-status', 'POST', { batteryLevel: 53, charging: false }, 'status-one')).body.deviceStatus.batteryLevel, 53);
  assert.equal((await call('device-status', 'POST', { batteryLevel: 53, charging: false }, 'status-new')).status, 503);
  assert.equal((await call('asr-settings')).status, 200);
  assert.equal((await call('proof', 'POST', proof, 'broken-operation')).status, 503);
  assert.equal((await call('proof', 'POST', { event: 'healthy' }, 'healthy-new')).status, 200);
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.deepEqual(after.proofs[1], damaged.proofs[1]);
  assert.deepEqual(after.deviceStatus, damaged.deviceStatus);
  assert.deepEqual(after.operations.find((item: { key: string }) => item.key === 'broken-operation'), damaged.operations.at(-1));
  after.operations.push(null); fs.writeFileSync(storeFile, JSON.stringify(after));
  assert.equal((await call('asr-settings')).status, 200);
  assert.equal((await call('proof', 'POST', proof, 'proof-one')).body.proof.id, one.body.proof.id);
  assert.equal((await call('proof', 'POST', proof, 'unknown-new')).status, 503);

  ownerTarget = 'other-pc'; assert.equal((await call('asr-settings')).status, 409);
  allowed = false; assert.equal((await call('proofs')).status, 401);
});
