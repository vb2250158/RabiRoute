import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http, { type IncomingMessage } from 'node:http';
import { EventEmitter, once } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import WebSocket, { WebSocketServer } from 'ws';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest, hasAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { rabiLinkConnectionScope, rabiLinkTransportAssertionPresent, rabiLinkTrustedTransport } from './rabiLinkAgentDeviceConnection.js';
import * as webgui from './webguiLanAccess.js';
import { PeerTunnelRuntime } from '../peerTunnel/runtime.js';
import { TunnelSession } from '../peerTunnel/session.js';
import type { TunnelChannel } from '../peerTunnel/channel.js';
import { serveTunnel } from '../peerTunnel/http.js';

// Extract the production callbacks rather than duplicating their authority rule.
const controlFile = new URL(import.meta.url.endsWith('.ts') ? './controlPlaneRoutes.ts' : './controlPlaneRoutes.js', import.meta.url);
const source = fs.readFileSync(controlFile, 'utf8');
const ast = ts.createSourceFile(controlFile.pathname, source, ts.ScriptTarget.Latest, true);
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  if (predicate(root)) return root;
  let found: ts.Node | undefined;
  root.forEachChild(child => { if (!found) { try { found = find(child, predicate); } catch {} } });
  if (!found) throw new Error('Production callback missing.');
  return found;
}
const webguiFunction = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === 'webguiLanRequestAllowed');
const peerFactory = find(ast, n => ts.isFunctionDeclaration(n) && n.name?.text === 'createManagerPeerRuntime');
const control = find(peerFactory, n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'allowControl') as ts.PropertyAssignment;
const upgrade = find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'peerTunnelUpgrade') as ts.VariableDeclaration;
const callbackCode = ts.transpileModule(webguiFunction.getText(ast)
  + '\nglobalThis.peerControl = ' + control.initializer.getText(ast)
  + ';\nglobalThis.peerUpgrade = ' + upgrade.initializer!.getText(ast) + ';',
{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-control-access-'));
  const authority = new LanAgentAuthority({ statePath: path.join(directory, 'authority.json') });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, 'fixture-node');
  authority.registerAgentCatalog(credential.token, [{ agentId: 'sessionless', provider: 'custom-provider' }]);
  const admission = { enabled: true, incarnation: 'fixture-admission' };
  const config = { enabled: true, url: 'https://relay.example', token: 'synthetic-application', deviceId: 'fixture-pc' };
  let discoveries = 0, sessionCalls = 0;
  const context = vm.createContext({ ...webgui, hasAuthenticatedConnectionRequest,
    markAuthenticatedConnectionRequest, evaluateLanAgentRequest, assertTrustedLanAgentPrincipal,
    rabiLinkConnectionScope, rabiLinkTransportAssertionPresent, rabiLinkTrustedTransport,
    managerHost: '0.0.0.0', managerPort: 0, managerInstanceId: 'fixture-manager',
    managerHostIdentity: { applicationGenerationId: 'fixture-generation' }, lanAgentAuthority: authority,
    rabiLinkRelayConfigForMeta: () => config,
    localIpv4AddressEntries: () => [{ address: '127.0.0.1' }],
    remoteRequestUsesIndependentAuthorization: () => false,
    rabiGlobalConfig: { read: () => ({ webguiLan: { enabled: true, accessToken: 'synthetic-webgui-not-provided' } }),
      getLanAgentAdmissionPolicy: () => ({ ...admission }) }, URL });
  vm.runInContext(callbackCode, context);
  const tunnel = new PeerTunnelRuntime({ dataDir: directory, deviceId: config.deviceId, generation: 'fixture-generation',
    discover: async () => { discoveries++; return []; }, signal: async () => { throw new Error('No remote fixture.'); },
    relay: () => config, services: () => ({}), onStatus: () => {}, allowApplicationConnection: () => true,
    allowControl: context.peerControl as (request: IncomingMessage, url: URL) => boolean });
  context.activePeerTunnel = tunnel;
  const actualSession = tunnel.session.bind(tunnel);
  let providedSession: TunnelSession | undefined;
  tunnel.session = async (id, probe) => {
    sessionCalls++;
    if (providedSession && id === 'fixture-target') return providedSession;
    return actualSession(id, probe);
  };
  const projectRemote = (request: IncomingMessage) => {
    Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: '192.0.2.10' });
  };
  const server = http.createServer((request, response) => {
    try {
      projectRemote(request);
      assert.equal(evaluateLanAgentRequest(request, authority, true, () => ({ ...admission })).kind, 'agent');
      assert.equal(assertTrustedLanAgentPrincipal(request)?.binding?.sessionId, undefined);
      markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
      if (request.headers['x-fixture-revoke-after-admission']) admission.enabled = false;
      if (!tunnel.handler(request, new URL(request.url!, 'http://fixture'), response, async () => ({}))) {
        response.writeHead(404); response.end();
      }
    } catch { response.writeHead(403); response.end(); }
  });
  const upgradeCallback = context.peerUpgrade as (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void;
  server.on('upgrade', (request, socket, head) => { projectRemote(request); upgradeCallback(request, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  context.managerPort = (server.address() as import('node:net').AddressInfo).port;
  t.after(async () => { tunnel.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { tunnel, context, admission, projectRemote, upgradeCallback,
    origin: 'http://127.0.0.1:' + context.managerPort,
    headers: { authorization: 'Bearer ' + credential.token, 'x-rabiroute-agent-id': 'sessionless' },
    discoveries: () => discoveries, sessionCalls: () => sessionCalls,
    useSession: (value: TunnelSession) => { providedSession = value; } };
}

test('production control callback reuses authenticated Agent authority for public peer APIs', async t => {
  const f = await fixture(t);
  for (const suffix of ['servers', 'selection', 'identity']) {
    const response = await fetch(f.origin + '/api/rabilink/peer/' + suffix, { headers: f.headers });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const future = await fetch(f.origin + '/api/rabilink/peer/http/future-pc/manager/api/future', { headers: f.headers });
  assert.equal(future.status, 502); await future.arrayBuffer();
  assert.equal(f.sessionCalls(), 1); // Connection unavailable, rather than a second authorization requirement.
  const revoked = await fetch(f.origin + '/api/rabilink/peer/selection', { headers: { ...f.headers, 'x-fixture-revoke-after-admission': '1' } });
  assert.equal(revoked.status, 403); await revoked.arrayBuffer();
  assert.equal(f.sessionCalls(), 1);
});

test('production Upgrade callback admits the same Agent and stops bytes after lease revocation', { timeout: 7000 }, async t => {
  const f = await fixture(t);
  // Reuse the actual session framing fixture; transport cipher/peer-key authentication
  // belongs to its independent tests, while this test covers Manager ingress and WS IO.
  const a = new EventEmitter() as TunnelChannel, b = new EventEmitter() as TunnelChannel;
  let closed = false;
  a.send = async bytes => { setImmediate(() => { if (!closed) b.emit('data', bytes); }); };
  b.send = async bytes => { setImmediate(() => { if (!closed) a.emit('data', bytes); }); };
  a.close = b.close = () => { if (!closed) { closed = true; a.emit('close'); b.emit('close'); } };
  const cipher = { encode: (value: unknown) => Buffer.from(JSON.stringify(value)), decode: (bytes: Buffer) => JSON.parse(bytes.toString()) };
  const hello = { deviceId: 'fixture-target', generation: 'generation', publicKey: 'test-only', ephemeral: 'test-only', nonce: 'test-only', target: 'fixture-caller', signature: 'test-only' };
  const grant = { deviceId: hello.deviceId, publicKey: hello.publicKey, services: ['manager'] };
  const caller = new TunnelSession(hello, grant, a, cipher, true);
  const receiver = new TunnelSession(hello, grant, b, cipher, false);
  f.useSession(caller);
  const upstream = http.createServer(); const websocket = new WebSocketServer({ noServer: true });
  const upstreamReceived: string[] = [];
  upstream.on('upgrade', (request, socket, head) => websocket.handleUpgrade(request, socket, head, ws => {
    ws.on('message', bytes => { upstreamReceived.push(bytes.toString()); ws.send(bytes); });
  }));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const baseUrl = 'http://127.0.0.1:' + (upstream.address() as import('node:net').AddressInfo).port;
  serveTunnel(receiver, () => ({ manager: { baseUrl } }), () => true);
  const client = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/rabilink/peer/http/fixture-target/manager/api/future-ws', { headers: f.headers });
  client.on('error', () => {});
  t.after(async () => { client.terminate(); caller.close(); receiver.close(); for (const value of websocket.clients) value.terminate(); websocket.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  await once(client, 'open'); assert.equal(f.sessionCalls(), 1);
  const first = once(client, 'message'); client.send('before-revocation');
  assert.equal((await first)[0].toString(), 'before-revocation');
  const disconnected = once(client, 'close'); f.admission.enabled = false; client.send('after-revocation');
  await disconnected;
  assert.deepEqual(upstreamReceived, ['before-revocation']);
  assert.equal(f.sessionCalls(), 1);
});

test('production Upgrade leaves other registry paths alone and rejects forged transport identity', async t => {
  const f = await fixture(t);
  const { IncomingMessage } = await import('node:http'); const { Socket } = await import('node:net');
  const other = new IncomingMessage(new Socket()); other.url = '/api/lan-agent/socket';
  let destroyed = 0;
  const socket = { destroy() { destroyed++; } } as unknown as import('node:stream').Duplex;
  f.upgradeCallback(other, socket, Buffer.alloc(0)); assert.equal(destroyed, 0);
  const forged = new IncomingMessage(new Socket()); forged.method = 'GET';
  forged.url = '/api/rabilink/peer/http/fixture-target/manager/api/future-ws';
  forged.headers = { ...f.headers, 'x-rabilink-tunnel-local': 'fixture-generation' };
  f.projectRemote(forged); f.upgradeCallback(forged, socket, Buffer.alloc(0));
  assert.equal(destroyed, 1); assert.equal(f.sessionCalls(), 0);
});
