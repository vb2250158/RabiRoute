import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySignedUpgrade, resolveSignedUpgrade, stageSignedInstaller } from './rabilink-host-upgrade.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const policy = { manifestUrl: 'https://releases.example.test/stable/manifest.json', channel: 'stable', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) };
const release = (version, digit) => ({ version, releaseId: `${version}-${digit.repeat(12)}`, payloadSha256: digit.repeat(64),
  installerSha256: '9'.repeat(64), installerUrl: `https://releases.example.test/setup-${version}.exe`, size: 8000 });
const previous = release('0.15.31', 'a');
const target = release('0.15.37', 'b');
const now = Date.now();
const manifest = { schemaVersion: 1, appId: 'io.rabiroute.windows', channel: 'stable', platform: 'win32-x64',
  issuedAt: now - 1000, expiresAt: now + 1000, releases: [previous, target], latest: target.releaseId };

function envelope(body = manifest) {
  const bytes = Buffer.from(JSON.stringify(body));
  return { payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
}

test('checks channel trust, expiry, release identity and exact rollback installer', () => {
  assert.deepEqual(resolveSignedUpgrade(envelope(), policy, previous, now), { previous, target });
  assert.equal(resolveSignedUpgrade(envelope(), policy, target, now), undefined);
  assert.throws(() => resolveSignedUpgrade({ ...envelope(), payload: Buffer.from('{}').toString('base64url') }, policy, previous, now), /UPGRADE_BAD_SIGNATURE/);
  assert.throws(() => resolveSignedUpgrade(envelope(), policy, previous, now + 1001), /UPGRADE_INVALID_MANIFEST/);
  assert.throws(() => resolveSignedUpgrade(envelope({ ...manifest, releases: [target] }), policy, previous, now), /UPGRADE_ROLLBACK_ARTIFACT_MISSING/);
  assert.throws(() => resolveSignedUpgrade(envelope({ ...manifest, releases: [previous, { ...target, installerUrl: 'https://untrusted.example.test/setup.exe' }] }), policy, previous, now), /UPGRADE_UNTRUSTED_URL/);
});

function lifecycle(failReady, originalIdentityChanged = false) {
  let installed = previous;
  let reads = 0;
  const events = [];
  return { events, owner: {
    current() {
      reads++;
      return { ...installed, generation: reads === 2 && originalIdentityChanged ? 'another-generation' : 'previous-generation' };
    },
    pointer: () => installed,
    stage(release) { events.push(`stage:${release.releaseId}`); return release; },
    install(artifact) { events.push(`install:${artifact.releaseId}`); installed = artifact; },
    ready(release, generation) {
      assert.equal(generation, 'previous-generation');
      assert.equal(installed.releaseId, release.releaseId);
      events.push(`ready:${release.releaseId}`);
      if (failReady && release === target) throw new Error('new Manager not ready');
    },
    record(status) { events.push(status.state); }
  } };
}

test('stages both installers and completes only after the new Host is ready', async () => {
  const { owner, events } = lifecycle(false);
  assert.equal(await applySignedUpgrade({ previous, target }, owner), 'completed');
  assert.deepEqual(events, [`stage:${previous.releaseId}`, `stage:${target.releaseId}`, 'installing', `install:${target.releaseId}`, `ready:${target.releaseId}`, 'completed']);
});

test('restores the exact previous release after readiness failure', async () => {
  const { owner, events } = lifecycle(true);
  assert.equal(await applySignedUpgrade({ previous, target }, owner), 'rolled_back');
  assert.deepEqual(events.slice(-4), ['rolling_back', `install:${previous.releaseId}`, `ready:${previous.releaseId}`, 'rolled_back']);
});

test('a concurrent Host generation change blocks installation', async () => {
  const { owner, events } = lifecycle(false, true);
  await assert.rejects(applySignedUpgrade({ previous, target }, owner), /UPGRADE_ORIGINAL_HOST_CHANGED/);
  assert.deepEqual(events, [`stage:${previous.releaseId}`, `stage:${target.releaseId}`]);
});

test('a failed installer leaves the still-running original Host alone', async () => {
  const { owner, events } = lifecycle(false);
  owner.install = () => { throw new Error('installer failed before switch'); };
  await assert.rejects(applySignedUpgrade({ previous, target }, owner), /installer failed before switch/);
  assert.deepEqual(events, [`stage:${previous.releaseId}`, `stage:${target.releaseId}`, 'installing']);
});

test('installer staging checks the downloaded length and digest before activation is possible', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rabi-upgrade-integrity-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  const bytes = Buffer.from('fixture signed installer bytes');
  const entry = { ...target, size: bytes.length, installerSha256: createHash('sha256').update(bytes).digest('hex') };
  const exact = await stageSignedInstaller(entry, directory, async () => new Response(bytes));
  assert.deepEqual(await readFile(exact), bytes);
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 1;
  await assert.rejects(stageSignedInstaller(entry, directory, async () => new Response(tampered)), /UPGRADE_DIGEST_MISMATCH/);
  await assert.rejects(stageSignedInstaller(entry, directory, async () => new Response(Buffer.concat([bytes, bytes]))), /UPGRADE_SIZE_MISMATCH/);
  assert.deepEqual(await readdir(directory), [path.basename(exact)]);
});
