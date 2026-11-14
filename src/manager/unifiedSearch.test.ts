import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { createApiDiscoveryOperations } from '../plugins/io.rabiroute.manager.agent-communication/src/manager/apiDiscoveryRoutes.js';
import { createUnifiedSearchOperation } from './unifiedSearchOperations.js';
import { KnowledgeSearchService } from './knowledgeSearchService.js';
import { readKnowledgeStorageDelta } from './knowledgeSearchStorage.js';
import { refreshMessageHistoryIndex, searchMessageHistoryIndexResult } from '../messageHistorySearchIndex.js';
import { createPersonaKnowledgeOperations } from '../plugins/io.rabiroute.manager.persona/src/manager/personaKnowledgeOperations.js';
import { fixtureApiContract } from './apiOperationContractFixtures.js';
import { normalizeHomeAssistantState } from '../plugins/io.rabiroute.manager.xiaomi-home/src/integrations/xiaomiHome/managerApi.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { runUnifiedSearch, parseSearchQuery, type SearchLane } from './unifiedSearch.js';
import { createSearchLanes } from './unifiedSearchSources.js';
const observed = '2026-11-12T10:00:00.000Z', updated = '2026-11-13T10:00:00.000Z';
async function fixture(t: test.TestContext, messageCount = 3) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-unified-search-'));
    const roles = [{ roleId: 'first' }, { roleId: 'second' }];
    const roleDirectory = (roleId: string) => path.join(directory, roleId);
    for (const { roleId } of roles) {
        const root = roleDirectory(roleId);
        fs.mkdirSync(path.join(root, 'memory', 'recent'), { recursive: true });
        fs.mkdirSync(path.join(root, 'conversation', 'archive'), { recursive: true });
        fs.writeFileSync(path.join(root, 'memory', 'recent', 'location.json'), JSON.stringify({ id: 'location', title: '卧室 空调', focus: '位置', content: '昨日记录的位置', keywords: ['卧室', '空调'], createdAt: observed, updatedAt: updated,
            searchEvidence: { state: 'candidate', observedAt: observed, expiresAt: '2026-11-14T10:00:00.000Z', evidenceRefs: ['/fixture/original-observation'] } }));
        fs.writeFileSync(path.join(root, 'conversation', 'current.jsonl'), Array.from({ length: roleId === 'first' ? messageCount : 0 }, (_, i) => JSON.stringify({ schemaVersion: 1, id: 'message-' + i, sequence: i + 1, time: 1794477600 + i, direction: 'inbound', adapter: i % 2 ? 'napcat' : 'voice', conversationKey: 'group:test', kind: 'group', text: i === 0 ? '我可能在卧室' : '卧室 空调 ' + i })).join('\n') + '\n');
        fs.writeFileSync(path.join(root, 'conversation', 'archive', 'index.json'), JSON.stringify({ schemaVersion: 1, nextSequence: messageCount + 1, archives: [] }));
        refreshMessageHistoryIndex(root, path.join(root, 'fixture.sqlite'));
    }
    const service = new KnowledgeSearchService({ watch: false, readDelta: async (dir, previous) => readKnowledgeStorageDelta(dir, previous) });
    for (const { roleId } of roles)
        await service.reload(roleId, roleDirectory(roleId));
    const resources = ['bedroom', 'living'].map((name, i) => normalizeHomeAssistantState({ entity_id: 'climate.' + name, state: 'off', attributes: { friendly_name: i ? '客厅空调' : '卧室空调' }, last_updated: observed }));
    const devices = resources.map((resource, i) => ({ deviceId: 'device-' + i, displayName: resource.displayName, areaName: i ? '客厅' : '卧室', model: 'fixture', manufacturer: 'fixture', resources: [resource] }));
    let entityError: Error | undefined, entityDelay = 0;
    const context = { roles: () => roles, roleDirectory, knowledge: service,
        queryHistory: async (dir: string, query: any) => searchMessageHistoryIndexResult(dir, query, path.join(dir, 'fixture.sqlite')),
        entities: async (_request: http.IncomingMessage, signal: AbortSignal) => {
            if (entityError)
                throw entityError;
            if (entityDelay)
                await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, entityDelay); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
            return { schemaVersion: 1 as const, observedAt: new Date().toISOString(), devices, unassignedResources: [] };
        } };
    const registry = new ManagerPluginRouteRegistry();
    const registrations = [registry.registerOperations('discovery', createApiDiscoveryOperations(registry)), registry.registerOperations('knowledge', createPersonaKnowledgeOperations({ service, roleDirectory, roleExists: id => roles.some(role => role.roleId === id), requestCatalogRefresh: () => { } }))];
    const define = (id: string, url: string, searchable?: any) => ({ contract: fixtureApiContract({ operationId: id, method: 'GET', pathTemplate: url, description: '卧室 空调 原始合同', ...(searchable ? { searchable } : {}),
            request: { path: { type: 'object' }, query: { type: 'object' }, headers: { type: 'object' }, body: { kind: 'none' } }, effects: { mode: 'read', description: 'Fixture source read' }, responses: { '200': { mediaType: 'application/json', schema: { type: 'object' } } } }), handler: () => ({ status: 200, body: { code: 0, data: { resources } } }) });
    registrations.push(registry.registerOperations('message-owner', [define('fixture.messages', '/fixture/messages', { scope: 'messages', legend: '原始聊天记录', kinds: ['group'] })]));
    registrations.push(registry.registerOperations('entity-owner', [define('fixture.entities', '/api/agent/xiaomi-home/resources', { scope: 'entities', legend: '设备实体', kinds: ['*'] }), define('fixture.entity.read', '/api/agent/xiaomi-home/resources/:resourceId'), define('fixture.entity.actions', '/api/agent/xiaomi-home/entity-actions')]));
    registrations.push(registry.registerOperations('unified', [createUnifiedSearchOperation(registry, context)]));
    const server = http.createServer((request, response) => {
        if (request.url === '/meta') {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applicationGenerationId: 'unmanaged', managerInstanceId: 'unmanaged', managerBaseUrl: base, health: { live: true, state: 'healthy' } }));
            return;
        }
        markAuthenticatedConnectionRequest(request);
        if (!registry.handle(request, new URL(request.url!, 'http://fixture'), response))
            response.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as {
        port: number;
    }).port;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        for (const registration of registrations)
            await registration.dispose();
        await service.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('rabi-unified-search-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const read = async (query: string, headers?: Record<string, string>) => { const response = await fetch(base + '/api/search?' + query, { headers }); return { status: response.status, ...await response.json() }; };
    return { context, registry, base, read, service, roleDirectory, resources, setEntityError: (error: Error) => entityError = error, setEntityDelay: (delay: number) => entityDelay = delay };
}
function assertCounts(data: any) {
    for (const source of data.coverage.sources)
        assert.equal(source.returned, data.items.filter((item: any) => item.source === source.source).length);
    assert.equal(data.facets.countScope, 'page');
    assert.equal(Object.values(data.facets.bySource).reduce((a: number, b: any) => a + b, 0), data.items.length);
}
test('scenario 1 — 1000 messages retain all four matching sources on the default first page', async (t) => {
    const f = await fixture(t, 1000), response = await f.read('q=' + encodeURIComponent('卧室 空调') + '&limit=20');
    assert.equal(response.status, 200);
    assert.equal(response.data.items.length, 20);
    assert.deepEqual(new Set(response.data.items.map((item: any) => item.source)), new Set(['knowledge', 'messages', 'operations', 'entities']));
    assertCounts(response.data);
});
test('scenario 2 — limit=1 rotates sources and traverses every stable candidate exactly once', { timeout: 180000 }, async (t) => {
    const f = await fixture(t, 1000), query = 'q=' + encodeURIComponent('卧室 空调') + '&limit=1';
    let cursor: string | null = null;
    const seen = new Set<string>(), sources: string[] = [];
    do {
        const response = await f.read(query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        assert.equal(response.status, 200);
        assertCounts(response.data);
        for (const item of response.data.items) {
            const key = JSON.stringify([item.source, item.origin]);
            assert.ok(!seen.has(key), key);
            seen.add(key);
            sources.push(item.source);
        }
        cursor = response.data.nextCursor;
    } while (cursor);
    assert.equal(new Set(sources.slice(0, 4)).size, 4);
    const all = await f.read(query.replace('limit=1', 'limit=200'));
    let count = all.data.items.length, c = all.data.nextCursor;
    while (c) {
        const page = await f.read(query.replace('limit=1', 'limit=200') + '&cursor=' + encodeURIComponent(c));
        count += page.data.items.length;
        c = page.data.nextCursor;
    }
    assert.equal(seen.size, count);
    assert.ok(count >= 1005);
});
test('scenario 3 — tentative original speech stays unknown and retains its source quote', async (t) => {
    const f = await fixture(t), response = await f.read('q=' + encodeURIComponent('可能') + '&scope=messages');
    const item = response.data.items[0];
    assert.equal(item.excerpt, '我可能在卧室');
    assert.equal(item.state, 'unknown');
    assert.equal(item.confidence, null);
    assert.equal(item.userConfirmed, false);
    assert.equal(item.origin.recordId, 'message-0');
    assert.ok(item.evidenceRefs.includes(item.detailUrl));
});
test('scenario 4 — knowledge modification preserves the original observation and unknown observations remain null', async (t) => {
    const f = await fixture(t), response = await f.read('scope=knowledge');
    const item = response.data.items[0];
    assert.equal(item.updatedAt, updated);
    assert.equal(item.observedAt, observed);
    assert.equal(item.state, 'candidate');
    assert.equal(item.expiresAt, '2026-11-14T10:00:00.000Z');
    const index = f.service.ensure('first', f.roleDirectory('first'));
    index.upsert({ kind: 'recent', item: { id: 'unknown', title: '无观测', focus: '位置', content: '位置', keywords: ['位置'], createdAt: updated, updatedAt: updated } });
    const unknown = await f.read('scope=knowledge&q=' + encodeURIComponent('无观测'));
    assert.equal(unknown.data.items[0].observedAt, null);
});
test('scenario 5 — entity observations and current retrieval times remain distinct', async (t) => {
    const f = await fixture(t), response = await f.read('scope=entities');
    const item = response.data.items[0];
    assert.equal(item.observedAt, observed);
    assert.ok(Date.parse(item.retrievedAt) > Date.parse(observed));
    assert.equal(item.expiresAt, null);
    assert.equal(item.state, 'unknown');
    f.resources[0]!.searchEvidence={state:'candidate',expiresAt:'2026-11-14T10:00:00.000Z',confidence:0.4,evidenceRefs:['/fixture/cache'],conflicts:[]};
    const cached=await f.read('scope=entities&q='+encodeURIComponent('卧室'));
    assert.equal(cached.data.items[0].expiresAt,'2026-11-14T10:00:00.000Z');assert.equal(cached.data.items[0].confidence,0.4);assert.equal(cached.data.items[0].state,'candidate');
    assert.equal(cached.data.coverage.sources[0].conflictCheck,'source_reported');
});
test('scenario 6 — two air conditioners retain separate real resources and readable state/action handles', async (t) => {
    const f = await fixture(t), response = await f.read('q=' + encodeURIComponent('空调') + '&scope=entities');
    assert.equal(response.data.items.length, 2);
    assert.equal(new Set(response.data.items.map((item: any) => item.origin.resourceId)).size, 2);
    for (const item of response.data.items) {
        assert.equal(item.origin.resourceId, item.handle.resourceId);
        assert.ok(item.handle.stateVersion);
        assert.equal((await fetch(f.base + item.handle.stateUrl)).status, 200);
        assert.equal((await fetch(f.base + item.handle.actionsUrl)).status, 200);
    }
    assert.deepEqual(response.data.conflicts, []);
});
test('scenario 7 — explicit owner conflict reports retain comparable candidates and evidence', async (t) => {
    const f = await fixture(t), snapshot = f.registry.catalogSnapshot(), request = new http.IncomingMessage({} as any), lanes = createSearchLanes(f.context, snapshot, request);
    const lane = lanes.find(item => item.source === 'knowledge')!;
    const original = lane.read;
    lane.read = async (options) => { const batch = await original(options); return { ...batch, conflicts: [{ subjectRef: 'home:bedroom', field: 'power', timeRange: { from: observed, to: updated }, reportedBy: 'knowledge', candidates: [{ itemRef: { source: 'knowledge', origin: batch.items[0]!.origin }, value: 'on', evidenceRefs: ['/fixture/on'] }, { itemRef: { source: 'entities', origin: { resourceId: 'home:ha:climate.bedroom' } }, value: 'off', evidenceRefs: ['/fixture/off'] }] }] }; };
    const response = await runUnifiedSearch({ snapshot, query: parseSearchQuery(new URLSearchParams('q=' + encodeURIComponent('空调')), snapshot), lanes });
    assert.equal(response.body.data.conflicts.length, 1);
    assert.equal(response.body.data.conflicts[0]!.candidates.length, 2);
    assert.equal(response.body.data.coverage.sources.find(item => item.source === 'knowledge')!.conflictCheck, 'source_reported');
});
test('scenario 8 — zero keyword hits still disclose the complete catalog and real contract entry', async (t) => {
    const f = await fixture(t), response = await f.read('q=deliberately-no-match');
    assert.deepEqual(response.data.items, []);
    const catalog = await (await fetch(f.base + response.data.capabilities.operationsUrl + '?query=manager.search')).json();
    assert.ok(catalog.data.items.some((item: any) => item.operationId === 'manager.search'));
    assert.equal((await fetch(f.base + response.data.capabilities.contractUrl)).status, 200);
});
test('scenario 9 — strict scope, kinds and all-keyword filters constrain every returned candidate', async (t) => {
    const f = await fixture(t), strict = await f.read('scope=operations&strict=1&q=' + encodeURIComponent('卧室 空调') + '&match=all');
    assert.ok(strict.data.items.length);
    assert.ok(strict.data.items.every((item: any) => item.source === 'operations'));
    const both = await f.read('q=' + encodeURIComponent('卧室 空调') + '&match=all');
    assert.ok(both.data.items.every((item: any) => !item.excerpt.includes('我可能')));
    const climate = await f.read('kind=climate&strict=1&q=' + encodeURIComponent('卧室 空调'));
    assert.ok(climate.data.items.length);
    assert.ok(climate.data.items.every((item: any) => item.kind === 'climate'));
    const sentence = await f.read('q=' + encodeURIComponent('帮我开一下卧室的空调'));
    assert.ok(sentence.data.items.some((item: any) => item.source === 'entities'));
    assert.ok(sentence.data.items.some((item: any) => item.source === 'operations'));
});
test('scenario 10 — a malformed owner item preserves healthy neighbors and accurate coverage', async (t) => {
    const f = await fixture(t), snapshot = f.registry.catalogSnapshot();
    const lanes = createSearchLanes(f.context, snapshot, new http.IncomingMessage({} as any));
    const lane = lanes.find(item => item.source === 'knowledge')!, read = lane.read;
    lane.read = async (options) => { const result = await read(options); result.items.splice(0, 0, { source: 'knowledge', kind: 'recent', agent: 'first', label: '', origin: {}, detailUrl: '', handle: { detailUrl: '' }, excerpt: '', searchText: '空调' }); return result; };
    const response = await runUnifiedSearch({ snapshot, query: parseSearchQuery(new URLSearchParams('q=' + encodeURIComponent('空调')), snapshot), lanes });
    assert.equal(response.status, 200);
    assert.ok(response.body.data.items.length);
    assert.equal(response.body.data.coverage.state, 'partial');
    assertCounts(response.body.data);
});
test('scenario 11 — failed or over-budget sources preserve successful results and report their gaps', async (t) => {
    const f = await fixture(t);
    f.setEntityError(Object.assign(new Error('HA not authorized'), { code: 'xiaomi_home_authorization_required' }));
    const failed = await f.read('q=' + encodeURIComponent('空调'));
    assert.equal(failed.status, 200);
    assert.equal(failed.data.degraded[0].errorCode, 'xiaomi_home_authorization_required');
    assert.equal(failed.data.coverage.sources.find((item: any) => item.source === 'entities').hasMore, null);
    const only = await f.read('scope=entities');
    assert.equal(only.status, 503);
    const g = await fixture(t);
    g.setEntityDelay(100);
    const deadline = await g.read('budgetMs=30&q=' + encodeURIComponent('空调'));
    assert.equal(deadline.status, 200);
    assert.ok(deadline.data.items.length);
    assert.ok(deadline.data.degraded.some((item: any) => item.errorCode === 'DEADLINE_EXCEEDED'));
});
test('scenario 12 — changed source versions invalidate cursors, and page facets match actual items', async (t) => {
    const f = await fixture(t), first = await f.read('scope=knowledge&limit=1');
    assertCounts(first.data);
    assert.ok(first.data.nextCursor);
    f.service.ensure('first', f.roleDirectory('first')).upsert({ kind: 'recent', item: { id: 'new', title: 'new', focus: 'new', content: 'new', keywords: ['new'], createdAt: updated, updatedAt: updated } });
    const expired = await f.read('scope=knowledge&limit=1&cursor=' + encodeURIComponent(first.data.nextCursor));
    assert.equal(expired.status, 409);
    assert.equal(expired.errorCode, 'KNOWLEDGE_CURSOR_EXPIRED');
});
test('optional caller metadata, all-role defaults, unknown roles, reserved scopes and time filtering use one contract', async (t) => {
    const f = await fixture(t);
    for (const headers of [{}, { 'x-rabiroute-agent-type': 'new-type' }, { 'x-rabiroute-agent-type': 'new-type', 'x-rabiroute-session-id': 'new-id' }] as Record<string, string>[]) {
        const response = await f.read('scope=knowledge', headers);
        assert.equal(response.status, 200);
        assert.deepEqual(new Set(response.data.items.map((item: any) => item.agent)), new Set(['first', 'second']));
        assert.equal(response.data.warnings.length, headers['x-rabiroute-session-id'] ? 0 : 1);
    }
    assert.ok((await f.read('scope=knowledge&agent=first')).data.items.every((item: any) => item.agent === 'first'));
    assert.equal((await f.read('agent=absent')).status, 404);
    assert.equal((await f.read('scope=invalid')).errorCode, 'UNKNOWN_SCOPE');
    const reserved = await f.read('scope=events,tasks');
    assert.equal(reserved.status, 200);
    assert.equal(reserved.data.coverage.notQueried.length, 2);
    const future = await f.read('scope=knowledge&from=1999999999');
    assert.deepEqual(future.data.items, []);
    const recent = await f.read('scope=knowledge,entities&sort=recent');
    assert.ok(recent.data.items.every((item: any) => item.observedAt === observed));
    const browse = await f.read('scope=messages&limit=2');
    assert.equal(browse.status, 200);
    assert.equal(browse.data.items.length, 2);
    assert.ok(browse.data.nextCursor);
    const tail = await f.read('scope=messages&limit=2&cursor=' + encodeURIComponent(browse.data.nextCursor));
    assert.equal(tail.status, 200);
    assert.equal(tail.data.items.length, 1);
});
test('one registered search operation is visible and callable through HTTP, OpenAPI, MCP, CLI and the WebGUI catalog client', async (t) => {
    const f = await fixture(t);
    const { createManagerClient } = await import(new URL('../../apps/rabi-agent/lib/manager-client.mjs', import.meta.url).href);
    const { createApiTools } = await import(new URL('../../apps/rabi-mcp/lib/api-tools.mjs', import.meta.url).href);
    const { runManagerCommand } = await import(new URL('../../apps/rabi-agent/lib/manager-cli.mjs', import.meta.url).href);
    const client = createManagerClient({ managerUrl: f.base, credential: 'fixture-only' }), mcp = createApiTools({ client });
    t.after(() => mcp.close());
    const listed = await mcp.call('rabi_api_list', { query: '/api/search' });
    assert.ok(listed.data.operations.some((item: any) => item.id === 'manager.search'));
    const called = await mcp.call('rabi_api_call', { operationId: 'manager.search', options: { query: { q: '空调', scope: 'operations' } } });
    assert.equal(called.ok, true);
    const config = path.join(f.roleDirectory('first'), 'cli.json');
    fs.writeFileSync(config, JSON.stringify({ managerUrl: f.base, nodeCredential: 'fixture-only' }));
    const cli = await runManagerCommand(['--operation', 'manager.search', '--query', JSON.stringify({ q: '空调', scope: 'operations' })], config);
    assert.equal(cli.ok, true);
    const { readApiReference } = await import(new URL('../../ribiwebgui/src/docs/apiReferenceClient.ts', import.meta.url).href);
    const catalog = await readApiReference(new AbortController().signal, (url: string, options: any) => fetch(f.base + url, options));
    assert.ok(catalog.operations.some((item: any) => item.contract.operationId === 'manager.search'));
    const openapi = await (await fetch(f.base + '/api/agent/openapi')).json();
    assert.equal(openapi.paths['/api/search'].get.operationId, 'manager.search');
    const scopes = [...new Set(f.registry.catalogSnapshot().searchSources.map(source => source.scope))];
    assert.deepEqual(new Set(scopes), new Set(['knowledge', 'messages', 'entities', 'operations']));
});

test('role-directory changes fence the original asynchronous result and historical knowledge remains discoverable',async t=>{
  const f=await fixture(t);
  f.service.ensure('first',f.roleDirectory('first')).upsert({kind:'recent',item:{id:'historical',title:'historical',focus:'history',content:'historical evidence',keywords:['historical'],createdAt:observed,updatedAt:observed,consolidatedAt:updated}});
  const historical=await f.read('scope=knowledge&q=historical');assert.equal(historical.status,200);assert.equal(historical.data.items[0].archived,true);
  assert.throws(()=>f.service.ensure('first',f.roleDirectory('first')).candidates({deadlineAt:performance.now()-1}),/DEADLINE_EXCEEDED/);
  let entered!:()=>void,release!:()=>void;
  const arrived=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve),readEntities=f.context.entities;
  f.context.entities=async(request,signal)=>{entered();await held;return readEntities(request,signal);};
  const pending=f.read('q='+encodeURIComponent('空调'));
  await arrived;f.context.roleDirectory=id=>path.join(f.roleDirectory(id),'changed-owner');release();
  const changed=await pending;assert.equal(changed.status,409);assert.equal(changed.errorCode,'SEARCH_SCOPE_CHANGED');
});
