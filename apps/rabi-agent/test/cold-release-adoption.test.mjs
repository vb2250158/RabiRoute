import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { adoptColdRelease, sha256, launcherLeaseTarget } from '../lib/cold-release-adoption.mjs';

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-cold-')));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const fingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  const verifier = `import {createPublicKey,createHash,verify} from 'node:crypto'; export function verifyReleaseManifest(m,key){const hash=createHash('sha256').update(createPublicKey(m.publicKey).export({type:'spki',format:'der'})).digest('hex'); const payload=JSON.stringify({version:m.version,platform:m.platform,minNodeVersion:m.minNodeVersion,files:m.files.map(f=>({path:f.path,sha256:f.sha256,size:f.size,downloadUrl:f.downloadUrl}))});return hash===key&&hash===m.publicKeySha256&&verify(null,Buffer.from(payload),m.publicKey,Buffer.from(m.signature,'base64'));}`;
  const assets = { 'rabi-agent.mjs': verifier, 'lib/example.mjs': 'export const sample=1;' };
  const manifest = { version: '1.0.0', platform: 'node', minNodeVersion: '18.0.0', files: Object.entries(assets).map(([name, bytes]) => ({ path: name, sha256: sha256(bytes), size: Buffer.byteLength(bytes), downloadUrl: '/fixture/' + name })) };
  const payload = JSON.stringify(manifest), digest = sha256(payload);
  Object.assign(manifest, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: fingerprint, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') });
  const target = path.join(root, 'releases', '1.0.0-' + digest); fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
  for (const [name, bytes] of Object.entries(assets)) fs.writeFileSync(path.join(target, name), bytes);
  fs.writeFileSync(path.join(target, 'release-identity.json'), JSON.stringify({ digest, version: '1.0.0' }));
  const old = path.join(root, 'old.mjs'); fs.writeFileSync(old, verifier);
  const pointer = Buffer.from(JSON.stringify({ entrypoint: old, digest: 'original' }));
  fs.writeFileSync(path.join(root, 'current-release.json'), pointer);
  for (const name of ['rabi-agent-launcher.mjs', 'hook-client.mjs']) fs.writeFileSync(path.join(root, name), '// unchanged');
  const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, JSON.stringify({ nodeId: 'fixture', releasePublicKeySha256: fingerprint }));
  const manifestPath = path.join(root, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, pointer, target, options: { configPath, manifestPath, releaseDirectory: target, expectedPointerSha256: sha256(pointer), expectedManifestSha256: sha256(fs.readFileSync(manifestPath)), expectedVerifierSha256: sha256(verifier), expectedNodeId: 'fixture', expectedAssetCount: 2, snapshotDir: path.join(root, 'snapshot'), assertOwnerAbsent: async () => {} } };
}
for (const scenario of ['success', 'signature', 'asset', 'busy', 'cas', 'owner', 'readback-failure']) {
  test('cold release adoption: ' + scenario, async t => {
    const f = fixture(); let server;
    try {
      if (scenario === 'signature') { const m = JSON.parse(fs.readFileSync(f.options.manifestPath)); m.signature = Buffer.alloc(64).toString('base64'); fs.writeFileSync(f.options.manifestPath, JSON.stringify(m)); f.options.expectedManifestSha256 = sha256(fs.readFileSync(f.options.manifestPath)); }
      if (scenario === 'asset') fs.appendFileSync(path.join(f.target, 'lib/example.mjs'), 'bad');
      if (scenario === 'cas') f.options.expectedPointerSha256 = '0'.repeat(64);
      if (scenario === 'owner') f.options.assertOwnerAbsent = async () => { throw Error('owner alive'); };
      if (scenario === 'busy') { server = net.createServer(); await new Promise(resolve => server.listen(launcherLeaseTarget(f.options.configPath), resolve)); }
      if (scenario === 'readback-failure') {
        const originalRead = fs.readFileSync, originalRename = fs.renameSync;
        let failRead = false;
        t.mock.method(fs, 'renameSync', (...args) => { const result = originalRename(...args); failRead = args[1] === path.join(f.root, 'current-release.json'); return result; });
        t.mock.method(fs, 'readFileSync', (...args) => {
          if (failRead && args[0] === path.join(f.root, 'current-release.json')) { failRead = false; throw Error('Injected committed readback failure'); }
          return originalRead(...args);
        });
      }
      if (scenario === 'success') {
        const result = await adoptColdRelease(f.options); assert.equal(result.adopted, true);
        assert.deepEqual(fs.readFileSync(path.join(f.options.snapshotDir, 'current-release.json')), f.pointer);
        assert.equal(fs.readFileSync(path.join(f.root, 'hook-client.mjs'), 'utf8'), '// unchanged');
        const next = { ...f.options, expectedPointerSha256: result.pointerSha256 };
        assert.equal((await adoptColdRelease(next)).unchanged, true);
      } else {
        await assert.rejects(adoptColdRelease(f.options));
        t.mock.restoreAll();
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'current-release.json')), f.pointer);
      }
    } finally { if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
