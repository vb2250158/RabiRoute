import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RabiLinkDeviceConnections, type ConnectionDirectory } from './rabiLinkDeviceConnections.js';

test('immutable device and application owners survive restart and offline use, conflict leaves snapshot intact', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-connection-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let calls = 0, scope = 'scope-one', offline = false;
  let directory: ConnectionDirectory = { connectionOwnerDeviceId: 'pc-a', devices: [{ id: 'glasses', connectionTargetDeviceId: 'pc-a' }] };
  const create = () => new RabiLinkDeviceConnections({ dataDir, scope: () => scope, readConnections: async () => { calls++; if (offline) throw new Error('offline'); return directory; } });
  let cache = create();
  assert.deepEqual(await Promise.all([cache.deviceTarget('glasses'), cache.applicationTarget()]), ['pc-a', 'pc-a']);
  assert.equal(calls, 1);
  offline = true; cache = create();
  assert.equal(await cache.deviceTarget('glasses'), 'pc-a'); assert.equal(await cache.applicationTarget(), 'pc-a'); assert.equal(calls, 1);
  await assert.rejects(cache.deviceTarget('new-device'), /offline/);
  offline = false; directory = { connectionOwnerDeviceId: 'pc-a', devices: [{ id: 'glasses', connectionTargetDeviceId: 'pc-b' }, { id: 'new-device', connectionTargetDeviceId: 'pc-b' }] };
  await assert.rejects(cache.deviceTarget('new-device'), /CONNECTION_OWNER_CHANGED/);
  assert.equal(await create().deviceTarget('glasses'), 'pc-a');
  scope = 'scope-two'; assert.equal(await cache.deviceTarget('glasses'), 'pc-b');
  directory = { devices: [] };
  await assert.rejects(cache.deviceTarget('constructor'), /CONNECTION_DEVICE_UNKNOWN/);
  const stored = path.join(dataDir, 'rabilink-connection-assignments');
  fs.writeFileSync(path.join(stored, fs.readdirSync(stored)[0]), '{broken');
  scope = 'scope-one'; await assert.rejects(create().deviceTarget('glasses'));
});

test('scope switch during discovery cannot persist assignments into either application', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-connection-fence-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let scope = 'old'; let finish!: (value: ConnectionDirectory) => void;
  const cache = new RabiLinkDeviceConnections({ dataDir, scope: () => scope, readConnections: () => new Promise(resolve => { finish = resolve; }) });
  const pending = cache.deviceTarget('glasses'); scope = 'new'; finish({ devices: [{ id: 'glasses', connectionTargetDeviceId: 'pc-a' }] });
  await assert.rejects(pending, /CONNECTION_SCOPE_CHANGED/);
  assert.equal(fs.existsSync(path.join(dataDir, 'rabilink-connection-assignments')), false);
});
