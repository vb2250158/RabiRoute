import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPcPairingService, findPcCredential, pairingHash, PAIRING_LIMITS } from './rabilink-pc-pairing.mjs';
import { buildPcOnboardingPrompt } from './rabilink-pc-pairing-ui.mjs';
function fixture() {
  let stored = { apps: [{ id: 'app-a', ownerAccountId: 'owner-a', token: 'application-fixture' }], workers: [] }, time = 1_000_000;
  const readStore = () => structuredClone(stored), writeStore = value => { stored = structuredClone(value); };
  const service = createPcPairingService({ readStore, writeStore, now: () => time });
  const ticket = 'rpt_' + randomBytes(32).toString('base64url'), proof = 'rpp_' + randomBytes(32).toString('base64url'), token = 'rbw_' + randomBytes(32).toString('base64url');
  const request = { id: randomUUID(), deviceId: 'cloud-pc', deviceGuid: randomUUID(), deviceName: 'Cloud PC', proofHash: pairingHash(proof), credentialHash: pairingHash(token) };
  const issuance = { id: randomUUID(), ticketHash: pairingHash(ticket) };
  return { service, ticket, proof, token, request, issuance, readStore, writeStore, expire() { time += PAIRING_LIMITS.lifetimeMs + 1; } };
}
test('one-time code binds the application, retries the original identity and stores only hashes', () => {
  const f = fixture();
  assert.throws(() => f.service.issue('owner-b', 'app-a', f.issuance), /APPLICATION_NOT_FOUND/);
  const issued = f.service.issue('owner-a', 'app-a', f.issuance);
  assert.deepEqual(f.service.issue('owner-a', 'app-a', f.issuance), issued);
  assert.throws(() => f.service.issue('owner-a', 'app-a', { ...f.issuance, id: randomUUID() }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.service.begin(f.request), /TICKET_REQUIRED/);
  const result = f.service.begin(f.request, f.ticket);
  assert.equal(result.appId, 'app-a'); assert.equal(result.state, 'approved');
  assert.deepEqual(f.service.begin(f.request, f.ticket), result);
  assert.throws(() => f.service.begin({ ...f.request, id: randomUUID() }, f.ticket), /TICKET_CONSUMED/);
  assert.throws(() => f.service.begin({ ...f.request, deviceName: 'Other' }, f.ticket), /IDEMPOTENCY_CONFLICT/);
  assert.equal(findPcCredential(f.readStore(), f.token).app.id, 'app-a');
  for (const secret of [f.ticket, f.proof, f.token]) assert.ok(!JSON.stringify(f.readStore()).includes(secret));
  const restarted = createPcPairingService({ readStore: f.readStore, writeStore: f.writeStore });
  assert.equal(restarted.read(f.request.id, f.proof).state, 'approved');
  assert.throws(() => restarted.read(f.request.id, 'rpp_' + randomBytes(32).toString('base64url')), /PROOF_REQUIRED/);
  assert.throws(() => restarted.revoke('owner-b', 'app-a', result.credentialId), /CREDENTIAL_NOT_FOUND/);
  restarted.revoke('owner-a', 'app-a', result.credentialId);
  assert.equal(findPcCredential(f.readStore(), f.token), null);
  assert.equal(restarted.read(f.request.id, f.proof).state, 'revoked');
});
test('expiry, duplicate device identity and application rotation block enrollment', () => {
  const f = fixture(); f.service.issue('owner-a', 'app-a', f.issuance); f.expire();
  assert.throws(() => f.service.begin(f.request, f.ticket), /TICKET_EXPIRED/);
  const g = fixture(); g.service.issue('owner-a', 'app-a', g.issuance); g.service.begin(g.request, g.ticket);
  const otherTicket = 'rpt_' + randomBytes(32).toString('base64url');
  g.service.issue('owner-a', 'app-a', { id: randomUUID(), ticketHash: pairingHash(otherTicket) });
  assert.throws(() => g.service.begin({ ...g.request, id: randomUUID() }, otherTicket), /ALREADY_EXISTS/);
  const rotated = g.readStore(); rotated.apps[0].token = 'changed-application'; g.writeStore(rotated);
  assert.equal(findPcCredential(g.readStore(), g.token), null);
  assert.throws(() => g.service.begin({ ...g.request, id: randomUUID(), deviceGuid: randomUUID(), deviceId: 'other' }, otherTicket), /TICKET_INVALID/);
});
test('failed persistence cannot consume a ticket or report a granted credential', () => {
  const f = fixture(); f.service.issue('owner-a', 'app-a', f.issuance);
  const failing = createPcPairingService({ readStore: f.readStore, now: () => 1_000_000, writeStore() { throw new Error('fixture disk unavailable'); } });
  assert.throws(() => failing.begin(f.request, f.ticket), /disk unavailable/);
  assert.equal(findPcCredential(f.readStore(), f.token), null);
  assert.equal(f.readStore().pcPairingTickets[0].requestId, undefined);
  assert.equal(f.service.begin(f.request, f.ticket).state, 'approved');
});
test('the copied prompt contains the complete fixed download contract and no manual approval step', () => {
  const input = { relayUrl: 'https://relay.example.com', appId: 'app-a', appName: 'My computers', ticket: 'rpt_' + randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000,
    files: ['rabilink-pair-pc.mjs', 'rabilink-pc-pairing.mjs'].map(name => ({ name, sha256: 'a'.repeat(64), size: 100 })) };
  const prompt = buildPcOnboardingPrompt(input);
  assert.ok(prompt.includes('--ticket-stdin') && prompt.includes('目标应用 ID: app-a') && prompt.includes(input.ticket));
  assert.ok(prompt.includes('成功兑换后立即失效') && prompt.includes('无需用户手填应用 token 或再次批准'));
  assert.throws(() => buildPcOnboardingPrompt({ ...input, relayUrl: 'http://public.example.com' }), /HTTPS/);
  assert.throws(() => buildPcOnboardingPrompt({ ...input, files: [] }), /校验信息/);
});
