import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverWindowsHostIdentity } from './windows-host-discovery.mjs';
const id = { managerBaseUrl: 'http://127.0.0.1:51234', applicationGenerationId: 'g', managerInstanceId: 'i' };
const fetch = async () => ({ ok: true, json: async () => ({ ...id, health: { live: true, requiredReady: true, state: 'healthy' } }) });
const missingFile = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
test('custom installation is discovered from exact running Host and verified', async () => {
  const calls = [];
  const result = await discoverWindowsHostIdentity({ platform: 'win32', env: { LOCALAPPDATA: 'C:/fixture' }, readFile: missingFile, fetch, execFile: async (file, args) => {
    calls.push(file);
    if (file === 'powershell.exe') { assert.match(args.at(-1), /Name = 'RabiRouteHost.exe'/); return { stdout: JSON.stringify('G:/custom/RabiRouteHost.exe') }; }
    if (file === 'G:/custom/RabiRouteHost.exe') { assert.deepEqual(args, ['--command', 'status', '--json']); return { stdout: JSON.stringify({ ok: true, ...id }) }; }
    return missingFile();
  } });
  assert.deepEqual(result, id); assert.equal(calls.length, 3);
});
test('missing configured installation stays on the selected owner and reports discovery failure', async () => {
  const calls = [];
  await assert.rejects(discoverWindowsHostIdentity({ env: { RABIROUTE_HOST_EXE: 'C:/missing/Host.exe' }, readFile: missingFile, fetch, execFile: async file => { calls.push(file); return missingFile(); } }), /Host availability is unconfirmed/);
  assert.deepEqual(calls, ['C:/missing/Host.exe']);
});
test('explicit URL verifies identity without process discovery', async () => {
  assert.deepEqual(await discoverWindowsHostIdentity({ env: { RABI_MANAGER_URL: id.managerBaseUrl }, fetch, execFile: () => { throw new Error('not expected'); } }), id);
});
test('configured endpoint descriptor is checked against current meta', async () => {
  const options = { env: { RABIROUTE_MANAGER_ENDPOINT_FILE: 'C:/fixture/endpoint.json', RABIROUTE_HOST_EXE: 'C:/fixture/Host.exe' }, fetch,
    readFile: async () => JSON.stringify({ schemaVersion: 1, ...id }), execFile: missingFile };
  assert.deepEqual(await discoverWindowsHostIdentity(options), id);
  await assert.rejects(discoverWindowsHostIdentity({ ...options, readFile: async () => JSON.stringify({ schemaVersion: 1, ...id, managerInstanceId: 'stale' }) }), /unconfirmed/);
});
test('distributed plugin discovery sources match the canonical implementation', async () => {
  const source = await fs.readFile(new URL('./windows-host-discovery.mjs', import.meta.url), 'utf8');
  for (const name of ['codex', 'workbuddy', 'antigravity']) assert.equal(await fs.readFile(new URL(`../../plugins/rabi-${name}-context/scripts/lib/windows-host-discovery.mjs`, import.meta.url), 'utf8'), source);
});

test('adapter distribution copies every module needed to import Manager discovery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-discovery-distribution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = ['copy-agent-adapter-resources.mjs', 'grok-bot-native-profile.ps1', 'resolve-manager.mjs', 'lib/discover-manager-url.mjs', 'lib/windows-host-discovery.mjs', 'lib/timeout-settings.mjs'];
  for (const name of resources) {
    const target = path.join(root, 'scripts', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(new URL(`../${name}`, import.meta.url), target);
  }
  await promisify(execFileCallback)(process.execPath, [path.join(root, 'scripts/copy-agent-adapter-resources.mjs')], { windowsHide: true });
  const module = await import(pathToFileURL(path.join(root, 'dist/scripts/lib/discover-manager-url.mjs')).href);
  assert.equal(typeof module.discoverManagerIdentity, 'function');
  assert.equal(await fs.readFile(path.join(root, 'dist/scripts/lib/windows-host-discovery.mjs'), 'utf8'), await fs.readFile(new URL('./windows-host-discovery.mjs', import.meta.url), 'utf8'));
});
