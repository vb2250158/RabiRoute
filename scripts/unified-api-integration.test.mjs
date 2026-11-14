import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ManagerPluginRouteRegistry } from '../src/manager/managerPluginRouteRegistry.ts';
import { markAuthenticatedConnectionRequest } from '../src/manager/connectionRequestAccess.ts';
import { createApiDiscoveryOperations } from '../src/plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.ts';
import { createQqMessageOperations } from '../src/plugins/io.rabiroute.endpoint.napcat/src/manager/qqMessageRoutes.ts';
import { createDiagnosticsRoutes } from '../src/plugins/io.rabiroute.manager.diagnostics/operations.mjs';
import { createPersonaSkillOperations } from '../src/plugins/io.rabiroute.manager.persona/src/manager/personaSkillOperations.ts';
import { getRoleSkill, listRoleSkills } from '../src/roleKnowledge.ts';
import { fixtureApiContract } from '../src/manager/apiOperationContractFixtures.ts';
import { createOperationSdk } from '../apps/rabi-agent/lib/operation-sdk.mjs';
import { runOperationCommand } from '../apps/rabi-agent/lib/operation-cli.mjs';
import { createOperationTools } from '../apps/rabi-mcp/lib/operation-tools.mjs';
import { createKnowledgeMcpServer } from '../apps/rabi-mcp/lib/knowledge-mcp-server.mjs';

const identity = { applicationGenerationId: 'integration-generation', managerInstanceId: 'integration-manager' };
const catalogIdentity = { ...identity, pluginGenerationId: 'integration-plugins' };
const routeId = 'example-route';
const target = '456';
const message = { message_id: 123, message_type: 'group', group_id: target, user_id: '789', time: 100,
  message: [{ type: 'text', data: { text: 'Original controlled history record' } }] };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-unified-integration-'));
  const roleDir = path.join(directory, 'Example');
  await fs.mkdir(path.join(roleDir, 'skills'), { recursive: true });
  await fs.writeFile(path.join(roleDir, 'persona.md'), '# Example');
  const providerCalls = [];
  const token = randomUUID();
  const provider = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const action = request.url.slice(1);
      providerCalls.push({ action, payload });
      let data;
      if (action === 'get_group_list') data = [{ group_id: target, group_name: 'Example group', member_count: 2 }];
      else if (action === 'get_friend_list') data = [];
      else if (action === 'get_login_info') data = { user_id: '111', nickname: 'Example account' };
      else if (action === 'get_recent_contact') data = [];
      else if (action === 'get_group_msg_history') data = { messages: [message] };
      else throw new Error('Unexpected controlled provider action ' + action);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    } catch { response.writeHead(500).end('{}'); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const definition = { id: routeId, enabled: true, messageAdapters: ['napcat'],
    napcatInstances: [{ id: 'example-instance', enabled: true,
      httpUrl: 'http://127.0.0.1:' + provider.address().port, accessToken: token }] };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => catalogIdentity });
  const registrations = [
    registry.registerOperations('discovery', createApiDiscoveryOperations(registry)),
    registry.registerOperations('diagnostics', createDiagnosticsRoutes({ gatewayDiagnosticsPayload: () => [
      { id: routeId, name: 'Example route', enabled: true, running: true, messageAdapters: ['napcat'] }
    ] }).operations),
    registry.registerOperations('napcat', createQqMessageOperations({ local: () => true, route: id => id === routeId ? definition : undefined,
      json: (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) })),
    registry.registerOperations('persona', createPersonaSkillOperations({ roleDirectory: () => roleDir,
      identity: () => identity,
      querySkills: async (dir, id) => id ? getRoleSkill(dir, id) : listRoleSkills(dir),
      archive: async () => { throw new Error('This test does not request archives.'); }, reportCleanupError: () => {} }))
  ];
  const requests = [];
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url, 'http://fixture'), response)) response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const sdkRequests = [];
  const request = async (method, suffix, options = {}) => {
    sdkRequests.push({ method, suffix });
    requests.push({ method, path: suffix, body: options.body ?? '', key: options.headers?.['idempotency-key'] });
    const response = await fetch(base + suffix, { method, headers: { 'content-type': 'application/json', ...options.headers },
      signal: options.signal, ...(options.body === undefined ? {} : { body: options.body }) });
    return { statusCode: response.status, ok: response.ok, body: await response.text(),
      headers: Object.fromEntries(response.headers), identity };
  };
  const sdk = createOperationSdk({ request });
  const tools = createOperationTools({ client: { request, operations: sdk } });
  const mcpServer = createKnowledgeMcpServer({ tools });
  const mcpClient = new Client({ name: 'controlled-integration-client', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpServer.connect(a), mcpClient.connect(b)]);
  t.after(async () => {
    await mcpClient.close(); await mcpServer.close(); await tools.close();
    for (const registration of registrations.reverse()) await registration.dispose();
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([server, provider].map(value => new Promise(resolve => value.close(resolve))));
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, roleDir, registry, registrations, sdk, tools, mcpClient, requests, sdkRequests, providerCalls, base };
}

function pluginDefinition(id, discovery) {
  return { contract: fixtureApiContract({ operationId: id, method: 'GET', pathTemplate: '/api/integration/' + id,
    request: { path: { type: 'object' }, query: { type: 'object' }, headers: { type: 'object' }, body: { kind: 'none' } },
    effects: { mode: 'read', description: 'Controlled custom plugin marker.' } }), discovery,
    handler: () => ({ status: 200, body: { ok: true, value: 1 } }) };
}

test('real discovery reaches QQ history and its parameter sources within three discovery reads', async t => {
  const f = await fixture(t);
  const categories = await f.sdk.categories();
  assert.ok(categories.categories.some(row => row.id === 'messages'));
  const found = await f.sdk.search('QQ 历史', { category: 'messages' });
  const summary = found.items.find(row => row.operationId === 'agent.qq.history.read');
  assert.ok(summary, 'Intent search must locate the real QQ history operation.');
  assert.equal(Object.hasOwn(summary, 'contract'), false);
  const input = await f.sdk.describe(summary.operationId, { view: 'input' });
  assert.equal(f.sdkRequests.length, 3, 'Categories, intent search and input describe are the discovery path.');
  assert.deepEqual(input.operation.request.query.required, ['routeId', 'kind', 'target']);
  const sources = input.operation.discovery.inputSources;
  assert.equal(sources.find(row => row.field === 'query.routeId').operationId, 'manager.gateways.read');
  assert.equal(sources.find(row => row.field === 'query.target').operationId, 'agent.qq.contacts.read');
  const full = await f.sdk.describe(summary.operationId, { view: 'full' });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(JSON.stringify(full.operation)) / 5);

  const routes = await f.sdk.call('manager.gateways.read');
  assert.equal(routes.data[0].id, routeId);
  const contacts = await f.sdk.call('agent.qq.contacts.read', { query: { routeId } });
  const group = contacts.data.data.entries.find(row => row.kind === 'group');
  assert.equal(group.target, target);
  const history = await f.sdk.call('agent.qq.history.read', { query: { routeId, kind: group.kind, target: group.target, limit: 2 } });
  assert.equal(history.statusCode, 200);
  assert.equal(history.data.data.entries[0].messageId, '123');
  assert.equal(history.data.data.entries[0].text, 'Original controlled history record');
  assert.equal(history.data.data.completenessUnknown, true);
  assert.ok(f.providerCalls.some(row => row.action === 'get_group_msg_history' && row.payload.group_id === target));
  assert.equal(f.sdkRequests.some(row => row.suffix === '/api/agent/help'), false);
});

test('actual Skill owner receives identical structured CLI and official MCP write intent', async t => {
  const f = await fixture(t);
  const content = '---\nname: integration-method\ndescription: Controlled reusable method\n---\n# Integration\nRead the original operation before writing.\n';
  const input = { pathParams: { roleId: 'Example' }, body: { id: 'integration-method', content,
    files: { 'references/example.md': 'Controlled supporting material.' } } };
  const cli = await runOperationCommand(['call', 'manager.personas.skills.create', '--input-json', JSON.stringify(input), '--request-id', 'same-skill-request'], f.sdk);
  assert.equal(cli.ok, true, JSON.stringify(cli));
  const mcp = await f.mcpClient.callTool({ name: 'rabi_call', arguments: {
    operation: 'manager.personas.skills.create', input, requestId: 'same-skill-request'
  } });
  assert.equal(mcp.isError, false, JSON.stringify(mcp));
  assert.deepEqual(mcp.structuredContent.data, cli.data);
  const writes = f.requests.filter(row => row.method === 'POST' && row.path === '/api/roles/Example/skills');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body, writes[1].body);
  assert.equal(writes[0].key, 'same-skill-request');
  assert.equal(writes[1].key, writes[0].key);
  assert.equal(await fs.readFile(path.join(f.roleDir, 'skills', 'integration-method', 'SKILL.md'), 'utf8'), content);
  assert.equal(await fs.readFile(path.join(f.roleDir, 'skills', 'integration-method', 'references', 'example.md'), 'utf8'), 'Controlled supporting material.');
  const operation = await f.sdk.call('manager.personas.skills.operation.read', { pathParams: { roleId: 'Example', requestId: 'same-skill-request' } });
  assert.equal(operation.data.data.state, 'committed');
});

test('plugin category changes and invalid discovery metadata remain local through SDK and MCP', async t => {
  const f = await fixture(t);
  const plugin = f.registry.registerOperations('custom-plugin', [pluginDefinition('fixture.custom.read', {
    title: 'Custom integration capability', category: { id: 'io.example.custom', title: 'Custom domain', parentId: 'runtime' },
    keywords: ['custommarker'], provider: 'example'
  }), pluginDefinition('fixture.bad.read', { title: 12, tags: ['valid', 17] })]);
  f.registrations.push(plugin);
  f.sdk.handleEvent({ type: 'api.catalog.changed' });
  const categories = await f.tools.call('rabi_categories');
  assert.ok(categories.data.categories.some(row => row.id === 'io.example.custom'));
  const search = await f.mcpClient.callTool({ name: 'rabi_search', arguments: { query: 'custommarker', category: 'io.example.custom' } });
  assert.equal(search.structuredContent.data.items[0].operationId, 'fixture.custom.read');
  const bad = await f.sdk.search('fixture.bad.read');
  assert.equal(bad.items[0].operationId, 'fixture.bad.read');
  assert.ok(bad.items[0].discoveryIssues.length > 0);
  const before = await f.sdk.describe('fixture.custom.read', { view: 'full' });
  await plugin.dispose();
  f.sdk.handleEvent({ type: 'api.catalog.changed' });
  const removed = await f.sdk.search('custommarker');
  assert.equal(removed.items.length, 0);
  await assert.rejects(f.sdk.describe('fixture.custom.read', { view: 'full' }), error => error.receipt?.statusCode === 404);
  const healthy = await f.sdk.search('QQ 历史', { category: 'messages' });
  assert.ok(healthy.items.some(row => row.operationId === 'agent.qq.history.read'));
  assert.ok(healthy.catalogRevision > before.catalogRevision);
});
