import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../rabi-cli.mjs';
import { createManagerClient } from '../lib/manager-client.mjs';
import { createOperationTools } from '../../rabi-mcp/lib/operation-tools.mjs';

const managerUrl = 'http://127.0.0.1:1';
const meta = { applicationGenerationId: 'local-fixture-generation', managerInstanceId: 'local-fixture-manager',
  health: { live: true, requiredReady: true, state: 'healthy' } };
const contract = { operationId: 'manager.agent.threads.action', contractVersion: '1.0.0', method: 'POST', transport: 'http',
  pathTemplate: '/api/agent/threads', request: { path: { type: 'object' }, query: { type: 'object' }, body: { kind: 'json', schema: { type: 'object' } } },
  responses: { '200': { mediaType: 'application/json' } }, effects: { mode: 'write', description: 'Existing Manager delivery owner.' } };

function fixture() {
  const business = [];
  const client = createManagerClient({ managerUrl, localHost: true,
    endpointSession: { ensure: async () => ({ managerUrl, meta }) },
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path === '/meta') return Response.json(meta);
      if (path.startsWith('/api/agent/operations/')) return Response.json({ code: 0, data: {
        schemaVersion: '2', ...meta, pluginGenerationId: 'fixture-plugins', catalogRevision: 1,
        catalogDigest: 'sha256:' + 'a'.repeat(64), operation: { id: contract.operationId, contractDigest: 'sha256:' + 'b'.repeat(64), contract }
      } });
      assert.equal(path, '/api/agent/threads'); assert.equal(options.method, 'POST');
      business.push({ path, body: options.body, headers: options.headers });
      return Response.json({ code: 0, data: { accepted: true, deliveryId: JSON.parse(options.body).deliveryId } });
    }
  });
  return { client, business };
}

for (const entry of ['request', 'invoke', 'sdk', 'mcp']) {
  test(`local ${entry} sends the original Agent intent through the Manager exactly once`, async t => {
    const { client, business } = fixture();
    const body = { action: 'send', deliveryId: 'original-' + entry, sourceThreadId: 'original-source',
      threadId: 'original-target', agentAdapter: 'codex', prompt: 'Synthetic original task', responsePolicy: 'none' };
    const key = 'original-key-' + entry;
    let receipt;
    if (entry === 'sdk') receipt = await client.operations.call(contract.operationId, { body }, { requestId: key });
    else if (entry === 'mcp') {
      const tools = createOperationTools({ client }); t.after(() => tools.close());
      receipt = await tools.call('rabi_call', { operation: contract.operationId, input: { body }, requestId: key });
    } else receipt = await client[entry]('POST', '/api/agent/threads', { body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
    assert.equal(receipt.statusCode, 200); assert.equal(receipt.ok, true); assert.equal(business.length, 1);
    assert.deepEqual(JSON.parse(business[0].body), body);
    assert.equal(business[0].headers['idempotency-key'], key);
    assert.equal(business[0].headers.authorization, undefined);
    assert.equal(business[0].headers['x-rabiroute-agent-type'], undefined);
    assert.equal(business[0].headers['x-rabiroute-session-id'], undefined);
  });
}

test('generic remote clients keep explicit source headers without requiring an installed delivery owner', async () => {
  const posts = [];
  const client = createManagerClient({ managerUrl: 'http://manager.invalid', credential: 'controlled-credential',
    agentType: 'codex', sessionId: 'original-remote-source', fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/meta') return Response.json(meta);
      posts.push(options); return Response.json({ code: 0, data: { deliveryId: 'original-generic', accepted: true } });
    } });
  const result = await client.request('POST', '/api/agent/threads', { body: { action: 'send', deliveryId: 'original-generic', threadId: 'original-target', prompt: 'controlled fixture' } });
  assert.equal(result.ok, true); assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['x-rabiroute-session-id'], 'original-remote-source');
  assert.equal(JSON.parse(posts[0].body).deliveryId, 'original-generic');
});

test('actual --config CLI can call send with connection source and retains the original uncertain receipt', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-sessionless-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ managerUrl: 'http://manager.invalid', nodeCredential: 'controlled-credential' }));
  let status = 200; const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(url).pathname;
    assert.equal(options.headers.authorization, 'Bearer controlled-credential');
    if (pathname === '/meta') return Response.json(meta);
    if (pathname.startsWith('/api/agent/operations/')) return Response.json({ code: 0, data: {
      schemaVersion: '2', ...meta, pluginGenerationId: 'plugins', catalogRevision: 1, catalogDigest: 'sha256:' + 'a'.repeat(64),
      operation: { id: contract.operationId, contractDigest: 'sha256:' + 'b'.repeat(64), contract }
    } });
    assert.equal(pathname, '/api/agent/threads'); posts.push(options);
    return Response.json({ code: status === 200 ? 0 : -1, data: { deliveryId: JSON.parse(options.body).deliveryId }, uncertain: status !== 200 }, { status });
  });
  for (const code of [200, 503]) {
    status = code;
    const id = 'original-connection-request-' + code, body = { action: 'send', deliveryId: id, threadId: 'original-target', prompt: 'synthetic' };
    const result = await runCli(['call', contract.operationId, '--config', configPath, '--input-json', JSON.stringify({ body }), '--request-id', id]);
    assert.equal(result.statusCode, code); assert.equal(result.uncertain, code === 503);
    assert.equal(posts.length, code === 200 ? 1 : 2, 'an uncertain send is not automatically submitted again');
    assert.deepEqual(JSON.parse(posts.at(-1).body), body);
    assert.equal(posts.at(-1).headers['idempotency-key'], id);
    assert.equal(posts.at(-1).headers['x-rabiroute-agent-type'], undefined);
    assert.equal(posts.at(-1).headers['x-rabiroute-session-id'], undefined);
  }
});
