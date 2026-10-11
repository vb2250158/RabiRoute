import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { issueInternalManagerHopHeaders } from '../shared/internalManagerHop.js';
import { rabiLinkAgentDevicePrincipal, rabiLinkConnectionScope } from './rabiLinkAgentDeviceConnection.js';

test('only the current loopback transport may assert device receipt ownership; app management remains separate', () => {
  const config = { enabled: true, url: 'https://relay.example', token: 'fixture-token', deviceId: 'pc-owner' };
  const request = (remoteAddress: string, headers: IncomingMessage['headers'] = {}) => ({ method: 'GET', url: '/', socket: { remoteAddress }, headers }) as unknown as IncomingMessage;
  const headers = issueInternalManagerHopHeaders({ kind: 'peer', generation: 'generation-one', scope: rabiLinkConnectionScope(config), deviceId: 'glasses', method: 'GET', target: '/' });
  const signed = request('::ffff:127.0.0.1', headers);
  assert.equal(rabiLinkAgentDevicePrincipal(signed, config, 'generation-one')?.deviceOwner, true);
  assert.equal(rabiLinkAgentDevicePrincipal(signed, config, 'generation-two'), null);
  const forged = request('192.168.0.2', headers); markAuthenticatedConnectionRequest(forged);
  assert.equal(rabiLinkAgentDevicePrincipal(forged, config, 'generation-one'), null);
  const admin = request('127.0.0.1'); assert.equal(rabiLinkAgentDevicePrincipal(admin, config, 'generation-one'), null);
  markAuthenticatedConnectionRequest(admin);
  assert.deepEqual(rabiLinkAgentDevicePrincipal(admin, config, 'generation-one'), { scope: rabiLinkConnectionScope(config), sourceDeviceId: 'pc-owner', deviceOwner: false });
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
