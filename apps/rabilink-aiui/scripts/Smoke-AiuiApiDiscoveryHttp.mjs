import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagerPluginRouteRegistry } from '../../../src/manager/managerPluginRouteRegistry.ts';
import { createApiDiscoveryOperations } from '../../../src/manager/apiDiscoveryRoutes.ts';
import { fixtureApiContract } from '../../../src/manager/apiOperationContractFixtures.ts';
import { createApiToolRuntime } from '../utils/api-tool-runtime.js';
import { createAgentTurnRuntime } from '../utils/agent-turn-runtime.js';
import { AGENT_PROTOCOL } from '../utils/agent-decision-protocol.js';

const event = (callId, args) => ({ callId, functionName: 'rabi_api_help', arguments: args, isComplete: true });
const empty = { type: 'object', additionalProperties: false, properties: {} };
const target = 'fixture.039';
async function fixture(t) {
  const registry = new ManagerPluginRouteRegistry(), businessCalls = [], requests = [];
  const properties = Object.fromEntries(Array.from({ length: 24 }, (_, i) => ['field' + i,
    { type: 'string', description: 'Contract field documentation. '.repeat(12) }]));
  const operations = Array.from({ length: 40 }, (_, i) => {
    const id = 'fixture.' + String(i).padStart(3, '0');
    return { contract: fixtureApiContract({ operationId: id, method: 'GET', pathTemplate: '/api/' + id,
      request: { path: empty, query: empty, headers: { type: 'object' }, body: { kind: 'none' } },
      effects: { mode: 'read', description: 'Reads the original delivery resource.' },
      recovery: { strategy: 'repeatable-read', description: 'Read with the original deliveryId; it is not the transport operationId.' },
      responses: { '200': { mediaType: 'application/json', schema: { type: 'object', properties, additionalProperties: true } } } }),
    handler: () => { businessCalls.push(id); return { status: 200, body: { found: id } }; } };
  });
  const registrations = [registry.registerOperations('fixture-catalog', operations)];
  registrations.push(registry.registerOperations('fixture-discovery', createApiDiscoveryOperations(registry)));
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url, 'http://fixture.invalid'), response)) response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const registration of registrations) await registration.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let rows = [];
  const call = async packet => {
    requests.push(packet);
    const response = await fetch(base + packet.path);
    const data = await response.json();
    return { structuredContent: { ok: response.ok, statusCode: response.status, data },
      content: [{ type: 'text', text: JSON.stringify(data) }], isError: !response.ok };
  };
  const api = createApiToolRuntime({ sessionId: 'discovery', defaultTargetDeviceId: 'pc-fixture', call,
    storage: { load: () => structuredClone(rows), save: value => { rows = structuredClone(value); } } });
  return { api, base, requests, businessCalls, operations, registrations };
}

test('the model traverses a large real HTTP catalog, reads an exact contract and invokes only the selected API', async t => {
  const f = await fixture(t);
  const unpaged = await (await fetch(f.base + '/api/agent/help')).text();
  assert.ok(unpaged.length > 262144, 'fixture must exceed the model observation limit before projection');
  const publishedContract = JSON.parse(unpaged).data.operations.find(row => row.id === target).contract;
  const visited = [], observationSizes = [];
  let step = 0;
  const model = { async prompt(input) {
    const message = JSON.parse(input[0].content);
    const tool = (name, args) => JSON.stringify({ protocol: AGENT_PROTOCOL, requestId: message.requestId, kind: 'tool', name, arguments: args });
    step++;
    if (step === 1) return tool('rabi_api_help', {});
    observationSizes.push(input[0].content.length);
    const result = message.observation.outcome.result;
    if (step <= 3) {
      assert.equal(result.apiHelpView, 'index'); assert.equal(result.completeContracts, false);
      const page = result.structuredContent.data.data;
      visited.push(...page.operations.map(row => row.id));
      assert.ok(page.operations.every(row => !row.contract && !row.help));
      assert.ok(!JSON.stringify(result).includes('Contract field documentation'));
      if (step === 2) {
        assert.equal(page.count, 32); assert.ok(page.nextCursor);
        return tool('rabi_api_help', { cursor: page.nextCursor });
      }
      assert.equal(page.nextCursor, ''); assert.ok(visited.includes(target));
      return tool('rabi_api_help', { operationId: target });
    }
    if (step === 4) {
      const detail = result.structuredContent.data.data.operations;
      assert.equal(detail.length, 1);
      assert.deepEqual(detail[0].contract, publishedContract);
      return tool('rabi_api_call', { method: detail[0].method, path: detail[0].pathTemplate });
    }
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent.data));
    assert.equal(result.structuredContent.data.found, target);
    return '已读取目标接口。';
  } };
  const outcome = await createAgentTurnRuntime({ model, tools: await f.api.loadTools(),
    executeTool: value => f.api.handleToolCall(value) }).run('查找并读取目标接口');
  assert.equal(outcome.state, 'completed'); assert.equal(step, 5);
  assert.equal(new Set(visited).size, visited.length);
  assert.equal(visited.length, 43); // 40 business operations + 3 discovery routes.
  assert.ok(observationSizes.every(size => size < 100000));
  assert.deepEqual(f.businessCalls, [target]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[0].path, '/api/agent/help?limit=32');
  assert.equal(f.requests[2].path, '/api/agent/help?operationId=fixture.039&limit=1');
  assert.ok(f.requests.every(packet => packet.targetDeviceId === 'pc-fixture'));
  t.diagnostic(JSON.stringify({ unpagedChars: unpaged.length, observationChars: observationSizes }));
});

test('catalog changes and invalid cursors retain actual HTTP errors without retries or business calls', async t => {
  const f = await fixture(t);
  const first = await f.api.handleToolCall(event('first', {}));
  const cursor = first.result.structuredContent.data.data.nextCursor;
  await f.registrations[0].dispose();
  const stale = await f.api.handleToolCall(event('stale', { cursor }));
  assert.equal(stale.result.structuredContent.statusCode, 409);
  assert.match(JSON.stringify(stale.result), /API_CATALOG_SNAPSHOT_CHANGED/);
  const invalid = await f.api.handleToolCall(event('invalid', { cursor: 'not-json' }));
  assert.equal(invalid.result.structuredContent.statusCode, 400);
  assert.match(JSON.stringify(invalid.result), /API_CATALOG_CURSOR_INVALID/);
  assert.equal(f.requests.length, 3); assert.deepEqual(f.businessCalls, []);
});

test('invalid pagination is rejected before transport; exact paths use contract pagination', async t => {
  const f = await fixture(t);
  for (const args of [{ limit: 0 }, { limit: 201 }, { limit: '32' }, { limit: 1.5 }, { cursor: '' },
    { cursor: 'x'.repeat(4097) }, { view: 'index' }, { search: 'write' }, { operationId: null }]) {
    await assert.rejects(f.api.handleToolCall(event('invalid-args', args)), { code: 'TOOL_ARGUMENTS_INVALID' });
  }
  assert.equal(f.requests.length, 0);
  const expected = await (await fetch(f.base + '/api/agent/help?operationId=' + target)).json();
  const result = await f.api.handleToolCall(event('exact', { path: '/api/' + target, method: 'GET', limit: 1 }));
  assert.deepEqual(result.result.structuredContent.data.data.operations[0].contract, expected.data.operations[0].contract);
  assert.equal(new URL(f.base + f.requests[0].path).searchParams.get('path'), '/api/' + target);
});
