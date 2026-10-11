import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { requestRabiLinkManagerFixture, startRabiLinkOwnerFixture } from './rabilink-owner-fixture.mjs';

test('profile lives only on PC through generic HTTP; retired Relay aliases cannot read or write it', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-profile-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = 'http://127.0.0.1:' + port, token = 'synthetic-profile-token', deviceToken = 'rbd_synthetic';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const file = path.join(directory, 'apps.json');
  fs.writeFileSync(file, JSON.stringify({ accounts: [], apps: [{ id: 'profile-app', enabled: true, token, targetDeviceId: 'pc-test', connectionOwnerDeviceId: 'pc-test', ownerAccountId: 'owner',
    deviceBindings: [{ id: 'glasses', enabled: true, serialHash: hash('synthetic-serial'), credentialHash: hash(deviceToken), connectionTargetDeviceId: 'pc-test' }] }], workers: [] }));
  const child = spawn(process.execPath, [path.resolve('scripts/rabilink-relay-server.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RABILINK_RELAY_DATA_DIR: directory }, windowsHide: true, stdio: 'ignore' });
  let owner;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 30)); }
    owner = await startRabiLinkOwnerFixture({ relayBaseUrl: base, token, appId: 'profile-app', directory: path.join(directory, 'pc-owner') });
    const call = (route, options = {}, credential = token) => requestRabiLinkManagerFixture(base, 'pc-test', credential, route, options);
    const route = '/api/rabilink/agent-devices/glasses/profile';
    const profile = { revision: 1, id: 'Fixture', name: 'Fixture', systemPrompt: 'Synthetic persona', skills: [], mcp: [], personaRef: { roleId: 'Fixture', sourceDeviceId: 'pc-test' } };
    const input = { expectedRevision: 0, idempotencyKey: 'profile-original', profile };
    assert.equal((await call(route, { method: 'PUT', body: input, headers: { 'idempotency-key': 'profile-original' } })).response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file)).apps[0].deviceBindings[0].agentProfileState, undefined);
    assert.deepEqual((await call('/api/rabilink/agent-devices/self/profile', {}, deviceToken)).body.data.profile, profile);
    const ack = { idempotencyKey: 'ack-original', appliedRevision: 1, status: 'applied' };
    assert.equal((await call(route + '/receipt', { method: 'POST', body: ack })).response.status, 403);
    assert.equal((await call('/api/rabilink/agent-devices/self/profile/receipt', { method: 'POST', body: ack }, deviceToken)).response.status, 200);
    await owner.stop(); owner = await startRabiLinkOwnerFixture({ relayBaseUrl: base, token, appId: 'profile-app', directory: path.join(directory, 'pc-owner') });
    assert.equal((await call(route)).body.data.savedRevision, 1);
    assert.equal((await call(route + '/operations/profile-original')).body.data.receipt.savedRevision, 1);
    for (const legacy of ['/api/rabilink/device/agent-profile', '/api/rabilink/device/agent-profile/applied', '/api/rabilink/device/knowledge'])
      assert.equal((await fetch(base + legacy, { headers: { 'x-rabilink-token': deviceToken } })).status, 404);
    assert.equal((await fetch(base + '/api/rabilink/mobile/aiui-devices', { headers: { 'x-rabilink-token': token } })).status, 410);
  } finally { if (owner) await owner.stop(); child.kill(); await once(child, 'exit'); fs.rmSync(directory, { recursive: true, force: true }); }
});
