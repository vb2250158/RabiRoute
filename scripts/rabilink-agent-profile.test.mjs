import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentProfileService, validateAgentProfile } from './rabilink-agent-profile.mjs';
const account = { kind: 'account', accountId: 'a' };
const device = { kind: 'device', appId: 'app', bindingId: 'device', credentialHash: 'verified' };
const profile = (revision = 1) => ({ revision, id: 'agent', name: 'Assistant', systemPrompt: 'Help', skills: [{ id: 'guide', title: 'Guide', content: 'Read carefully', enabled: true }], mcp: [{ id: 'pc-knowledge', label: 'Knowledge', enabled: true }] });
function setup() {
  let value = { apps: [{ id: 'app', ownerAccountId: 'a', deviceBindings: [{ id: 'device', enabled: true, credentialHash: 'verified' }] }], accounts: ['keep'], workers: ['keep'] };
  let writes = 0;
  const service = createAgentProfileService({ readStore: () => value, writeStore: next => { value = next; writes++; } });
  return { service, writes: () => writes, store: () => value };
}
const save = (s, revision = 1, k = `save-${revision}`) => s.save(account, 'app', 'device', { expectedRevision: revision - 1, idempotencyKey: k, profile: profile(revision) });
const code = expected => error => error.statusCode === expected;
test('schema rejects unknown executable/credential/URL settings and enforces limits', () => {
  assert.deepEqual(validateAgentProfile(profile()), profile());
  for (const p of [{ ...profile(), url: 'http://pc' }, { ...profile(), revision: 0 }, { ...profile(), skills: [{ ...profile().skills[0], command: 'run' }] }, { ...profile(), mcp: [{ id: 'x', label: 'X', enabled: true, token: 'secret' }] }, { ...profile(), systemPrompt: 'x'.repeat(8001) }, { ...profile(), skills: [profile().skills[0], profile().skills[0]] }]) assert.throws(() => validateAgentProfile(p), code(400));
});
test('AIUI profile boundary limits match the device schema', () => {
  const p = { ...profile(), id: 'i'.repeat(128), name: 'n'.repeat(128), systemPrompt: 'p'.repeat(8000), skills: Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, title: 't'.repeat(128), content: 'c'.repeat(1500), enabled: true })), mcp: Array.from({ length: 16 }, (_, i) => ({ id: `m${i}`, label: 'l'.repeat(128), enabled: true })) };
  assert.deepEqual(validateAgentProfile(p), p);
  for (const value of [{ ...p, id: 'i'.repeat(129) }, { ...p, skills: [...p.skills, { ...p.skills[0], id: 'extra' }] }, { ...p, mcp: [...p.mcp, { ...p.mcp[0], id: 'extra' }] }, { ...p, skills: p.skills.map((s, i) => i ? s : { ...s, content: s.content + 'x' }) }]) assert.throws(() => validateAgentProfile(value), code(400));
});
test('device binding and account ownership are checked afresh', () => {
  const { service: s, store } = setup();
  assert.throws(() => s.readForAccount({ kind: 'account', accountId: 'other' }, 'app', 'device'), code(404));
  assert.throws(() => s.readOwn({ ...device, credentialHash: 'wrong' }), code(404));
  assert.throws(() => s.readOwn(account), code(403));
  store().apps[0].deviceBindings[0].enabled = false;
  assert.throws(() => s.readOwn(device), code(404));
});
test('CAS and stable replay preserve original receipt without duplicate writes', () => {
  const f = setup(), s = f.service;
  const first = save(s); assert.equal(first.savedRevision, 1);
  assert.deepEqual(save(s), first); assert.equal(f.writes(), 1);
  assert.throws(() => s.save(account, 'app', 'device', { expectedRevision: 0, idempotencyKey: 'new', profile: profile() }), code(412));
  assert.throws(() => s.save(account, 'app', 'device', { expectedRevision: 0, idempotencyKey: 'save-1', profile: { ...profile(), name: 'Different' } }), code(409));
  save(s, 2); assert.deepEqual(save(s), first);
  assert.deepEqual(f.store().accounts, ['keep']); assert.equal(s.readOwn(device).savedRevision, 2);
});
test('applied revision cannot exceed saved or move backwards; failures are bounded codes', () => {
  const f = setup(), s = f.service; save(s);
  assert.throws(() => s.acknowledge(device, { idempotencyKey: 'a2', appliedRevision: 2, status: 'applied' }), code(409));
  const input = { idempotencyKey: 'a1', appliedRevision: 1, status: 'applied' };
  assert.deepEqual(s.acknowledge(device, input), s.acknowledge(device, input)); assert.equal(f.writes(), 2);
  save(s, 2); s.acknowledge(device, { idempotencyKey: 'a2', appliedRevision: 2, status: 'failed', errorCode: 'MODEL_UNAVAILABLE' });
  assert.throws(() => s.acknowledge(device, { ...input, idempotencyKey: 'old' }), code(409));
  assert.throws(() => s.acknowledge(device, { ...input, errorCode: 'secret stack' }), code(400));
});
test('storage failures leave read snapshot unchanged and no success is returned', () => {
  const source = { apps: [{ id: 'app', ownerAccountId: 'a', deviceBindings: [{ id: 'device' }] }] };
  const s = createAgentProfileService({ readStore: () => source, writeStore: () => { throw new Error('disk failure'); } });
  assert.throws(() => save(s), /disk failure/); assert.equal(source.apps[0].deviceBindings[0].agentProfileState, undefined);
});
test('caller mutation cannot alter saved profile or receipts', () => {
  const f = setup(); const result = save(f.service); result.profile.name = 'Changed';
  assert.equal(f.service.readOwn(device).profile.name, 'Assistant');
});
