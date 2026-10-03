import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

test('real Relay retired grant APIs cannot alter current connected-app knowledge access', { timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-http-'));
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
    const account = await req('/manage/api/accounts', 'POST', { username: 'knowledge-owner', password: 'test-only-safe-password' });
    const created = await req('/manage/api/apps', 'POST', { name: 'fixture' }, { cookie: account.cookie });
    const app = created.data.app;
    const other = await req('/manage/api/accounts', 'POST', { username: 'knowledge-other', password: 'test-only-safe-password' });
    const file = path.join(directory, 'apps.json');
    const store = JSON.parse(fs.readFileSync(file));
    const oldHistory = { revision: 1, grant: { allowedRoles: [], allowedTools: [], allowWrites: false }, operations: [] };
    store.apps[0].deviceBindings = [{ id: 'glass', serialHash: 'fixture', credentialHash: createHash('sha256').update('rbd_fixture').digest('hex'), knowledgeGrantState: oldHistory }];
    fs.writeFileSync(file, JSON.stringify(store));
    const endpoint = `/manage/api/apps/${app.id}/devices/glass/knowledge-grant`;
    const ownerHeaders = { cookie: account.cookie, 'x-rabilink-profile-write': '1', origin: base };
    assert.equal((await req(endpoint)).status, 401);
    for (const route of [endpoint, endpoint + '/operations/old-key']) {
      assert.equal((await req(route, 'GET', undefined, { cookie: other.cookie })).status, 404);
      const retired = await req(route, 'GET', undefined, ownerHeaders);
      assert.equal(retired.status, 410); assert.equal(retired.data.code, 'KNOWLEDGE_GRANTS_RETIRED');
    }
    assert.equal((await req(endpoint, 'PUT', { grant: { allowWrites: true } }, ownerHeaders)).status, 410);
    const own = '/api/rabilink/device/knowledge';
    const deviceHeaders = { 'x-rabilink-token': 'rbd_fixture' };
    assert.equal((await req(own, 'POST', { operation: 'list' }, { 'x-rabilink-token': app.token })).status, 403);
    assert.equal((await req(own, 'POST', { operation: 'list' }, deviceHeaders)).status, 409);
    const saved = JSON.parse(fs.readFileSync(file)); saved.apps[0].targetDeviceId = 'fixture-pc'; fs.writeFileSync(file, JSON.stringify(saved));
    const workerHeaders = { 'x-rabilink-token': app.token };
    const workerQuery = '/worker/webgui-requests?deviceId=fixture-pc&deviceGuid=fixture-guid&deviceName=Fixture&deviceKind=pc&waitMs=0&capabilities=webgui,knowledgebridge';
    assert.equal((await req(workerQuery, 'GET', undefined, workerHeaders)).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).apps[0].deviceBindings[0].knowledgeGrantState, oldHistory);
    assert.equal((await req(own, 'POST', { operation: 'list', knowledge: { appId: 'forged' } }, deviceHeaders)).status, 400);

    async function complete(body, result) {
      const pending = req(own, 'POST', body, deviceHeaders);
      const claim = await req(workerQuery.replace('waitMs=0', 'waitMs=1000'), 'GET', undefined, workerHeaders);
      const queued = claim.data.requests[0]; assert.ok(queued);
      assert.deepEqual(queued.knowledge, { appId: app.id, deviceBindingId: 'glass', ownerAccountId: saved.apps[0].ownerAccountId, targetDeviceId: 'fixture-pc' });
      assert.equal('grant' in queued.knowledge, false);
      assert.equal(queued.nonReplayable, body.operation === 'call');
      const finished = await req(`/worker/webgui-requests/${encodeURIComponent(queued.id)}/response`, 'POST', {
        ok: true, statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(JSON.stringify(result)).toString('base64'), deviceId: 'fixture-pc', deviceGuid: 'fixture-guid'
      }, workerHeaders);
      assert.equal(finished.status, 200);
      return pending;
    }
    const listed = await complete({ operation: 'list' }, { tools: [{ name: 'plan_list' }], allowedRoles: ['example'], allowWrites: true });
    assert.equal(listed.status, 200);
    const writeKey = 'connected-write';
    const receipt = { ok: true, statusCode: 201, uncertain: false, commitState: 'committed', idempotencyKey: writeKey, etag: '"v1"', data: { id: 'fixture-memory' } };
    const mutation = { operation: 'call', name: 'recent_memory_create', args: { roleId: 'example', idempotencyKey: writeKey, body: { title: 'Fixture', focus: 'fixture', keywords: ['test'], content: 'Synthetic fixture' } } };
    const written = await complete(mutation, { structuredContent: receipt }); assert.equal(written.status, 200);
    const recovered = await req(own + '/operations/' + writeKey, 'GET', undefined, deviceHeaders);
    assert.equal(recovered.data.data.state, 'confirmed'); assert.deepEqual(recovered.data.data.receipt, receipt);
    assert.equal((await req(own, 'POST', mutation, deviceHeaders)).status, 409);
    const page = await fetch(base + '/manage'); assert.equal((await page.text()).includes('knowledge-grant-editor'), false);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
