import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const install = path.resolve(process.argv[2] || '');
const pointerFile = path.join(install, 'current.json');
const pointer = JSON.parse(readFileSync(pointerFile, 'utf8'));
assert.match(pointer.releaseId, /^0\.15\.31-[a-f0-9]+$/);
assert.equal(pointer.versionPath, `versions/${pointer.releaseId}`);
const packageRoot = path.join(install, pointer.versionPath);
const entry = path.join(packageRoot, 'dist/manager/controlPlaneRoutes.js');
const installedWorker = path.join(packageRoot, 'dist/manager/rabiLinkRelayRuntime.js');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const pins = { pointer: sha(pointerFile), manager: sha(entry), worker: sha(installedWorker) };
const fixture = mkdtempSync(path.join(os.tmpdir(), 'rabilink-031-account-'));
const owned = [];

function start(executable, args, env) {
  const child = spawn(executable, args, { cwd: fixture, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { child, output: '', error: '' };
  child.stdout.on('data', bytes => { job.output = (job.output + bytes).slice(-12000); });
  child.stderr.on('data', bytes => { job.error = (job.error + bytes).slice(-12000); });
  owned.push(job);
  return job;
}

async function until(label, job, probe, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (job.child.exitCode !== null) throw new Error(`${label} exited ${job.child.exitCode}\n${job.error}`);
    const found = await probe();
    if (found) return found;
    await delay(100);
  }
  throw new Error(`${label} timed out\n${job.output.slice(-2200)}\n${job.error.slice(-2200)}`);
}

async function json(base, target, { body, headers, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${base}${target}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(28000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie') };
}

try {
  const relay = start(process.execPath, [path.resolve('scripts/rabilink-relay-server.mjs')], {
    HOST: '127.0.0.1', PORT: '0', RABILINK_RELAY_DATA_DIR: path.join(fixture, 'relay')
  });
  const relayUrl = await until('Relay', relay, () => {
    const ready = /^RABILINK_RELAY_READY:(.+)$/m.exec(relay.output);
    return ready && `http://127.0.0.1:${JSON.parse(ready[1]).port}`;
  });
  const credentials = { username: 'legacy-fixture-owner', password: randomUUID() };
  const owner = await json(relayUrl, '/manage/api/accounts', { body: credentials });
  assert.equal(owner.status, 200);
  const app = await json(relayUrl, '/manage/api/apps', { body: { name: 'Installed 031 fixture' }, headers: { cookie: owner.cookie.split(';')[0] } });
  assert.equal(app.status, 200);
  const oldState = path.join(fixture, 'old-state');
  for (const dir of ['roles', 'route']) mkdirSync(path.join(oldState, 'data', dir), { recursive: true });
  const fixtureGuid = randomUUID();
  writeFileSync(path.join(oldState, 'data/Config.json'), JSON.stringify({
    rabiGuid: fixtureGuid, rabiName: 'Installed package fixture',
    rabiLinkRelay: { enabled: true, url: relayUrl, token: app.value.app.token, deviceId: 'legacy-fixture-pc' }
  }), { mode: 0o600 });
  const old = start(path.join(packageRoot, 'node.exe'), ['--input-type=module', '-e', `const { startManager } = await import(${JSON.stringify(pathToFileURL(entry).href)}); await startManager();`], {
    RABIROUTE_HOSTED: '0', RABIROUTE_PACKAGE_ROOT: packageRoot, RABIROUTE_STATE_ROOT: oldState,
    RABIROUTE_MANAGER_READ_ONLY: '0', RABIROUTE_MANAGER_AUTOSTART: '1', REMOTE_AGENT_DISCOVERABLE: '0',
    GATEWAY_MANAGER_HOST: '127.0.0.1', GATEWAY_MANAGER_PORT: '0', GATEWAY_MANAGER_URL: '',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1'
  });
  const address = await until('Installed 031 Manager', old, () => /gateway-manager listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(old.output)?.[1]);
  await until('Installed 031 route control', old, async () => (await json(address, '/api/rabi/link-home')).status === 200);
  const saved = await json(address, '/api/rabi/identity', { method: 'PATCH', body: {
    rabiLinkRelay: { enabled: true, url: relayUrl, token: app.value.app.token, deviceId: 'legacy-fixture-pc' }
  } });
  assert.equal(saved.status, 200, 'The 031 Manager must accept the normal saved connection settings');
  const newDevice = await json(relayUrl, '/api/rabilink/host-account/login', { body: { ...credentials,
    deviceId: 'account-fixture-pc', deviceGuid: randomUUID(), deviceName: 'Account fixture PC' } });
  assert.equal(newDevice.status, 200);
  const accountHeaders = { 'x-rabilink-token': newDevice.value.data.token };
  const oldPeer = await until('Installed 031 Relay worker', old, async () => {
    const directory = await json(relayUrl, '/api/rabilink/peers', { headers: accountHeaders });
    return directory.value.peers?.find(peer => peer.legacy && peer.online && peer.guid === fixtureGuid);
  });
  const query = '/api/search?scope=operations&q=manager&limit=5';
  const local = await until('Installed 031 search operation', old, async () => {
    const found = await json(address, query);
    return found.status === 200 && found.value.data?.items?.length ? found : undefined;
  });
  const forwarded = await json(relayUrl, '/api/rabilink/device/api', { headers: accountHeaders, body: {
    targetDeviceId: oldPeer.id, request: { method: 'GET', path: query, headers: { accept: 'application/json' } }
  } });
  const outcome = forwarded.value.data?.structuredContent;
  assert.equal(forwarded.status, 200);
  assert.equal(outcome?.statusCode, 200);
  const actual = JSON.parse(Buffer.from(outcome.data.bodyBase64, 'base64').toString('utf8'));
  const operationIds = result => result.data.items.map(item => item.handle?.operationId ?? item.label);
  assert.deepEqual(operationIds(actual), operationIds(local.value));
  assert.equal(sha(pointerFile), pins.pointer);
  assert.equal(sha(entry), pins.manager);
  assert.equal(sha(installedWorker), pins.worker);
  console.log(JSON.stringify({ release: pointer.releaseId, payloadSha256: pointer.payloadSha256, pins,
    oldManagerPid: old.child.pid, relayPid: relay.child.pid, oldWorkerCapability: oldPeer.capabilities.find(item => item.startsWith('rabi-pc-version-')),
    businessPath: query, httpStatus: outcome.statusCode, matchedOperations: operationIds(actual) }, null, 2));
} finally {
  await Promise.allSettled(owned.map(async ({ child }) => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }));
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  try { rmSync(fixture, { recursive: true, force: true, maxRetries: 4 }); }
  catch (error) { console.error(`Temporary fixture retained at ${fixture} (${error.code}).`); }
}
