import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createManagerClient } from '../lib/manager-client.mjs';

const meta = { applicationGenerationId: 'fixture-generation', managerInstanceId: 'fixture-manager', health: { live: true, requiredReady: true, state: 'healthy' } };
const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 1, 2]);
const skillPath = '/api/roles/example/skills/example/download';
const zipHeaders = { 'content-type': 'application/zip', 'content-length': String(zip.length), 'x-rabiroute-content-sha256': createHash('sha256').update(zip).digest('hex') };
function clientFixture(localHost, respond) {
  const calls = [];
  const client = createManagerClient({ managerUrl: 'http://127.0.0.1:1', ...(localHost ? { localHost: true, endpointSession: { ensure: async () => ({ managerUrl: 'http://127.0.0.1:1', meta }) } } : { credential: 'fixture-only' }), fetchImpl: async (url, options) => {
    const target = new URL(url).pathname; calls.push({ target, options });
    return target === '/meta' ? Response.json(meta) : respond(target, options);
  } });
  return { client, calls };
}

test('JSON text and bytes retain failure and unknown write outcomes without replay', async () => {
  for (const responseMode of ['text', 'bytes']) {
    const { client, calls } = clientFixture(false, () => Response.json({ code: -1, uncertain: true, mutationOutcome: 'unknown' }, { status: 200 }));
    const receipt = await client.request('PUT', '/fixture', { body: { value: 'fixture' }, responseMode });
    assert.equal(receipt.ok, false); assert.equal(receipt.uncertain, true); assert.equal(receipt.bodyJson.mutationOutcome, 'unknown');
    assert.equal(calls.filter(call => call.target === '/fixture').length, 1);
  }
});

test('verified local Host and standalone enrolled clients submit the original thread request to Manager without fictitious source identity', async () => {
  for (const local of [true, false]) {
    const payload = { action: 'send', threadId: 'original-target', prompt: 'fixture only', deliveryId: 'original-delivery' };
    const { client, calls } = clientFixture(local, (_target, options) => {
      assert.deepEqual(JSON.parse(options.body), payload);
      assert.equal(options.headers['x-rabiroute-agent-type'], undefined);
      assert.equal(options.headers['x-rabiroute-session-id'], undefined);
      assert.equal(options.headers.authorization, local ? undefined : 'Bearer fixture-only');
      return Response.json({ code: 0, deliveryId: payload.deliveryId, status: 'pending' }, { status: 202 });
    });
    const receipt = await client.request('POST', '/api/agent/threads', { body: payload });
    assert.equal(receipt.statusCode, 202); assert.equal(receipt.bodyJson.deliveryId, payload.deliveryId);
    assert.equal(calls.filter(call => call.target === '/api/agent/threads').length, 1);
  }
});

test('local and enrolled skill downloads support raw bytes/stream and explicit verified output through the original download owner', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-public-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const local of [true, false]) {
    const { client, calls } = clientFixture(local, (_target, options) => {
      assert.equal(options.headers.authorization, local ? undefined : 'Bearer fixture-only');
      return new Response(zip, { headers: zipHeaders });
    });
    const raw = await client.request('GET', skillPath, { responseMode: 'bytes' });
    assert.deepEqual(raw.bodyBytes, zip);
    const chunks = [];
    const stream = await client.request('GET', skillPath, { responseMode: 'stream', onChunk: chunk => chunks.push(chunk) });
    assert.equal(stream.ok, true); assert.deepEqual(Buffer.concat(chunks), zip);
    const outputPath = path.join(directory, `chosen-${local}.zip`);
    const saved = await client.request('GET', skillPath, { outputPath });
    assert.equal(saved.ok, true); assert.equal(saved.sha256, zipHeaders['x-rabiroute-content-sha256']);
    assert.deepEqual(await fs.readFile(outputPath), zip);
    assert.equal(calls.filter(call => call.target === skillPath).length, 3);
  }
});

test('the catalog exposes its original cache and retires it on the existing invalidation events', async () => {
  const operations = [{ id: 'fixture.public', contractDigest: 'sha256:' + 'a'.repeat(64), contract: { operationId: 'fixture.public', contractVersion: '1.0.0', method: 'GET', pathTemplate: '/fixture', transport: 'http' } }];
  const { client, calls } = clientFixture(false, target => Response.json(target === '/api/agent/help' ? { code: 0, data: { schemaVersion: '2', ...meta, pluginGenerationId: 'fixture', catalogRevision: 1, catalogDigest: 'sha256:' + 'b'.repeat(64), operations } } : { code: 0 }));
  assert.equal(client.catalog.getSnapshot(), undefined);
  const snapshot = await client.catalog.refresh();
  assert.equal(client.catalog.getSnapshot(), snapshot); assert.equal(Object.isFrozen(snapshot), true);
  await client.invokeOperation('fixture.public'); await client.invokeOperation('fixture.public');
  assert.equal(calls.filter(call => call.target === '/api/agent/help').length, 1);
  client.catalog.handleEvent({ type: 'api.catalog.changed' });
  assert.equal(client.catalog.getSnapshot(), undefined);
});
