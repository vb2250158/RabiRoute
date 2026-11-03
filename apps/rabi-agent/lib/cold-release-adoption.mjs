import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function launcherLeaseTarget(configPath) {
  const canonical = fs.realpathSync(configPath);
  const hash = sha256(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  return process.platform === 'win32' ? `\\\\.\\pipe\\rabi-agent-${hash}`
    : { host: '127.0.0.1', port: 16384 + (Number.parseInt(hash.slice(0, 8), 16) % 16384), exclusive: true };
}
function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Expected an unlinked regular file: ' + filename);
  return fs.readFileSync(filename);
}
function payload(m) {
  return JSON.stringify({ version: m.version, platform: m.platform, minNodeVersion: m.minNodeVersion,
    files: m.files.map(f => ({ path: f.path, sha256: f.sha256, size: f.size, downloadUrl: f.downloadUrl })) });
}
function version(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw Error('Invalid Node version');
  return value.split('.').map(Number);
}

/** Cold selection only. The caller must prove the original owner is absent; no process is started or stopped. */
export async function adoptColdRelease(options) {
  const { expectedPointerSha256, expectedManifestSha256, expectedVerifierSha256, expectedNodeId,
    expectedAssetCount, snapshotDir, assertOwnerAbsent } = options;
  if (typeof assertOwnerAbsent !== 'function') throw Error('An original-owner absence check is required');
  const configPath = fs.realpathSync(options.configPath), root = path.dirname(configPath);
  const pointerPath = path.join(root, 'current-release.json');
  const lease = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { lease.once('error', reject); lease.listen(launcherLeaseTarget(configPath), resolve); });
  try {
    await assertOwnerAbsent();
    const configBytes = regular(configPath), config = JSON.parse(configBytes);
    if (config.nodeId !== expectedNodeId) throw Error('Original node identity changed');
    const original = regular(pointerPath), pointer = JSON.parse(original);
    if (sha256(original) !== expectedPointerSha256) throw Error('Pointer CAS conflict');
    const verifier = fs.realpathSync(pointer.entrypoint);
    if (sha256(regular(verifier)) !== expectedVerifierSha256) throw Error('Original verifier bytes changed');
    const manifestBytes = regular(options.manifestPath);
    if (sha256(manifestBytes) !== expectedManifestSha256) throw Error('Frozen manifest bytes changed');
    const manifest = JSON.parse(manifestBytes);
    const { verifyReleaseManifest } = await import(pathToFileURL(verifier).href);
    if (typeof verifyReleaseManifest !== 'function' || !verifyReleaseManifest(manifest, config.releasePublicKeySha256)) throw Error('Release signature rejected');
    if (manifest.files.length !== expectedAssetCount) throw Error('Frozen asset count changed');
    const have = version(process.versions.node), need = version(manifest.minNodeVersion);
    const difference = have.map((v, i) => v - need[i]).find(v => v !== 0) ?? 0;
    if (difference < 0) throw Error('Node version is too old');
    const digest = sha256(payload(manifest));
    const target = fs.realpathSync(options.releaseDirectory);
    const releases = fs.realpathSync(path.join(root, 'releases'));
    if (target !== path.join(releases, `${manifest.version}-${digest}`)) throw Error('Release directory identity mismatch');
    const names = new Set();
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(file.path)) throw Error('Invalid asset path');
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
      if (names.has(key)) throw Error('Duplicate asset path'); names.add(key);
      const filename = path.join(target, file.path);
      if (fs.realpathSync(filename) !== filename) throw Error('Asset path has an alias');
      const bytes = regular(filename);
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw Error('Asset integrity mismatch: ' + file.path);
    }
    if (!names.has('rabi-agent.mjs')) throw Error('Release entry is missing');
    const installed = JSON.parse(regular(path.join(target, 'release-identity.json')));
    if (installed.digest !== digest || installed.version !== manifest.version) throw Error('Installed release identity mismatch');
    const entrypoint = path.join(target, 'rabi-agent.mjs');
    if (pointer.entrypoint === entrypoint && pointer.digest === digest) return { adopted: true, unchanged: true, digest, pointerSha256: sha256(original) };
    fs.mkdirSync(snapshotDir, { mode: 0o700 });
    for (const [name, filename] of [['current-release.json', pointerPath], ['config.json', configPath], ['rabi-agent-launcher.mjs', path.join(root, 'rabi-agent-launcher.mjs')], ['hook-client.mjs', path.join(root, 'hook-client.mjs')]]) {
      fs.writeFileSync(path.join(snapshotDir, name), regular(filename), { flag: 'wx', mode: 0o600 });
    }
    await assertOwnerAbsent();
    if (sha256(regular(pointerPath)) !== expectedPointerSha256 || sha256(regular(configPath)) !== sha256(configBytes)) throw Error('Owner configuration changed before commit');
    const next = Buffer.from(JSON.stringify({ entrypoint, digest, updatedAt: new Date().toISOString() }) + '\n');
    const temporary = pointerPath + '.' + randomUUID() + '.tmp';
    let committed = false;
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, pointerPath); committed = true;
      if (!regular(pointerPath).equals(next)) throw Error('Pointer readback mismatch');
      return { adopted: true, unchanged: false, digest, pointerSha256: sha256(next), snapshotDir };
    } catch (error) {
      if (committed && fs.existsSync(pointerPath) && regular(pointerPath).equals(next)) {
        fs.writeFileSync(temporary, original, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, pointerPath);
      }
      throw error;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  } finally { await new Promise((resolve, reject) => lease.close(error => error ? reject(error) : resolve())); }
}
