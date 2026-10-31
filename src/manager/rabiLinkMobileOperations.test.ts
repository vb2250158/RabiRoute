import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { createRabiLinkMobileOwner, MOBILE_OWNER_LIMITS } from './rabiLinkMobileOwner.js';
import { createRabiLinkMobileOperations } from './rabiLinkMobileOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { setTrustedLanAgentSource, registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { rabiLinkAgentDevicePrincipal } from './rabiLinkAgentDeviceConnection.js';

function temporary(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-mobile-contract-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('rabilink-mobile-contract-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const request = (key = 'operation-one') => { const value = new http.IncomingMessage(new Socket()); value.headers = { 'idempotency-key': key, 'user-agent': 'Fixture' }; return value; };

test('native mobile receipts survive owner recreation, retain original status/proof and isolate scopes', async t => {
  const dataDir = temporary(t); let scope = 'scope-one';
  const options = { dataDir, sourceDeviceId: 'pc-owner', authorize: () => ({ scope, sourceDeviceId: 'phone', deviceOwner: true }), applicationOwnerTarget: async () => 'pc-owner',
    peers: async () => [{ id: 'pc-owner', online: true, capabilities: ['asr'] }] };
  const owner = createRabiLinkMobileOwner(options);
  const body = { level: '52.6', charging: false, observedAt: '2026-01-02T03:04:05Z', ignored: true };
  const original = await owner.prepare(request('status-one')).saveDeviceStatus(body);
  assert.equal(original.deviceStatus?.batteryLevel, 53);
  assert.equal(original.deviceStatus?.observedAt, '2026-01-02T03:04:05.000Z');
  const replay = await createRabiLinkMobileOwner(options).prepare(request('status-one')).saveDeviceStatus(body);
  assert.equal(replay.deviceStatus?.receivedAt, original.deviceStatus?.receivedAt);
  assert.ok(Number(replay.deviceStatus?.ageMs) >= Number(original.deviceStatus?.ageMs));
  await assert.rejects(owner.prepare(request('status-one')).saveDeviceStatus({ ...body, ignored: false }), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  const proofBody = { event: 'e'.repeat(90), detail: 'd'.repeat(230), runtime: { sessionId: 's'.repeat(130) }, device: { model: 'm'.repeat(130) } };
  const first = await owner.prepare(request('proof-one')).recordProof(proofBody) as { proof: any };
  const second = await createRabiLinkMobileOwner(options).prepare(request('proof-one')).recordProof(proofBody) as { proof: any };
  assert.equal(first.proof.id, second.proof.id); assert.equal(first.proof.time, second.proof.time);
  assert.equal(first.proof.event.length, 80); assert.equal(first.proof.detail.length, 220); assert.equal(first.proof.sessionId.length, 120); assert.equal(first.proof.device.model.length, 120);
  assert.equal((await owner.prepare(request()).listProofs(null)).proofs.length, 1);
  scope = 'scope-two';
  assert.equal((await owner.prepare(request()).readDeviceStatus()).deviceStatus, null);
  assert.equal((await owner.prepare(request()).listProofs(null)).proofs.length, 0);
});

test('raw empty HTTP body replays the native historical object receipt while explicit null stays distinct', async t => {
  const dataDir = temporary(t), scope = 'scope-before-upgrade';
  const options = { dataDir, sourceDeviceId: 'pc-owner', authorize: () => ({ scope, sourceDeviceId: 'phone' }), applicationOwnerTarget: async () => 'pc-owner', peers: async () => [] };
  // The production decoder passed {} to the original native owner for zero bytes.
  // Seed that native receipt before recreating the owner behind the contract registry.
  const historical = await createRabiLinkMobileOwner(options).prepare(request('historical-empty')).recordProof({}) as { proof: { id: string } };
  const file = path.join(dataDir, 'rabilink-mobile-owner', createHash('sha256').update(scope).digest('hex') + '.json');
  const originalStore = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(originalStore.operations[0].fingerprint, createHash('sha256').update(JSON.stringify(['proof', {}])).digest('hex'));
  const owner = createRabiLinkMobileOwner(options), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('fixture-empty-mobile-body', createRabiLinkMobileOperations(() => owner));
  const server = http.createServer((req, res) => { if (!registry.handle(req, new URL(req.url!, 'http://fixture.invalid'), res)) res.writeHead(404).end(); });
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/rabilink/mobile/proof';
  const send = (key: string, raw?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(endpoint, { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (cause) { reject(cause); } });
    }); req.on('error', reject); req.end(raw);
  });
  const replay = await send('historical-empty');
  assert.equal(replay.status, 200); assert.equal(replay.body.proof.id, historical.proof.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), originalStore);
  assert.equal((await send('historical-empty', '{}')).body.proof.id, historical.proof.id);
  const conflictingNull = await send('historical-empty', 'null');
  assert.equal(conflictingNull.status, 409); assert.equal(conflictingNull.body.code, 'IDEMPOTENCY_CONFLICT');
  const explicitNull = await send('new-null-intent', 'null');
  assert.equal(explicitNull.status, 200); assert.notEqual(explicitNull.body.proof.id, historical.proof.id);
  assert.equal((await send('new-null-intent')).status, 409);
  assert.equal((await send('new-null-intent', 'null')).body.proof.id, explicitNull.body.proof.id);
  const finalStore = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(finalStore.proofs.length, 2); assert.equal(finalStore.operations.length, 2);
  assert.equal(finalStore.operations[1].fingerprint, createHash('sha256').update(JSON.stringify(['proof', null])).digest('hex'));
});

test('original connection, generation and cancellation fence awaited peer reads before persistence', async t => {
  const dataDir = temporary(t); let entered!: () => void, unblock!: () => void, allowed = true, current = true;
  let ready = new Promise<void>(resolve => { entered = resolve; }); let gate = new Promise<void>(resolve => { unblock = resolve; });
  const owner = createRabiLinkMobileOwner({ dataDir, sourceDeviceId: 'pc-owner', authorize: () => allowed ? { scope: 'scope-one', sourceDeviceId: 'phone' } : null,
    assertCurrent: () => { if (!current) throw Object.assign(new Error('changed'), { code: 'MOBILE_OWNER_CHANGED', statusCode: 409 }); },
    applicationOwnerTarget: async () => 'pc-owner', peers: async () => { entered(); await gate; return []; } });
  const pending = owner.prepare(request()).recordProof({ event: 'pending' });
  await ready; allowed = false; unblock();
  await assert.rejects(pending, { code: 'MOBILE_CONNECTION_CHANGED' });
  assert.equal(fs.existsSync(path.join(dataDir, 'rabilink-mobile-owner')), false);
  allowed = true; current = false;
  assert.throws(() => owner.prepare(request()), { code: 'MOBILE_OWNER_CHANGED' });
  current = true;
  ready = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { unblock = resolve; });
  const controller = new AbortController(), cancelled = owner.prepare(request(), controller.signal).recordProof({ event: 'cancelled' });
  await ready; controller.abort(); unblock(); await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(dataDir, 'rabilink-mobile-owner')), false);
});

test('native mobile capacity and fractional proof page rules retain receipts and stored source', async t => {
  const dataDir = temporary(t), scope = 'scope-one', directory = path.join(dataDir, 'rabilink-mobile-owner');
  fs.mkdirSync(directory); const file = path.join(directory, createHash('sha256').update(scope).digest('hex') + '.json');
  const producer = createRabiLinkMobileOwner({ dataDir, sourceDeviceId: 'pc-owner', authorize: () => ({ scope, sourceDeviceId: 'phone' }), applicationOwnerTarget: async () => 'pc-owner', peers: async () => [] });
  const proofs = [];
  for (const event of ['one', 'two', 'three']) proofs.push((await producer.prepare(request('proof-' + event)).recordProof({ event })).proof);
  const stored = { version: 1, asrPriority: [], deviceStatus: { batteryLevel: 2, charging: true, observedAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:00.000Z', source: 'rokid-cxr-phone' },
    proofs, operations: Array.from({ length: MOBILE_OWNER_LIMITS.operations }, (_, index) => ({ key: 'prior-' + index, fingerprint: 'fixture', result: { prior: index } })) };
  fs.writeFileSync(file, JSON.stringify(stored));
  const owner = createRabiLinkMobileOwner({ dataDir, sourceDeviceId: 'pc-owner', authorize: () => ({ scope, sourceDeviceId: 'phone' }), applicationOwnerTarget: async () => 'pc-owner', peers: async () => [] });
  assert.deepEqual((await owner.prepare(request()).listProofs('1.9')).proofs, [proofs[2]]);
  assert.equal((await owner.prepare(request()).listProofs('0')).proofs.length, 3);
  assert.equal((await owner.prepare(request()).listProofs('-2')).proofs.length, 1);
  assert.equal((await owner.prepare(request()).readDeviceStatus()).deviceStatus?.stale, true);
  await assert.rejects(owner.prepare(request('new-proof')).recordProof({ event: 'fixture' }), { code: 'MOBILE_OPERATION_CAPACITY', statusCode: 409 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).operations.length, MOBILE_OWNER_LIMITS.operations);
});

test('mobile context absence is distinct from authentication and owner reassignment during a read', async t => {
  const dataDir = temporary(t); let configured = false, allowed = true, target = 'pc-owner';
  let entered!: () => void, unblock!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { unblock = resolve; });
  const owner = createRabiLinkMobileOwner({ dataDir, sourceDeviceId: 'pc-owner', connectionContextAvailable: () => configured,
    authorize: () => allowed ? { scope: 'scope-one', sourceDeviceId: 'phone' } : null,
    applicationOwnerTarget: async () => target, peers: async () => { entered(); await gate; return []; } });
  assert.throws(() => owner.prepare(request()), { code: 'MOBILE_CONTEXT_UNAVAILABLE', statusCode: 503 });
  configured = true; allowed = false;
  assert.throws(() => owner.prepare(request()), { code: 'MOBILE_CONNECTION_REQUIRED', statusCode: 401 });
  allowed = true;
  const pending = owner.prepare(request()).recordProof({ event: 'assignment-check' });
  await ready; target = 'other-pc'; unblock();
  await assert.rejects(pending, { code: 'MOBILE_OWNER_PC_MISMATCH', statusCode: 409 });
  assert.equal(fs.existsSync(path.join(dataDir, 'rabilink-mobile-owner')), false);
});

test('registered mobile operations admit an enabled remote node and revoke it during native peer read', { timeout: 10000 }, async t => {
  const dataDir = temporary(t), authority = new LanAgentAuthority({ statePath: path.join(dataDir, 'authority.json') });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, 'fixture-node');
  const config = { enabled: true, url: 'https://relay.example', token: 'fixture-app', deviceId: 'pc-owner' };
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = createRabiLinkMobileOwner({ dataDir, sourceDeviceId: config.deviceId, authorize: req => rabiLinkAgentDevicePrincipal(req, config, 'generation'),
    applicationOwnerTarget: async () => config.deviceId, peers: async () => { entered(); await gate; return []; } });
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations('fixture-mobile', createRabiLinkMobileOperations(() => owner));
  const server = http.createServer((req, res) => {
    if (evaluateLanAgentRequest(req, authority, true).kind !== 'agent') { res.writeHead(403).end(); return; }
    setTrustedLanAgentSource(req, { nodeId: credential.nodeId, agentId: 'worker', provider: 'dsh', sessionId: 'fixture-session', sessionName: 'Fixture' });
    markAuthenticatedConnectionRequest(req);
    registerLanAgentBodyGuard(req, body => assertLanAgentBodyAuthority(new URL(req.url!, 'http://fixture.invalid').pathname, body, undefined));
    if (!registry.handle(req, new URL(req.url!, 'http://fixture.invalid'), res)) res.writeHead(404).end();
  });
  t.after(async () => { unblock(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  // Node HTTP deliberately avoids browser Fetch's forbidden ephemeral port list.
  const call = (pathname: string, method = 'GET', body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(base + pathname, { method, headers: { authorization: 'Bearer ' + credential.token, 'x-rabiroute-agent-id': 'worker', 'content-type': 'application/json', 'idempotency-key': 'proof-once' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (cause) { reject(cause); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const health = await call('/api/rabilink/devices/health-capabilities');
  assert.equal(health.status, 200); assert.deepEqual(health.body.rabilinkWearableObservation.processingPolicies, ['transcribe', 'agent']);
  const reported = await call('/api/rabilink/mobile/device-status', 'POST', { level: '64.7', charging: false });
  assert.equal(reported.status, 200); assert.equal(reported.body.deviceStatus.batteryLevel, 65);
  const pending = call('/api/rabilink/mobile/proof', 'POST', { event: 'lease-check' });
  await Promise.race([ready, pending.then(result => { throw new Error('proof rejected before owner: ' + JSON.stringify(result)); })]); authority.setNodeEnabled(credential.nodeId, false, true); unblock();
  const result = await pending; assert.equal(result.status, 403); assert.equal(result.body.errorCode, 'API_REQUEST_AUTHORITY_REVOKED');
  // The admitted status write remains; the subsequently revoked proof never commits.
  const storedFiles = fs.readdirSync(path.join(dataDir, 'rabilink-mobile-owner'));
  assert.equal(storedFiles.length, 1);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'rabilink-mobile-owner', storedFiles[0]), 'utf8'));
  assert.equal(stored.proofs.length, 0); assert.equal(stored.operations.length, 1); assert.equal(stored.deviceStatus.batteryLevel, 65);
});
