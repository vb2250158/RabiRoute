import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { issueInternalManagerHopHeaders } from '../shared/internalManagerHop.js';
import { encodeComputerPeerSource, rabiLinkAgentDevicePrincipal, rabiLinkAgentTaskSource, rabiLinkConnectionScope, rabiLinkPeerComputerSource } from './rabiLinkAgentDeviceConnection.js';
import { COMPUTER_PEER_SOURCE_HEADER } from '../shared/peerTunnelContract.js';

test('only the current loopback transport may assert device receipt ownership; app management remains separate', () => {
  const config = { enabled: true, url: 'https://relay.example', token: 'fixture-token', deviceId: 'pc-owner' };
  const request = (remoteAddress: string, headers: IncomingMessage['headers'] = {}) => ({ method: 'GET', url: '/', socket: { remoteAddress }, headers }) as unknown as IncomingMessage;
  const headers = issueInternalManagerHopHeaders({ kind: 'peer', generation: 'generation-one', scope: rabiLinkConnectionScope(config), deviceId: 'glasses', method: 'GET', target: '/' });
  const signed = request('::ffff:127.0.0.1', headers);
  assert.equal(rabiLinkAgentDevicePrincipal(signed, config, 'generation-one')?.deviceOwner, true);
  assert.equal(rabiLinkAgentTaskSource(signed, config, 'generation-one')?.sourceDeviceId, 'glasses');
  assert.equal(rabiLinkAgentDevicePrincipal(signed, config, 'generation-two'), null);
  const forged = request('192.168.0.2', headers); markAuthenticatedConnectionRequest(forged);
  assert.equal(rabiLinkAgentDevicePrincipal(forged, config, 'generation-one'), null);
  const admin = request('127.0.0.1'); assert.equal(rabiLinkAgentDevicePrincipal(admin, config, 'generation-one'), null);
  markAuthenticatedConnectionRequest(admin);
  assert.deepEqual(rabiLinkAgentDevicePrincipal(admin, config, 'generation-one'), { scope: rabiLinkConnectionScope(config), sourceDeviceId: 'pc-owner', deviceOwner: false });
  assert.equal(rabiLinkAgentTaskSource(admin, config, 'generation-one'), undefined);
  const app = request('127.0.0.1', issueInternalManagerHopHeaders({ kind: 'peer', generation: 'generation-one', scope: rabiLinkConnectionScope(config), deviceId: '$application', method: 'GET', target: '/' }));
  assert.equal(rabiLinkAgentDevicePrincipal(app, config, 'generation-one')?.deviceOwner, false);
  assert.equal(rabiLinkAgentDevicePrincipal(signed, { ...config, enabled: false }, 'generation-one'), null);
  assert.notEqual(rabiLinkConnectionScope(config), rabiLinkConnectionScope({ ...config, token: 'new-token' }));
  assert.equal(rabiLinkConnectionScope(config), rabiLinkConnectionScope({ ...config, url: config.url + '/' }));
  const bare = request('127.0.0.1', { 'x-rabilink-tunnel-local': 'generation-one', 'x-rabiroute-peer-proxy': '1', 'x-rabilink-tunnel-device-id': 'glasses' });
  markAuthenticatedConnectionRequest(bare);
  assert.equal(rabiLinkAgentDevicePrincipal(bare, config, 'generation-one'), null);
  const replay = request('127.0.0.1', headers);
  markAuthenticatedConnectionRequest(replay);
  assert.equal(rabiLinkAgentDevicePrincipal(replay, config, 'generation-one'), null);
});

test('signed native identity rechecks the original ingress authority before receipt ownership', () => {
  const config = { enabled: true, url: 'https://relay.example', token: 'fixture-token', deviceId: 'pc-owner' };
  const request = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers:
    issueInternalManagerHopHeaders({ kind: 'relay', generation: 'generation-one', scope: rabiLinkConnectionScope(config), deviceId: 'glasses', method: 'GET', target: '/' })
  } as unknown as IncomingMessage;
  let active = true;
  markAuthenticatedConnectionRequest(request, () => { if (!active) throw new Error('Original connection revoked.'); });
  assert.equal(rabiLinkAgentDevicePrincipal(request, config, 'generation-one')?.deviceOwner, true);
  active = false;
  assert.equal(rabiLinkAgentDevicePrincipal(request, config, 'generation-one'), null);
});

test('computer sources stay scoped to their attested device, including named and legacy calls', () => {
  const generation = 'computer-fixture', scope = 'c'.repeat(64);
  const method = 'POST', url = '/api/lan-agent/instances/windows-fixture/computer';
  const request = (deviceId?: string, actor?: string) => ({
    method, url, socket: { remoteAddress: '127.0.0.1' }, headers: {
      ...(deviceId ? issueInternalManagerHopHeaders({ kind: 'peer', generation, scope, deviceId, method, target: url }) : {}),
      ...(actor ? { [COMPUTER_PEER_SOURCE_HEADER]: actor } : {})
    }
  }) as unknown as IncomingMessage;
  const actor = encodeComputerPeerSource('same-local-thread', '远端\n游戏会话');
  const originA = rabiLinkPeerComputerSource(request('host-a', actor), generation, scope);
  const originB = rabiLinkPeerComputerSource(request('host-b', actor), generation, scope);
  assert.equal(originA?.sourceLabel, '远端游戏会话');
  assert.notEqual(originA?.sourceId, originB?.sourceId);
  assert.deepEqual(rabiLinkPeerComputerSource(request('host-b', 'invalid'), generation, scope),
    { sourceId: 'peer:host-b', sourceLabel: 'host-b' });
  const local = request(undefined, actor);
  markAuthenticatedConnectionRequest(local);
  assert.equal(rabiLinkPeerComputerSource(local, generation, scope), undefined);
  assert.equal(rabiLinkPeerComputerSource(request('$application', actor), generation, scope), undefined);
  assert.equal(rabiLinkPeerComputerSource(request('host-b', actor), 'stale-generation', scope), undefined);
});
