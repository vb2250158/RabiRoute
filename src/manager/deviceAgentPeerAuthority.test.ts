import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDeviceAgentPeerAuthority } from './deviceAgentPeerAuthority.js';
import { agentDeliveryPromptHash } from '../agentRequests/store.js';
import { endpointExecutionOptionsHash } from '../agentRequests/executionOptions.js';
import type { PreparedEndpointDelivery } from '../agentRequests/endpointDelivery.js';

test('HTTP peer issuer and native claim retain original connection and ledger evidence', async () => {
  const source = { kind: 'device' as const, managerInstanceId: 'ledger-b', instanceId: 'owner-a', agentId: 'eye-origin', provider: 'deviceAgent', sessionId: 'source-session', authorizationIncarnation: 'source-epoch' };
  const target = { ...source, agentId: 'eye', sessionId: 'target-session', authorizationIncarnation: 'target-epoch' };
  const delivery: PreparedEndpointDelivery = {
    deliveryId: 'original-delivery', generation: 'original-generation', source, target,
    prompt: 'original message', promptHash: agentDeliveryPromptHash('original message'), executionOptions: {}, executionOptionsHash: endpointExecutionOptionsHash({}), state: 'dispatching',
    preparation: { deliveryId: 'original-delivery', responsePolicy: 'required',
      source: { endpoint: source, threadId: source.sessionId, agentAdapter: 'deviceAgent', agentType: 'agent' },
      target: { endpoint: target, threadId: target.sessionId, agentAdapter: 'deviceAgent', agentType: 'agent' } }
  };
  let scope = 'scope', active = true, proofValid = true, revokeDuringRead = false, reads = 0;
  const admitted = new WeakSet<object>();
  const proofServer = http.createServer((_req, res) => {
    reads++;
    if (revokeDuringRead) active = false;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ authorized: proofValid, ledgerManagerInstanceId: 'ledger-b', state: 'dispatching',
      deliveryId: delivery.deliveryId, generation: delivery.generation, source, endpoint: target, preparation: delivery.preparation,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash }));
  });
  await new Promise<void>(resolve => proofServer.listen(0, '127.0.0.1', resolve));
  const proofUrl = `http://127.0.0.1:${(proofServer.address() as import('node:net').AddressInfo).port}`;
  const authority = createDeviceAgentPeerAuthority({
    scope: () => scope, localDeviceId: () => 'pc-a',
    authorize: req => active && admitted.has(req) ? { scope, deviceOwner: true, sourceDeviceId: String(req.headers['x-test-source']) } : null,
    trustedTransport: req => admitted.has(req),
    readProof: async () => {
      const response = await fetch(proofUrl);
      return response.json();
    }
  });
  const ownerServer = http.createServer(async (req, res) => {
    // Test admission models verified transport; raw body fields never establish it.
    if (req.headers['x-test-authenticated'] === '1') admitted.add(req);
    try {
      let raw = ''; for await (const chunk of req) raw += String(chunk);
      const input = JSON.parse(raw);
      if (req.url === '/claim') await authority.authorizePreparedClaim(req, 'eye', input);
      else await authority.authorizePrepared(req, 'eye', input);
      res.writeHead(200); res.end('accepted');
    } catch { res.writeHead(403); res.end('denied'); }
  });
  await new Promise<void>(resolve => ownerServer.listen(0, '127.0.0.1', resolve));
  const ownerUrl = `http://127.0.0.1:${(ownerServer.address() as import('node:net').AddressInfo).port}`;
  const send = (caller: string, path = '/prepared', authenticated = true) => fetch(ownerUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-source': caller, ...(authenticated ? { 'x-test-authenticated': '1' } : {}) },
    body: JSON.stringify(path === '/claim'
      ? { ledgerOwnerDeviceId: 'pc-b', deliveryId: delivery.deliveryId, generation: delivery.generation, source, target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash }
      : { ledgerOwnerDeviceId: 'pc-b', delivery })
  });
  try {
    assert.equal((await send('pc-b', '/prepared', false)).status, 403);
    assert.equal((await send('pc-c')).status, 403);
    assert.equal(reads, 0);
    assert.equal((await send('pc-b')).status, 200);
    assert.equal((await send('eye', '/claim')).status, 200);
    assert.equal((await send('pc-b', '/claim')).status, 403);
    proofValid = false;
    assert.equal((await send('eye', '/claim')).status, 403);
    proofValid = true; revokeDuringRead = true;
    assert.equal((await send('pc-b')).status, 403);
    active = true; revokeDuringRead = false;
    scope = '';
    assert.equal((await send('pc-b')).status, 403);
  } finally {
    for (const server of [ownerServer, proofServer]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
