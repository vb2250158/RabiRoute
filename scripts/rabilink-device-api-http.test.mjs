import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

test('Relay generic transport pins explicit PC and forwards future APIs without reading profile business', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiui-api-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve('scripts/rabilink-relay-server.mjs')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RABILINK_RELAY_DATA_DIR: directory, RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS: '5000' },
    stdio: 'ignore', windowsHide: true
  });
  async function req(route, method = 'GET', body, headers = {}) {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const account = await req('/manage/api/accounts', 'POST', { username: 'aiui-fixture-owner', password: createHash('sha256').update(directory).digest('hex') });
    const app = (await req('/manage/api/apps', 'POST', { name: 'fixture' }, { cookie: account.cookie })).data.app;
    const file = path.join(directory, 'apps.json');
    const store = JSON.parse(fs.readFileSync(file)); store.apps[0].targetDeviceId = 'pc-default'; store.privateExtension = { retained: true };
    const hash = value => createHash('sha256').update(value).digest('hex');
    store.apps[0].deviceBindings = ['one', 'two'].map(id => ({ id, serialHash: hash(id), credentialHash: hash('rbd_' + id), enabled: true, connectionTargetDeviceId: 'pc-default', customExtension: ['retained'] }));
    fs.writeFileSync(file, JSON.stringify(store));
    const profile = (revision, roleId, sourceDeviceId) => ({ revision, id: roleId, name: roleId, systemPrompt: 'Synthetic persona', skills: [], mcp: [], personaRef: { roleId, sourceDeviceId } });
    for (const binding of store.apps[0].deviceBindings) binding.obsoleteProfile = profile(1, 'PersonaOne', 'pc-persona');
    fs.writeFileSync(file, JSON.stringify(store));
    const workerHeaders = { 'x-rabilink-token': app.token };
    const deviceHeaders = id => ({ 'x-rabilink-token': 'rbd_' + id });
    const workerQuery = (pc, wait = 0) => `/worker/webgui-requests?deviceId=${pc}&deviceGuid=guid-${pc}&deviceName=Fixture&deviceKind=pc&waitMs=${wait}&capabilities=webgui`;
    for (const pc of ['pc-default', 'pc-persona']) assert.equal((await req(workerQuery(pc), 'GET', undefined, workerHeaders)).status, 200);
    const connection = '/api/rabilink/mobile/connection';
    assert.equal((await req(connection, 'PATCH', { connectionOwnerDeviceId: 'missing' }, workerHeaders)).status, 409);
    assert.equal((await req(connection, 'PATCH', { connectionOwnerDeviceId: 'pc-persona' }, deviceHeaders('one'))).status, 403);
    assert.equal((await req(connection, 'PATCH', { connectionOwnerDeviceId: 'pc-persona' }, workerHeaders)).status, 200);
    assert.equal((await req(connection, 'PATCH', { connectionOwnerDeviceId: 'pc-default' }, workerHeaders)).status, 409);
    assert.equal((await req('/api/rabilink/mobile/state', 'GET', undefined, workerHeaders)).data.connectionOwnerDeviceId, 'pc-persona');
    const persisted = JSON.parse(fs.readFileSync(file)); assert.deepEqual(persisted.privateExtension, { retained: true }); assert.deepEqual(persisted.apps[0].deviceBindings[0].customExtension, ['retained']);
    async function complete(route, body, pc, result, id = 'one', responseHeaders = {}, responseStatus = 200) {
      const began = Date.now();
      const pending = req(route, 'POST', body, deviceHeaders(id));
      const claim = await req(workerQuery(pc, 1000), 'GET', undefined, workerHeaders);
      const queued = claim.data.requests[0]; assert.ok(queued, JSON.stringify(claim.data));
      assert.equal(queued.targetDeviceId, pc); assert.equal(queued.connectionIdentity.deviceId, id); assert.equal(queued.connectionIdentity.appId, app.id);
      assert.ok(Number.isSafeInteger(queued.connectionIdentity.authenticatedAt));
      assert.ok(queued.connectionIdentity.authenticatedAt >= began && queued.connectionIdentity.authenticatedAt <= Date.now());
      assert.equal((await req(workerQuery(pc === 'pc-persona' ? 'pc-default' : 'pc-persona'), 'GET', undefined, workerHeaders)).data.requests.length, 0);
      const finished = await req(`/worker/webgui-requests/${encodeURIComponent(queued.id)}/response`, 'POST', {
        ok: true, statusCode: responseStatus, headers: { 'content-type': 'application/json', ...responseHeaders }, bodyBase64: (Buffer.isBuffer(result) ? result : Buffer.from(JSON.stringify(result))).toString('base64'), deviceId: pc, deviceGuid: 'guid-' + pc
      }, workerHeaders);
      assert.equal(finished.status, 200);
      return { response: await pending, queued };
    }
    const api = '/api/rabilink/device/api';
    const businessHeaders = { 'x-rabiroute-future-contract': 'v2', 'x-token-count': '42', 'x-secret-version': 'v3', 'x-api-key-count': '2' };
    const read = await complete(api, { request: { method: 'GET', path: '/api/future-capability?roleId=OtherPersona', headers: businessHeaders }, targetDeviceId: 'pc-persona' }, 'pc-persona', { future: true }, 'one', { ...businessHeaders, 'x-rabilink-internal-hop': 'private-proof', 'x-rabiroute-host-token': 'private-control', 'set-cookie': 'private-session' });
    assert.equal(read.response.status, 200); assert.deepEqual(read.response.data.data.structuredContent.data, { future: true });
    assert.notEqual(read.queued.nonReplayable, true); assert.equal(read.queued.publicApiTransport, true); assert.equal(read.queued.headers['x-rabiroute-future-contract'], 'v2');
    for (const [name, value] of Object.entries(businessHeaders)) {
      assert.equal(read.queued.headers[name], value);
      assert.equal(read.response.data.data.structuredContent.headers[name], value);
    }
    for (const name of ['x-rabilink-internal-hop', 'x-rabiroute-host-token', 'set-cookie']) assert.equal(read.response.data.data.structuredContent.headers[name], undefined);
    const binary = Buffer.from([0, 255, 128, 10, 1]);
    const binaryReply = await complete(api, { targetDeviceId: 'pc-persona', request: { method: 'POST', path: '/api/future-binary?format=opaque', operationId: 'binary-original', headers: { ...businessHeaders, 'content-type': 'application/octet-stream' }, bodyBase64: binary.toString('base64') } }, 'pc-persona', binary, 'one', { ...businessHeaders, 'content-type': 'application/octet-stream' }, 206);
    assert.equal(binaryReply.queued.bodyBase64, binary.toString('base64'));
    assert.equal(binaryReply.response.data.data.structuredContent.statusCode, 206);
    assert.deepEqual(binaryReply.response.data.data.structuredContent.data, { bodyBase64: binary.toString('base64'), contentType: 'application/octet-stream' });
    assert.equal(binaryReply.response.data.data.structuredContent.headers['x-token-count'], '42');
    const mutation = { request: { method: 'PATCH', path: '/api/future-capability', body: { target: 'OtherPersona' }, operationId: 'stable-write', headers: { 'if-match': '"v1"' } }, targetDeviceId: 'pc-persona' };
    const write = await complete(api, mutation, 'pc-persona', { committed: true });
    assert.equal(write.queued.nonReplayable, true); assert.equal(write.queued.headers['idempotency-key'], 'stable-write');
    assert.equal((await req(api, 'POST', mutation, deviceHeaders('one'))).data.data.structuredContent.code, 'API_READBACK_REQUIRED');
    assert.equal((await req(workerQuery('pc-persona'), 'GET', undefined, workerHeaders)).data.requests.length, 0);
    assert.equal((await req(api, 'POST', { ...mutation, request: { ...mutation.request, body: { changed: true } } }, deviceHeaders('one'))).data.code, 'API_OPERATION_CONFLICT');
    // An identical in-flight request shares the original authorization and queue identity.
    const original = { request: { method: 'POST', path: '/api/rabilink/peer/device-bootstrap', operationId: 'auth-clock-original', body: { expiresAt: Date.now() + 45000 } }, targetDeviceId: 'pc-persona' };
    const authBefore = Date.now();
    const first = req(api, 'POST', original, deviceHeaders('one'));
    const originalClaim = (await req(workerQuery('pc-persona', 1000), 'GET', undefined, workerHeaders)).data.requests[0];
    assert.ok(originalClaim); const originalAuth = originalClaim.connectionIdentity.authenticatedAt;
    assert.ok(originalAuth >= authBefore && originalAuth <= Date.now());
    await new Promise(resolve => setTimeout(resolve, 75));
    const retried = req(api, 'POST', original, deviceHeaders('one'));
    assert.equal((await req(workerQuery('pc-persona'), 'GET', undefined, workerHeaders)).data.requests.length, 0);
    const authAfterRetry = Date.now(); assert.ok(authAfterRetry > originalAuth);
    assert.equal((await req(`/worker/webgui-requests/${encodeURIComponent(originalClaim.id)}/response`, 'POST', {
      ok: true, statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(JSON.stringify({ authenticatedAt: originalAuth })).toString('base64'), deviceId: 'pc-persona', deviceGuid: 'guid-pc-persona'
    }, workerHeaders)).status, 200);
    for (const response of await Promise.all([first, retried])) {
      assert.equal(response.status, 200); assert.equal(response.data.data.structuredContent.data.authenticatedAt, originalAuth);
    }
    assert.equal(originalClaim.connectionIdentity.authenticatedAt, originalAuth);
    for (const name of ['authorization', 'cookie', 'x-rabiroute-webgui-token', 'x-rabiroute-host-token', 'x-remote-agent-token', 'x-rabilink-internal-hop', 'x-rabilink-tunnel-device-id', 'x-rabiroute-peer-proxy', 'x-rabiroute-relay-proxy']) {
      assert.equal((await req(api, 'POST', { request: { method: 'GET', path: '/api/future', headers: { [name]: 'forged' } } }, deviceHeaders('one'))).status, 400, name);
    }
    assert.equal((await req(api, 'POST', { request: { method: 'GET', path: '/api/future' } }, deviceHeaders('missing'))).status, 401);
    // Legacy profile snapshots are deliberately irrelevant to routing.
    const changed = JSON.parse(fs.readFileSync(file)); changed.apps[0].deviceBindings[0].obsoleteProfile = profile(2, 'PersonaTwo', 'pc-default'); fs.writeFileSync(file, JSON.stringify(changed));
    await complete(api, { request: { method: 'GET', path: '/meta' }, targetDeviceId: 'pc-persona' }, 'pc-persona', { generation: 'frozen-pc' });
    await complete(api, { request: { method: 'GET', path: '/meta' }, targetDeviceId: 'pc-default' }, 'pc-default', { generation: 'explicit-pc' });
    await complete(api, { request: { method: 'GET', path: '/api/future' } }, 'pc-default', { unbound: true });
    const businessFailure = await complete(api, { request: { method: 'GET', path: '/api/future-error' }, targetDeviceId: 'pc-persona' }, 'pc-persona', { code: 'PC_DOMAIN_ERROR', ok: false });
    assert.equal(businessFailure.response.data.data.structuredContent.ok, true);
    assert.deepEqual(businessFailure.response.data.data.structuredContent.data, { code: 'PC_DOMAIN_ERROR', ok: false });
    assert.equal((await req(api, 'POST', { request: { method: 'GET', path: '/meta' }, profileRevision: 1 }, deviceHeaders('one'))).status, 400);
    assert.equal((await req('/api/rabilink/mobile/aiui-devices', 'GET', undefined, workerHeaders)).status, 410);
    assert.equal((await req('/api/rabilink/device/aiui-conversation', 'POST', {}, deviceHeaders('one'))).status, 404);
    const roster = await req('/api/rabilink/devices/connections', 'GET', undefined, deviceHeaders('one'));
    assert.equal(roster.data.data.connectionOwnerDeviceId, 'pc-persona');
    assert.deepEqual(roster.data.data.devices.map(item => item.id), ['one']);
    assert.equal(roster.data.data.devices[0].connectionTargetDeviceId, 'pc-default');
    assert.equal(Object.hasOwn(roster.data.data.devices[0], 'profile'), false);
    assert.equal((await req('/api/rabilink/devices/connections', 'GET', undefined, workerHeaders)).data.data.devices.length, 2);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
