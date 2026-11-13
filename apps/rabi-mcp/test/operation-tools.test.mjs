import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationSdk } from '../../rabi-agent/lib/operation-sdk.mjs';
import { runOperationCommand } from '../../rabi-agent/lib/operation-cli.mjs';
import { createOperationTools, readOperationSessionSettings } from '../lib/operation-tools.mjs';
import { createKnowledgeMcpServer } from '../lib/knowledge-mcp-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture() {
  const identity = { applicationGenerationId: 'app', managerInstanceId: 'manager' };
  const snapshot = { schemaVersion: '2', ...identity, pluginGenerationId: 'plugins', catalogRevision: 1, catalogDigest: 'sha256:' + 'a'.repeat(64) };
  const operation = { id: 'notes.write', contractDigest: 'sha256:' + 'b'.repeat(64), contract: { operationId: 'notes.write', contractVersion: '1.0.0', method: 'POST', transport: 'http', pathTemplate: '/notes/:id', request: { path: { type: 'object' }, query: { type: 'object' }, body: { kind: 'json', schema: { type: 'object' } } }, effects: { mode: 'write' }, responses: { '200': { mediaType: 'application/json' } } } };
  const writes = [], reads = [];
  const client = { request: async (method, path, options = {}) => {
    let body;
    if (path === '/api/agent/categories') body = { code: 0, data: { ...snapshot, categories: [{ id: 'knowledge', title: 'Knowledge', count: 1 }] } };
    else if (path.startsWith('/api/agent/operations?')) body = { code: 0, data: { ...snapshot, items: [{ operationId: operation.id, title: 'Notes' }], nextCursor: '' } };
    else if (path.startsWith('/api/agent/operations/')) { reads.push(path); body = { code: 0, data: { ...snapshot, operation } }; }
    else { writes.push({ method, path, body: options.body, headers: options.headers }); body = { code: 0, data: { saved: true } }; }
    return { statusCode: 200, ok: true, body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, identity };
  } };
  client.operations = createOperationSdk(client);
  return { client, writes, reads, tools: createOperationTools({ client }) };
}

test('MCP presents the canonical shared actions and CLI-equivalent structured input', async t => {
  const f = fixture(); t.after(() => f.tools.close());
  assert.deepEqual(f.tools.list().map(x => x.name), ['rabi_categories', 'rabi_list', 'rabi_search', 'rabi_describe', 'rabi_call', 'rabi_session']);
  const input = { pathParams: { id: 'one note' }, query: { limit: 7 }, body: { value: 'same data' } };
  const cli = await runOperationCommand(['call', 'notes.write', '--input-json', JSON.stringify(input), '--request-id', 'same-request'], f.client.operations);
  const mcp = await f.tools.call('rabi_call', { operation: 'notes.write', input, requestId: 'same-request' });
  assert.deepEqual(f.writes[0], f.writes[1]); assert.equal(cli.ok, true); assert.equal(mcp.ok, true);
  assert.deepEqual(cli.data, mcp.data); assert.equal(mcp.requestId, 'same-request');
  assert.equal(f.reads.length, 2, 'each invocation obtains one description, never the complete catalog');
});

test('official MCP clients can discover categories and search through the shared SDK', async t => {
  const f = fixture(); const server = createKnowledgeMcpServer({ tools: f.tools });
  const client = new Client({ name: 'controlled-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await f.tools.close(); });
  await Promise.all([server.connect(a), client.connect(b)]);
  assert.equal((await client.listTools()).tools.length, 6);
  const categories = await client.callTool({ name: 'rabi_categories', arguments: {} });
  assert.equal(categories.isError, false); assert.equal(categories.structuredContent.data.categories[0].id, 'knowledge');
  const search = await client.callTool({ name: 'rabi_search', arguments: { query: 'memory', category: 'knowledge' } });
  assert.equal(search.structuredContent.data.items[0].operationId, 'notes.write');
  const invalid = await client.callTool({ name: 'rabi_call', arguments: { operation: 'notes.write', expectedRevison: 'typo' } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.field, 'expectedRevison');
  assert.match(invalid.structuredContent.error.repair, /expectedRevision/);
  assert.equal(f.writes.length, 0);
});


test('canonical tool dispatch reports unknown or missing fields before any business request', async t => {
  const f = fixture(); t.after(() => f.tools.close());
  await assert.rejects(f.tools.call('rabi_call', { operation: 'notes.write', expectedRevison: 'mistyped' }), /Unknown.*expectedRevison/);
  await assert.rejects(f.tools.call('rabi_describe', { view: 'input' }), /requires operation/);
  await assert.rejects(f.tools.call('rabi_categories', { headers: {} }), /Unknown.*headers/);
  assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});


test('MCP launch session budgets default and validate explicit environment values', () => {
  assert.deepEqual(readOperationSessionSettings({}), { maxSessions: 16, maxSessionBytes: 1048576 });
  assert.deepEqual(readOperationSessionSettings({ RABI_MCP_MAX_SESSIONS: '2', RABI_MCP_MAX_SESSION_BYTES: '128' }), { maxSessions: 2, maxSessionBytes: 128 });
  for (const name of ['RABI_MCP_MAX_SESSIONS', 'RABI_MCP_MAX_SESSION_BYTES']) {
    for (const bad of ['', '0', '-1', '1.5', 'NaN', '9007199254740992'])
      assert.throws(() => readOperationSessionSettings({ [name]: bad }), new RegExp(name));
  }
});
