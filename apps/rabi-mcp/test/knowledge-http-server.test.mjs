import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startKnowledgeHttpServer, MAX_KNOWLEDGE_HTTP_BODY } from '../lib/knowledge-http-server.mjs';
import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';
const token = 'fixture-secret-not-real-01234567890123456789';
const tools = { list: () => [{ name: 'read_fixture', readOnly: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], call: async () => ({ ok: true, uncertain: false, data: { value: 'fixture' } }) };
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
test('official HTTP SDK initializes lists calls and closes a stateless loopback server', async t => {
  const service = await startKnowledgeHttpServer({ tools, token });
  t.after(() => service.close());
  const client = new Client({ name: 'http-fixture', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.address), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools[0].name, 'read_fixture');
  assert.equal((await client.callTool({ name: 'read_fixture', arguments: {} })).structuredContent.data.value, 'fixture');
  await client.close(); await service.close(); await service.close();
  await assert.rejects(fetch(service.address));
});
test('HTTP authorization origin cookies path method and body gates fail closed', async t => {
  let calls = 0;
  const service = await startKnowledgeHttpServer({ tools: { ...tools, call: async () => { calls++; return { ok: true }; } }, token, allowedOrigins: ['https://controller.example'] });
  t.after(() => service.close());
  const post = (extra = {}, body = '{}', url = service.address) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post({ authorization: '' })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${'x'.repeat(40)}` })).status, 401);
  assert.equal((await post({ origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403);
  assert.equal((await post({ cookie: 'session=fixture' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request(service.address, { method: 'POST', headers: { ...headers, host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHost, 403);
  assert.equal((await post({}, '{}', service.address + '?role=other')).status, 404);
  assert.equal((await post({}, 'x'.repeat(MAX_KNOWLEDGE_HTTP_BODY + 1))).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(service.address, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('x'.repeat(MAX_KNOWLEDGE_HTTP_BODY)); req.end('x');
  });
  assert.equal(chunked, 413);
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({}, '{bad')).status, 400);
  assert.equal((await fetch(service.address, { headers })).status, 405);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const accepted = await post({ origin: 'https://controller.example' }, JSON.stringify(request));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('set-cookie'), null);
  assert.equal(accepted.headers.get('mcp-session-id'), null);
  assert.ok(!(await accepted.text()).includes(token));
  assert.equal(calls, 0);
});
test('HTTP clients cannot expand role write or endpoint authorization', async t => {
  let calls = 0;
  const scoped = createKnowledgeTools({ allowedRoles: ['demo'], client: { invoke: async () => { calls++; return { ok: true }; } } });
  const service = await startKnowledgeHttpServer({ tools: scoped, token }); t.after(() => service.close());
  const client = new Client({ name: 'http-policy', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(service.address), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  for (const [name, args] of [['plan_create', {}], ['knowledge_search', { roleId: 'other' }], ['knowledge_search', { roleId: 'demo', url: 'https://other.example', allowWrites: true }]]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.equal(calls, 0);
});
test('configuration rejects weak secrets and wildcard origins', async () => {
  for (const value of ['', 'short', undefined, 'x'.repeat(32) + '\n']) await assert.rejects(startKnowledgeHttpServer({ tools, token: value }));
  for (const origin of ['*', 'null', 'https://example.test/path', 'https://example.test/']) await assert.rejects(startKnowledgeHttpServer({ tools, token, allowedOrigins: [origin] }));
});
