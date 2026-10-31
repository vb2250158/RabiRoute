import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { setTrustedLanAgentSource, registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { rabiLinkAgentDevicePrincipal } from './rabiLinkAgentDeviceConnection.js';
import { createRabiLinkAgentDevices } from './rabiLinkAgentDevices.js';
import { createRabiLinkAgentDeviceOperations } from './rabiLinkAgentDeviceOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';

test('marked ingress cannot save a profile after its Agent lease is revoked during a persona read', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-profile-lease-'));
  const authority = new LanAgentAuthority({ statePath: path.join(directory, 'authority.json') });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, 'fixture-node');
  const config = { enabled: true, url: 'https://relay.example', token: 'fixture-app', deviceId: 'pc-owner' };
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = createRabiLinkAgentDevices({ dataDir: directory, sourceDeviceId: config.deviceId,
    authorize: request => rabiLinkAgentDevicePrincipal(request, config, 'generation'),
    deviceOwnerTarget: async () => config.deviceId,
    readLocal: async () => { entered(); await gate; return { personas: [{ personaId: 'Local' }] }; }
  });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations('fixture-profile-lease', createRabiLinkAgentDeviceOperations(() => owner));
  const server = http.createServer(async (request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== 'agent') { response.writeHead(403).end(); return; }
    setTrustedLanAgentSource(request, { nodeId: 'fixture-node', agentId: 'worker', provider: 'dsh', sessionId: 'fixture-session', sessionName: 'Fixture' });
    markAuthenticatedConnectionRequest(request);
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, 'http://fixture.invalid').pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, 'http://fixture.invalid'), response)) response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { unblock(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const pending = fetch('http://127.0.0.1:' + address.port + '/api/rabilink/agent-devices/glasses/profile', {
    method: 'PUT', headers: { authorization: 'Bearer ' + credential.token, 'x-rabiroute-agent-id': 'worker', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, idempotencyKey: 'save-once', profile: { revision: 1, id: 'Local', name: 'Local', systemPrompt: '', skills: [], mcp: [], personaRef: { roleId: 'Local', sourceDeviceId: config.deviceId } } })
  });
  await ready; authority.setNodeEnabled(credential.nodeId, false, true); unblock();
  const response = await pending; assert.equal(response.status, 403); assert.equal((await response.json()).errorCode, 'API_REQUEST_AUTHORITY_REVOKED');
  assert.equal(fs.existsSync(path.join(directory, 'rabilink-agent-devices')), false);
});
