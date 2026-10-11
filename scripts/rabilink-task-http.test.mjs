import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { requestRabiLinkManagerFixture, startRabiLinkOwnerFixture } from './rabilink-owner-fixture.mjs';

test('Relay transports wearable input unchanged and PC owns capabilities, policy and observation semantics', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opaque-task-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = 'http://127.0.0.1:' + port, token = 'synthetic-task-token', headers = { 'x-rabilink-token': token, 'content-type': 'application/json' };
  fs.writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({ accounts: [], apps: [{ id: 'task-app', enabled: true, token, targetDeviceId: 'pc-test', ownerAccountId: 'owner' }], workers: [] }));
  const child = spawn(process.execPath, [path.resolve('scripts/rabilink-relay-server.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RABILINK_RELAY_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
  let owner;
  async function call(route, method = 'GET', body, extra = {}) { const response = await fetch(base + route, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; }
  try {
    for (let index = 0; index < 100; index++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 30)); }
    owner = await startRabiLinkOwnerFixture({ relayBaseUrl: base, token, appId: 'task-app', directory: path.join(directory, 'pc-owner') });
    const capability = await requestRabiLinkManagerFixture(base, 'pc-test', token, '/api/rabilink/devices/health-capabilities');
    assert.equal(capability.response.status, 200); assert.equal(capability.body.rabilinkWearableObservation.processingPolicyFrozen, true);
    const raw = { id: 'forged-task', health: { samples: [{ metric: 'heart-rate', bpm: 83, metadata: { futureSensorField: 'preserved' } }] }, processingPolicy: 'agent', routeProfileId: 'route', deviceId: 'watch', futureExtension: { version: 9 } };
    const accepted = await call('/api/rabilink/devices/input', 'POST', raw, { 'x-rabilink-expected-worker-id': 'pc-test' });
    assert.equal(accepted.status, 202);
    assert.equal((await call('/worker/tasks?deviceId=pc-test&waitMs=1')).status, 426);
    const claim = await call('/worker/tasks?deviceId=pc-test&deviceGuid=guid-test&waitMs=1&taskFormat=opaque-v1');
    const task = claim.body.tasks[0]; assert.equal(task.id, accepted.body.eventId); assert.deepEqual(task.raw, raw); assert.equal(Object.hasOwn(task, 'health'), false); assert.equal(task.expectedWorkerFencing, true);
    const normalized = await owner.normalize(task); assert.equal(normalized.type, 'wearable.health'); assert.equal(normalized.id, task.id); assert.deepEqual(normalized.health, raw.health);
    const wrongTarget = await call('/api/rabilink/devices/input', 'POST', raw, { 'x-rabilink-expected-worker-id': 'other' }); assert.equal(wrongTarget.status, 409);
    const missingPolicy = await call('/api/rabilink/devices/input', 'POST', { ...raw, processingPolicy: '' }); assert.equal(missingPolicy.status, 202);
    const missing = (await call('/worker/tasks?deviceId=pc-test&waitMs=1&taskFormat=opaque-v1')).body.tasks[0];
    await assert.rejects(owner.normalize(missing), /FENCE_REQUIRED/);
  } finally { if (owner) await owner.stop(); child.kill(); await once(child, 'exit'); fs.rmSync(directory, { recursive: true, force: true }); }
});
