import { execFile, spawn } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const appId = 'io.rabiroute.windows';
const shaPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const compareVersion = (left, right) => left.split('.').map(Number).reduce((comparison, part, index) => comparison || part - Number(right.split('.')[index]), 0);

function trustedUrl(value, origin) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (origin && origin !== url.origin)) throw new Error('UPGRADE_UNTRUSTED_URL');
  return url;
}

export function resolveSignedUpgrade(envelope, policy, current, now = Date.now()) {
  const origin = trustedUrl(policy.manifestUrl).origin;
  const key = createPublicKey(policy.publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof envelope?.payload !== 'string' || envelope.payload.length > 240000
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error('UPGRADE_BAD_SIGNATURE');
  const signed = Buffer.from(envelope.payload, 'base64url');
  if (!verify(null, signed, key, Buffer.from(envelope.signature, 'base64url'))) throw new Error('UPGRADE_BAD_SIGNATURE');
  const body = JSON.parse(signed.toString('utf8'));
  if (body.schemaVersion !== 1 || body.appId !== appId || body.channel !== policy.channel || body.platform !== 'win32-x64'
    || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || body.issuedAt > now + 60_000
    || body.expiresAt <= now || body.expiresAt - body.issuedAt > 30 * 86_400_000
    || !Array.isArray(body.releases) || body.releases.length > 100) throw new Error('UPGRADE_INVALID_MANIFEST');
  const releases = new Map();
  for (const release of body.releases) {
    if (!versionPattern.test(release.version) || !shaPattern.test(release.payloadSha256) || !shaPattern.test(release.installerSha256)
      || release.releaseId !== `${release.version}-${release.payloadSha256.slice(0, 12)}` || releases.has(release.releaseId)
      || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > 4 * 1024 ** 3) throw new Error('UPGRADE_INVALID_RELEASE');
    releases.set(release.releaseId, { ...release, installerUrl: trustedUrl(release.installerUrl, origin).href });
  }
  const target = releases.get(body.latest);
  const currentVersion = current.releaseId.split('-')[0];
  if (!target || !versionPattern.test(currentVersion)) throw new Error('UPGRADE_UNKNOWN_VERSION');
  if (compareVersion(target.version, currentVersion) <= 0) return undefined;
  const previous = releases.get(current.releaseId);
  if (previous?.payloadSha256 !== current.payloadSha256) throw new Error('UPGRADE_ROLLBACK_ARTIFACT_MISSING');
  return { target, previous };
}

const exactRelease = (actual, expected) => actual.releaseId === expected.releaseId && actual.payloadSha256 === expected.payloadSha256;

export async function applySignedUpgrade(plan, owner) {
  const installed = await owner.current();
  if (!exactRelease(installed, plan.previous) || !installed.generation) throw new Error('UPGRADE_ORIGINAL_HOST_CHANGED');
  const rollback = await owner.stage(plan.previous);
  const candidate = await owner.stage(plan.target);
  const before = await owner.current();
  if (!exactRelease(before, plan.previous) || installed.generation !== before.generation) throw new Error('UPGRADE_ORIGINAL_HOST_CHANGED');
  await owner.record({ state: 'installing', releaseId: plan.target.releaseId, previousReleaseId: plan.previous.releaseId });
  try {
    await owner.install(candidate);
    await owner.ready(plan.target, before.generation);
  } catch (error) {
    const pointer = await owner.pointer();
    if (!exactRelease(pointer, plan.target) && !exactRelease(pointer, plan.previous)) throw new Error('UPGRADE_OWNER_CHANGED_DURING_SWITCH');
    if (exactRelease(pointer, plan.previous)) {
      const active = await Promise.resolve().then(() => owner.current()).catch(() => undefined);
      if (active?.generation === before.generation) throw error;
    }
    await owner.record({ state: 'rolling_back', releaseId: plan.target.releaseId, previousReleaseId: plan.previous.releaseId });
    await owner.install(rollback);
    await owner.ready(plan.previous, before.generation);
    await owner.record({ state: 'rolled_back', releaseId: plan.target.releaseId, previousReleaseId: plan.previous.releaseId });
    return 'rolled_back';
  }
  await owner.record({ state: 'completed', releaseId: plan.target.releaseId, previousReleaseId: plan.previous.releaseId });
  return 'completed';
}

export async function stageSignedInstaller(release, directory, request = fetch) {
  const target = path.join(directory, `${release.releaseId}-${randomUUID()}.exe`);
  const response = await request(release.installerUrl, { redirect: 'error', signal: AbortSignal.timeout(1800000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('UPGRADE_DOWNLOAD_FAILED'); }
  let size = 0;
  const hash = createHash('sha256');
  const measure = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > release.size) { callback(new Error('UPGRADE_SIZE_MISMATCH')); return; }
    hash.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if (size !== release.size || hash.digest('hex') !== release.installerSha256) throw new Error('UPGRADE_DIGEST_MISMATCH');
    return target;
  } catch (error) { await rm(target, { force: true }).catch(() => {}); throw error; }
}

async function main(installRoot, launchedReleaseId) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !path.isAbsolute(installRoot)) throw new Error('UPGRADE_UNSUPPORTED_HOST');
  const data = path.join(installRoot, 'data', 'rabilink');
  const policy = JSON.parse(await readFile(path.join(data, 'host-upgrade.json'), 'utf8'));
  if (policy.enabled !== true) return;
  const directory = path.join(data, 'host-upgrade');
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, 'running');
  await mkdir(lock);
  const staged = [];
  const statusFile = path.join(directory, 'status.json');
  const record = async status => {
    const target = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(target, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    await rename(target, statusFile);
  };
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RABIROUTE_|GATEWAY_MANAGER_|REMOTE_AGENT_)/i.test(key)));
  const bootstrap = path.join(installRoot, 'RabiRouteHost.exe');
  const pointer = async () => {
    const result = JSON.parse(await readFile(path.join(installRoot, 'current.json'), 'utf8'));
    if (result.appId !== appId || !shaPattern.test(result.payloadSha256)) throw new Error('UPGRADE_INVALID_INSTALL_POINTER');
    return result;
  };
  const current = async () => {
    const installed = await pointer();
    const host = JSON.parse((await run(bootstrap, ['--command', 'status', '--json'], { windowsHide: true, timeout: 10000, env: environment })).stdout);
    if (host.ok !== true) throw new Error('UPGRADE_HOST_STATUS_UNAVAILABLE');
    return { ...installed, generation: host.applicationGenerationId, manager: host.managerBaseUrl, managerInstanceId: host.managerInstanceId };
  };
  async function ready(release, originalGeneration) {
    const activation = spawn(bootstrap, ['--command', 'activate'], { cwd: installRoot, windowsHide: true, detached: true, stdio: 'ignore', env: environment });
    activation.on('error', () => {});
    activation.unref();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try {
        const host = await current();
        if (!exactRelease(host, release)) throw new Error('UPGRADE_WRONG_RELEASE');
        if (host.generation && host.generation !== originalGeneration && host.manager) {
          const endpoint = new URL(host.manager);
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('UPGRADE_MANAGER_NOT_LOCAL');
          const meta = await fetch(new URL('/meta', endpoint), { signal: AbortSignal.timeout(4000), redirect: 'error' });
          const result = meta.ok && await meta.json();
          if (result?.health?.live && result.health.requiredReady && result.version === release.version
            && result.applicationGenerationId === host.generation && result.managerInstanceId === host.managerInstanceId) return;
        }
      } catch { /* Wait for the installed Host to publish its authoritative Manager. */ }
      await delay(1000);
    }
    throw new Error('UPGRADE_NEW_GENERATION_NOT_READY');
  }
  try {
    const original = await pointer();
    if (original.releaseId !== launchedReleaseId) return;
    const result = await fetch(trustedUrl(policy.manifestUrl), { redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!result.ok || !result.body) { await result.body?.cancel(); throw new Error('UPGRADE_MANIFEST_UNAVAILABLE'); }
    const chunks = [];
    let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > 256000) throw new Error('UPGRADE_MANIFEST_TOO_LARGE');
      chunks.push(chunk);
    }
    const plan = resolveSignedUpgrade(JSON.parse(Buffer.concat(chunks).toString('utf8')), policy, original);
    if (!plan) return;
    let last;
    try { last = JSON.parse(await readFile(statusFile, 'utf8')); } catch { /* First run. */ }
    if (last?.releaseId === plan.target.releaseId && ['installing', 'rolling_back', 'rolled_back', 'failed'].includes(last.state)) return;
    await applySignedUpgrade(plan, {
      current, pointer, ready, record,
      async stage(release) { const artifact = await stageSignedInstaller(release, directory); staged.push(artifact); return artifact; },
      async install(artifact) {
        await run(artifact, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${installRoot}`], { cwd: directory, windowsHide: true, timeout: 1200000, env: environment });
      }
    });
  } catch (error) {
    const previous = await readFile(statusFile, 'utf8').then(JSON.parse).catch(() => ({}));
    await record({ state: 'failed', releaseId: previous.releaseId, previousReleaseId: previous.previousReleaseId,
      code: /^[A-Z_]+$/.test(error.message || '') ? error.message : 'UPGRADE_LIFECYCLE_FAILED' });
    throw error;
  } finally {
    await Promise.allSettled(staged.map(file => rm(file, { force: true })));
    await rmdir(lock);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
}
