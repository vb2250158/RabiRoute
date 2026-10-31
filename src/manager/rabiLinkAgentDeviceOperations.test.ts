import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRabiLinkAgentDevices, type RabiLinkAgentDevicesOptions } from './rabiLinkAgentDevices.js';
import { createRabiLinkAgentDeviceOperations } from './rabiLinkAgentDeviceOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import { rabiLinkAgentDevicePrincipal } from './rabiLinkAgentDeviceConnection.js';

const profile = { revision: 1, id: 'Fixture', name: 'Fixture', systemPrompt: 'Instruction', skills: [], mcp: [] };
const route = '/api/rabilink/agent-devices/glasses/profile';
async function fixture(t: test.TestContext, modify: (options: RabiLinkAgentDevicesOptions, root: string) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-operation-'));
  const registry = new ManagerPluginRouteRegistry(), config = { enabled: true, url: 'https://relay.example', token: 'fixture-app', deviceId: 'pc-owner' };
  const authority = new LanAgentAuthority({ statePath: path.join(root, 'authority.json') });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, 'empty-profile-node');
  const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-manager', health: { live: true, requiredReady: true } };
  const options: RabiLinkAgentDevicesOptions = { dataDir: root, sourceDeviceId: config.deviceId,
    authorize: request => rabiLinkAgentDevicePrincipal(request, config, 'fixture-generation'), deviceOwnerTarget: async () => config.deviceId,
    readLocal: async pathname => pathname === '/meta' ? meta : pathname === '/api/personas' ? { personas: [{ personaId: 'Fixture', name: 'Fixture' }] }
      : pathname.includes('persona-reference') ? { roleId: 'Fixture', document: fs.readFileSync(path.join(root, 'persona.md'), 'utf8') }
      : { content: fs.readFileSync(path.join(root, 'guide.md'), 'utf8'), title: 'Guide' }
  };
  fs.writeFileSync(path.join(root, 'persona.md'), 'Real fixture persona'); fs.writeFileSync(path.join(root, 'guide.md'), 'Real fixture Skill');
  modify(options, root);
  const owner = createRabiLinkAgentDevices(options);
  let registration: ReturnType<typeof registry.registerOperations> | undefined, server: http.Server | undefined;
  t.after(async () => { await registration?.dispose(); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  registration = registry.registerOperations('profiles', createRabiLinkAgentDeviceOperations(() => owner));
  server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== 'agent') { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request);
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, 'http://fixture').pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, 'http://fixture'), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  const begin = (pathname: string, method = 'GET') => {
    let request!: http.ClientRequest;
    const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
      request = http.request(base + pathname, { method, headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'text/plain' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject);
        response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
      });
      request.on('error', reject); request.setTimeout(8000, () => request.destroy(new Error('Owned fixture request timeout')));
    });
    return { get request() { return request; }, result };
  };
  const call = (pathname: string, method = 'GET', body?: unknown) => { const pending = begin(pathname, method); pending.request.end(body === undefined ? undefined : JSON.stringify(body)); return pending.result; };
  return { root, registry, config, meta, options, begin, call };
}

test('an enrolled empty Node manages a native PC profile and discovers the previously undeclared persona template', async t => {
  const f = await fixture(t);
  const template = await f.call('/api/rabilink/persona-template', 'POST', { roleId: 'Fixture', skillIds: ['guide'] });
  assert.equal(template.status, 200); assert.equal(template.body.data.profile.systemPrompt, 'Real fixture persona'); assert.equal(template.body.data.profile.skills[0].content, 'Real fixture Skill');
  assert.equal(fs.existsSync(path.join(f.root, 'rabilink-agent-devices')), false);
  const write = { expectedRevision: 0, idempotencyKey: 'save-one', profile: template.body.data.profile };
  const saved = await f.call(route, 'PUT', write); assert.equal(saved.status, 200);
  assert.deepEqual((await f.call(route + '/operations/save-one')).body.data.receipt, saved.body.data);
  assert.deepEqual((await f.call(route + '/operations/missing')).body.data, { receipt: null });
  assert.deepEqual((await f.call(route, 'PUT', write)).body, saved.body);
  assert.equal((await f.call(route + '/receipt', 'POST', { idempotencyKey: 'forged-ack', appliedRevision: 1, status: 'applied' })).status, 403);
  assert.equal((await f.call('/api/rabilink/agent-devices')).body.data.devices.length, 1);
});

test('original admission is captured before a delayed JSON body and cannot switch connection scope', async t => {
  let prepared!: () => void; const ready = new Promise<void>(resolve => { prepared = resolve; });
  const f = await fixture(t, options => { options.assertCurrent = () => prepared(); });
  const pending = f.begin(route, 'PUT'); pending.request.write('{'); await ready;
  f.config.token = 'replacement-fixture-app'; pending.request.end(JSON.stringify({ expectedRevision: 0, idempotencyKey: 'once', profile }).slice(1));
  const result = await pending.result; assert.equal(result.status, 401); assert.equal(result.body.code, 'PROFILE_CONNECTION_CHANGED');
  assert.equal(fs.existsSync(path.join(f.root, 'rabilink-agent-devices')), false);
});

test('a committed save whose original context changes returns uncertainty and retains its native receipt', async t => {
  let afterCommit = true;
  const f = await fixture(t, (options, root) => {
    const authorize = options.authorize;
    options.authorize = request => { const principal = authorize(request); return afterCommit && fs.existsSync(path.join(root, 'rabilink-agent-devices')) && principal ? { ...principal, scope: 'replacement-scope' } : principal; };
  });
  const result = await f.call(route, 'PUT', { expectedRevision: 0, idempotencyKey: 'committed-once', profile });
  assert.equal(result.status, 401); assert.equal(result.body.uncertain, true); afterCommit = false;
  assert.deepEqual((await f.call(route + '/operations/committed-once')).body.data.receipt.profile, profile);
});

test('PC assignment is checked again after an awaited persona read and before saving', async t => {
  let assignment = 'pc-owner';
  const f = await fixture(t, options => {
    options.deviceOwnerTarget = async () => assignment;
    options.readLocal = async () => { assignment = 'other-pc'; return { personas: [{ personaId: 'Fixture' }] }; };
  });
  const result = await f.call(route, 'PUT', { expectedRevision: 0, idempotencyKey: 'reassigned', profile: { ...profile, personaRef: { roleId: 'Fixture', sourceDeviceId: 'pc-owner' } } });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'PROFILE_OWNER_PC_MISMATCH'); assert.equal(fs.existsSync(path.join(f.root, 'rabilink-agent-devices')), false);
});

test('shared DTO schemas and native UTF-16, unique-ID and source checks reject invalid writes', async t => {
  const f = await fixture(t);
  for (const value of [{ ...profile, systemPrompt: '😀'.repeat(4001) }, { ...profile, name: 'null\u0000name' }, { ...profile, skills: [{ id: 'same', title: 'One', content: '', enabled: true }, { id: 'same', title: 'Two', content: '', enabled: true }] }, { ...profile, mcp: [{ id: 'x', label: 'X', enabled: true, url: 'https://example.invalid' }] }]) {
    const result = await f.call(route, 'PUT', { expectedRevision: 0, idempotencyKey: 'invalid', profile: value }); assert.equal(result.status, 400);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'rabilink-agent-devices')), false);
  const result = await f.call('/api/rabilink/persona-template', 'POST', { roleId: 'Fixture', skillIds: ['guide', 'guide'] }); assert.equal(result.status, 400);
});

test('missing connection business context is unavailable, independent of interface permission', async t => {
  const f = await fixture(t, options => { options.connectionContextAvailable = () => false; });
  const result = await f.call('/api/rabilink/agent-devices'); assert.equal(result.status, 503); assert.equal(result.body.code, 'PROFILE_CONTEXT_UNAVAILABLE');
});
