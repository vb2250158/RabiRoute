import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKnowledgeMcpServer } from '../lib/knowledge-mcp-server.mjs';
import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';

async function connect(t, tools) {
  const server = createKnowledgeMcpServer({ tools });
  const client = new Client({ name: 'knowledge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const definition = { name: 'example_read', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true };

test('official SDK initializes, lists annotations and calls structured tools', async t => {
  const receipt = { ok: true, statusCode: 200, uncertain: false, data: { items: [] } };
  const client = await connect(t, { list: () => [definition], call: async () => receipt });
  assert.equal(client.getServerVersion().name, 'rabi-knowledge');
  const listed = await client.listTools();
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);
  assert.equal(listed.tools[0].annotations.openWorldHint, true);
  assert.match(listed.tools[0].description, /do not grant permission/);
  const result = await client.callTool({ name: 'example_read', arguments: {} });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, receipt);
  assert.deepEqual(JSON.parse(result.content[0].text), receipt);
});

test('default knowledge policy lists reads only and rejects hidden writes', async t => {
  let invoked = 0;
  const tools = createKnowledgeTools({ allowedRoles: ['example'], client: { invoke: async () => { invoked++; throw new Error('must not execute'); } } });
  const client = await connect(t, tools);
  const listed = await client.listTools();
  assert.ok(listed.tools.length > 0);
  assert.ok(listed.tools.every(tool => tool.annotations.readOnlyHint === true));
  assert.ok(!listed.tools.some(tool => tool.name === 'plan_create'));
  assert.deepEqual(listed.tools.find(tool => tool.name === 'memory_get').inputSchema.properties.kind.enum, ['consolidated']);
  const result = await client.callTool({ name: 'plan_create', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(invoked, 0);
});

test('unknown tools, unauthorized roles and invalid fields return safe errors', async t => {
  let invoked = 0;
  const tools = createKnowledgeTools({ allowedRoles: ['example'], client: { invoke: async () => { invoked++; throw new Error('private-token'); } } });
  const client = await connect(t, tools);
  for (const [name, args] of [['unknown', {}], ['knowledge_search', { roleId: 'other' }], ['knowledge_search', { roleId: 'example', credential: 'private-token' }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('private-token'));
  }
  assert.equal(invoked, 0);
});

test('thrown errors are redacted and uncertain receipts remain visible as failures', async t => {
  let attempt = 0;
  const receipt = { ok: false, statusCode: 503, uncertain: true, commitState: 'unknown' };
  const client = await connect(t, { list: () => [{ ...definition, readOnly: false }], call: async () => {
    if (++attempt === 1) throw new Error('secret-token and private body');
    return receipt;
  } });
  const listed = await client.listTools();
  assert.equal(listed.tools[0].annotations.readOnlyHint, false);
  assert.equal(listed.tools[0].annotations.idempotentHint, false);
  const failed = await client.callTool({ name: 'example_read', arguments: {} });
  assert.equal(failed.isError, true);
  assert.ok(!JSON.stringify(failed).includes('secret-token'));
  const uncertain = await client.callTool({ name: 'example_read', arguments: {} });
  assert.equal(uncertain.isError, true);
  assert.deepEqual(uncertain.structuredContent, receipt);
  assert.equal(attempt, 2);
});

test('catalog exceptions cannot leak secrets through SDK protocol errors', async t => {
  const client = await connect(t, { list: () => { throw new Error('private-catalog-secret'); }, call: async () => ({ ok: true }) });
  await assert.rejects(client.listTools(), error => {
    assert.ok(!String(error).includes('private-catalog-secret'));
    assert.match(String(error), /catalog is unavailable/);
    return true;
  });
});

test('invalid tools injection is rejected', () => {
  assert.throws(() => createKnowledgeMcpServer(), /knowledge tools/);
});
