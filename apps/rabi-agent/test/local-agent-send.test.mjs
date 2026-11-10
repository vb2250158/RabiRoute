import assert from 'node:assert/strict';
import test from 'node:test';
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

test('remote SDK sends still require the original installed durable owner configuration', async () => {
  let networkCalls = 0;
  const client = createManagerClient({ managerUrl: 'http://manager.invalid', credential: 'controlled-credential',
    agentType: 'codex', sessionId: 'original-remote-source', fetchImpl: async () => { networkCalls++; throw new Error('must retain local acceptance boundary'); } });
  await assert.rejects(client.request('POST', '/api/agent/threads', { body: { action: 'send', threadId: 'original-target', prompt: 'controlled fixture' } }),
    /Reliable Agent delivery requires the installed owner config and explicit source identity/);
  assert.equal(networkCalls, 0);
});
