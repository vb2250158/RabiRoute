import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { __test } from '../rabi-agent.mjs';

test('real update candidate exits before READY without changing active pointer or shared Hook bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-ready-failure-'));
  const savedFetch = globalThis.fetch;
  const savedNpm = process.env.npm_execpath;
  try {
    const configPath = path.join(root, 'config.json');
    const oldRoot = path.join(root, 'old');
    fs.mkdirSync(path.join(oldRoot, 'lib'), { recursive: true });
    const oldEntry = path.join(oldRoot, 'rabi-agent.mjs');
    fs.writeFileSync(oldEntry, '');
    fs.writeFileSync(path.join(oldRoot, 'lib', 'instance-hook.mjs'), 'export async function requestInstanceHook(){ return "old-hook"; }');
    __test.writeCurrentRelease(configPath, oldEntry, 'a'.repeat(64));
    __test.writeLauncher(configPath);
    // A legacy shared copy must remain untouched, even though the new shim does not use it.
    fs.writeFileSync(path.join(root, 'manager-client.mjs'), '// old shared transport fixture');
    const preserved = ['current-release.json', 'hook-client.mjs', 'manager-client.mjs', 'rabi-agent-launcher.mjs'];
    const before = new Map(preserved.map(name => [name, fs.readFileSync(path.join(root, name))]));
    const hook = await import(pathToFileURL(path.join(root, 'hook-client.mjs')).href);
    const dependencyMarker = path.join(root, 'dependency-script-ran');
    const candidateMarker = path.join(root, 'candidate-ran');
    const fakeNpm = path.join(root, 'fake-npm.mjs');
    fs.writeFileSync(fakeNpm, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(dependencyMarker)}, 'fixture'); process.exit(0);`);
    process.env.npm_execpath = fakeNpm;
    const bytes = Buffer.from(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(candidateMarker)}, 'fixture'); process.exit(1);`);
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const release = {
      version: '0.2.0', platform: 'node', minNodeVersion: '22.0.0', publicKey,
      publicKeySha256: __test.publicKeySha256(publicKey),
      files: [{ path: 'rabi-agent.mjs', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), downloadUrl: '/api/lan-agent/releases/0.2.0/node/rabi-agent.mjs' }]
    };
    release.signature = sign(null, Buffer.from(__test.manifestPayload(release)), keys.privateKey).toString('base64');
    let requests = 0;
    globalThis.fetch = async url => {
      requests++;
      const pathname = new URL(url).pathname;
      if (pathname === '/api/lan-agent/releases/manifest') return Response.json({ release });
      assert.equal(pathname, release.files[0].downloadUrl);
      return new Response(bytes);
    };
    const runtime = new __test.RabiAgentRuntime({ nodeId: 'fixture-node', managerUrl: 'http://manager.invalid', nodeCredential: 'fixture-credential', releasePublicKeySha256: release.publicKeySha256 }, configPath);
    runtime.connected = true;
    const events = [];
    runtime.send = event => events.push(event);
    await assert.rejects(runtime.update('0.2.0'), /did not connect.*current version remains active/);
    assert.equal(requests, 2);
    assert.ok(fs.existsSync(dependencyMarker));
    assert.ok(fs.existsSync(candidateMarker));
    assert.equal(runtime.stopped, false);
    assert.deepEqual(events.map(event => event.status), ['updating']);
    for (const name of preserved) assert.deepEqual(fs.readFileSync(path.join(root, name)), before.get(name), name);
    assert.equal(await hook.requestInstanceHook({}, configPath), 'old-hook');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedNpm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = savedNpm;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
