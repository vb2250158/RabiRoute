import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { nativeHttpTestFetch } from './nativeHttpTestClient.js';
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
import { unifiedSearchDefaults, unifiedSearchLimits } from '../shared/unifiedSearchContract.js';
import { createSearchLanes } from './unifiedSearchSources.js';
import { createPersonaSkillOperations } from '../plugins/io.rabiroute.manager.persona/src/manager/personaSkillOperations.js';
import { createPersonaHistoryOperations } from '../plugins/io.rabiroute.manager.persona/src/manager/personaHistoryOperations.js';
import { createPersonaIdentityOperations } from '../plugins/io.rabiroute.manager.persona/src/manager/personaIdentityOperations.js';
import { appendPersonaChatReply } from '../personaChatHistory.js';
import { updateIdentityRelation } from '../identityRelations.js';
import { updatePersonaVoiceIdentity } from '../personaVoiceIdentities.js';
import { recordConversationSituation } from '../conversationSituationStore.js';
import { conversationSituationForIdentity } from '../routing/conversationSituation.js';
import { listRoleSkills, getRoleSkill } from '../roleKnowledge.js';
const observed = '2026-11-12T10:00:00.000Z', updated = '2026-11-13T10:00:00.000Z';
test('role Skills share one native searchable source on every host and retain real detail handles', async t => {
    const f = await fixture(t, 1000);
    const skillRoot = path.join(f.roleDirectory('first'), 'skills', 'packaging-guide');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: packaging-guide\ndescription: 打包发布、核验交付与群聊回执\n---\n\n# 打包工作流\n\nOriginal full body stays in its owner.\n');
    const registration = f.registry.registerOperations('skill-owner', createPersonaSkillOperations({
        roleDirectory: f.roleDirectory,
        querySkills: async (directory, id) => id ? getRoleSkill(directory, id) : listRoleSkills(directory),
        archive: async () => { throw new Error('Archive is outside this search fixture.'); }, reportCleanupError: () => {}
    }));
    t.after(() => registration.dispose());
    const result = await f.read('scope=skills&q=' + encodeURIComponent('打包') + '&agent=first');
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 1);
    const item = result.data.items[0];
    assert.equal(item.source, 'skills');
    assert.equal(item.origin.skillId, 'packaging-guide');
    assert.equal(item.agent, 'first');
    assert.equal(item.handle.operationId, 'manager.personas.skills.detail');
    const detail = await (await nativeHttpTestFetch(f.base + item.handle.detailUrl)).json();
    assert.match(detail.data.content, /Original full body/);
    assert.doesNotMatch(item.excerpt, /Original full body/);
    const mixed = await f.read('agent=first&limit=20');
    assert.ok(mixed.data.items.some((entry: any) => entry.source === 'skills'), 'Skills remain visible alongside a large message corpus.');
    assert.equal((await f.read('scope=skills&q=' + encodeURIComponent('打包') + '&agent=second')).data.items.length, 0);
    await registration.dispose();
    assert.equal((await f.read('scope=skills&q=' + encodeURIComponent('打包'))).status, 400);
});

test('an appended and backdated message does not invalidate or shift the original search continuation', async t => {
    const f = await fixture(t, 7);
    const query = 'scope=messages&agent=first&limit=2&q=' + encodeURIComponent('空调');
    const first = await f.read(query);
    assert.equal(first.status, 200);
    assert.ok(first.data.nextCursor);
    const file = path.join(f.roleDirectory('first'), 'conversation', 'current.jsonl');
    fs.appendFileSync(file, JSON.stringify({ schemaVersion: 1, id: 'backdated-new', sequence: 8, time: 1794477601, direction: 'inbound', adapter: 'voice', conversationKey: 'group:test', kind: 'group', text: '卧室 空调 新追加' }) + '\n');
    refreshMessageHistoryIndex(f.roleDirectory('first'), path.join(f.roleDirectory('first'), 'fixture.sqlite'));
    const items = [...first.data.items];
    let cursor = first.data.nextCursor;
    while (cursor) {
        const page = await f.read(query + '&cursor=' + encodeURIComponent(cursor));
        assert.equal(page.status, 200, JSON.stringify(page));
        items.push(...page.data.items); cursor = page.data.nextCursor;
    }
    assert.equal(items.length, 6);
    assert.equal(new Set(items.map(item => item.origin.recordId)).size, 6);
    assert.ok(!items.some(item => item.origin.recordId === 'backdated-new'));
    const refreshed = await f.read('scope=messages&agent=first&limit=20&q=' + encodeURIComponent('空调'));
    assert.ok(refreshed.data.items.some((item: any) => item.origin.recordId === 'backdated-new'));
});

test('unknown plugin data sources register without host edits and retire with their real operation', async t => {
    const f = await fixture(t);
    const source = f.registry.registerOperations('new-atlas-data-owner', [{
        contract: fixtureApiContract({ operationId: 'new.atlas.catalog', method: 'GET', pathTemplate: '/api/new-atlas/catalog',
            searchable: { scope: 'new-atlas', legend: '插件地图', kinds: ['map'] } }),
        searchLanes: () => [{ key: 'catalog', source: 'new-atlas', agent: null, read: async () => ({ version: 'one', complete: true,
            items: [{ source: 'new-atlas', kind: 'map', agent: null, label: '星图地图', excerpt: '真实插件数据', searchText: '星图地图',
                origin: { mapId: 'first' }, detailUrl: '/api/new-atlas/catalog', handle: { detailUrl: '/api/new-atlas/catalog' } }] }) }],
        handler: () => ({ status: 200, body: {} })
    }]);
    t.after(() => source.dispose());
    const result = await f.read('scope=new-atlas&q=' + encodeURIComponent('星图'));
    assert.equal(result.data.items[0].source, 'new-atlas');
    assert.ok(result.data.capabilities.scopes.includes('new-atlas'));
    const broken = f.registry.registerOperations('independent-broken-search-owner', [{
        contract: fixtureApiContract({ operationId: 'new.broken.catalog', method: 'GET', pathTemplate: '/api/new-broken',
            searchable: { scope: 'new-broken', legend: '坏来源', kinds: ['map'] } }),
        searchLanes: () => { throw new Error('OWNER_SEARCH_UNAVAILABLE'); }, handler: () => ({ status: 200, body: {} })
    }]);
    t.after(() => broken.dispose());
    const partial = await f.read('scope=new-atlas,new-broken&q=' + encodeURIComponent('星图'));
    assert.equal(partial.status, 200);
    assert.equal(partial.data.items[0].source, 'new-atlas');
    assert.ok(partial.data.degraded.some((entry: any) => entry.source === 'new-broken'));
    await source.dispose();
    assert.equal((await f.read('scope=new-atlas')).status, 400);
});
test('message and identity search use original role records, types and exact detail handles', async t => {
    const f = await fixture(t, 0, true);
    const role = f.roleDirectory('first');
    const delivery = await appendPersonaChatReply(role, {
        sessionId: 'sender-task', sessionTitle: '控制面协调', text: '最近投递正文标识',
        kind: 'agent_delivery', deliveryId: 'original-delivery', targetSessionId: 'target-task', targetSessionTitle: '目标任务标题'
    });
    assert.ok(delivery);
    const file = path.join(role, 'conversation', 'current.jsonl');
    fs.appendFileSync(file, JSON.stringify({ schemaVersion: 1, id: 'endpoint-reply', sequence: 1, time: 1794477600,
        direction: 'outbound', adapter: 'napcat', conversationKey: 'group:test', kind: 'reply_sent',
        sender: '测试回复者', target: '测试目标群', text: '无关的正文' }) + '\n');
    refreshMessageHistoryIndex(role, path.join(role, 'fixture.sqlite'));
    updateIdentityRelation(role, { kind: 'participant', participantId: 'person', participantKind: 'person',
        displayName: '测试人物', aliases: ['唯一人物别名'], status: 'candidate' });
    updatePersonaVoiceIdentity(role, { sourceHostId: 'voice-host', voiceprintId: 'test-voice', displayName: '测试声纹' });
    const situation = recordConversationSituation(role, '特定路由标识', 'group_message',
        conversationSituationForIdentity(undefined, { conversationId: 'original-conversation', messageIds: ['situation-message'] }))!;

    const search = (scope: string, q: string, filters = {}) => f.read(new URLSearchParams({ scope, q, agent: 'first', ...filters }).toString());
    const chat = await search('messages', '目标任务标题', { kind: 'agent_delivery' });
    assert.equal(chat.status, 200, JSON.stringify(chat));
    assert.equal(chat.data.items.length, 1);
    assert.equal(chat.data.items[0].origin.recordId, delivery.id);
    await appendPersonaChatReply(role, { sessionId: 'later', turnId: 'later-turn', text: 'Later append does not shift the original detail offset' });
    const detail = await (await nativeHttpTestFetch(f.base + chat.data.items[0].handle.detailUrl)).json();
    assert.deepEqual(detail.data.entries.map((entry: any) => entry.id), [delivery.id]);
    assert.equal((await search('messages', '测试回复者', { kind: 'reply_sent' })).data.items[0].origin.recordId, 'endpoint-reply');
    const narrowed = await search('all', '最近投递正文标识', { adapter: 'napcat' });
    assert.ok(narrowed.data.items.every((item: any) => item.origin.ledger !== 'persona-chat-history'));
    assert.ok(narrowed.data.coverage.excluded.some((entry: any) => entry.source === 'identities'));

    const identity = await search('identities', '唯一人物别名');
    assert.equal(identity.data.items[0].kind, 'participant');
    assert.equal(identity.data.items[0].state, 'candidate');
    assert.equal((await f.read('scope=identities&agent=second')).data.items.length, 0);
    const voice = await search('identities', '测试声纹', { kind: 'voice_identity' });
    assert.equal(voice.data.items[0].handle.operationId, 'manager.personas.identities.voice.read');
    const voiceDetail = await (await nativeHttpTestFetch(f.base + voice.data.items[0].handle.detailUrl)).json();
    assert.equal(voiceDetail.data.identity.voiceprintId, 'test-voice');
    const scenarios = await search('scenarios', '特定路由标识');
    assert.equal(scenarios.data.items[0].origin.recordId, situation.id);
    const scenarioDetail = await (await nativeHttpTestFetch(f.base + scenarios.data.items[0].handle.detailUrl)).json();
    assert.equal(scenarioDetail.data.id, situation.id);
});

async function fixture(t: test.TestContext, messageCount = 3, nativeRoleHistory = false) {
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
    registrations.push(registry.registerOperations('message-owner', nativeRoleHistory
        ? createPersonaHistoryOperations({ roleDir: roleDirectory, readTasks: () => [], query: async () => { throw new Error('Voice transcripts are outside this fixture.'); }, queryHistory: context.queryHistory })
        : [define('fixture.messages', '/fixture/messages', { scope: 'messages', legend: '原始聊天记录', kinds: ['group'] })]));
    if (nativeRoleHistory) registrations.push(registry.registerOperations('identity-owner', createPersonaIdentityOperations({ roleDirectory })));
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
    const read = async (query: string, headers?: Record<string, string>) => { const response = await nativeHttpTestFetch(base + '/api/search?' + query, { headers }); return { status: response.status, ...await response.json() }; };
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
    const f = await fixture(t, 1000), query = 'q=' + encodeURIComponent('卧室 空调') + '&limit=1&budgetMs=10000';
    let cursor: string | null = null;
    const seen = new Set<string>(), sources: string[] = [];
    do {
        const response = await f.read(query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        assert.equal(response.status, 200, JSON.stringify({ seen: seen.size, errorCode: response.errorCode, source: response.source, message: response.message }));
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
        assert.equal((await nativeHttpTestFetch(f.base + item.handle.stateUrl)).status, 200);
        assert.equal((await nativeHttpTestFetch(f.base + item.handle.actionsUrl)).status, 200);
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
    const catalog = await (await nativeHttpTestFetch(f.base + response.data.capabilities.operationsUrl + '?query=manager.search')).json();
    assert.ok(catalog.data.items.some((item: any) => item.operationId === 'manager.search'));
    assert.equal((await nativeHttpTestFetch(f.base + response.data.capabilities.contractUrl)).status, 200);
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
test('scenario 12b — a knowledge write outside this page keeps the cursor runnable', async (t) => {
    const f = await fixture(t), query = 'scope=knowledge&q=' + encodeURIComponent('卧室');
    const first = await f.read(query + '&limit=1');
    assert.equal(first.status, 200);
    assert.ok(first.data.nextCursor);
    const index = f.service.ensure('first', f.roleDirectory('first')), version = index.status().version;
    index.upsert({ kind: 'recent', item: { id: 'unrelated', title: 'unrelated', focus: 'unrelated', content: 'nothing matching this query', keywords: ['unrelated'], createdAt: updated, updatedAt: updated } });
    assert.notEqual(index.status().version, version);
    const next = await f.read(query + '&limit=1&cursor=' + encodeURIComponent(first.data.nextCursor));
    assert.equal(next.status, 200, JSON.stringify({ errorCode: next.errorCode, source: next.source, message: next.message }));
    assert.ok(next.data.items.length);
    const keys = [...first.data.items, ...next.data.items].map((item: any) => JSON.stringify([item.source, item.origin]));
    assert.equal(new Set(keys).size, keys.length);
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
    assert.equal(reserved.data.coverage.state, 'partial');
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
test('declared defaults and page bounds are the shared contract the parser enforces', async (t) => {
    const f = await fixture(t);
    const declared = await f.read('scope=knowledge');
    assert.equal(declared.status, 200);
    assert.deepEqual(declared.data.capabilities.defaults, unifiedSearchDefaults);
    assert.ok(declared.data.items.length <= unifiedSearchDefaults.limit);
    const bounded = await f.read(`scope=knowledge&limit=${unifiedSearchLimits.limit}`);
    assert.equal(bounded.status, 200);
    for (const limit of [0, unifiedSearchLimits.limit + 1]) {
        const rejected = await f.read(`scope=knowledge&limit=${limit}`);
        assert.equal(rejected.status, 400, `limit=${limit}`);
        assert.equal(rejected.errorCode, 'SEARCH_PARAMETER_INVALID');
    }
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
    const catalog = await readApiReference(new AbortController().signal, (url: string, options: any) => nativeHttpTestFetch(f.base + url, options));
    assert.ok(catalog.operations.some((item: any) => item.contract.operationId === 'manager.search'));
    const openapi = await (await nativeHttpTestFetch(f.base + '/api/agent/openapi')).json();
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


test('a newly registered plugin owns searchable task semantics and executable parameter sources across entry points', async t => {
  const f = await fixture(t, 0);
  const empty = { type: 'object', additionalProperties: false };
  const resultSchema = { mediaType: 'application/json', schema: { type: 'object', additionalProperties: true } };
  const resourceId = '星图-map-1';
  const definitions = [
    { contract: fixtureApiContract({ operationId: 'new.StarAtlas.maps', method: 'GET', pathTemplate: '/api/new-star-atlas/maps', description: 'Read star atlas maps.',
        request: { path: empty, query: empty, headers: { type: 'object' }, body: { kind: 'none' } }, responses: { '200': resultSchema },
        effects: { mode: 'read', description: 'Read this plugin map inventory.' } }),
      discovery: { title: '星图地图列表', summary: '列出该插件可预览的地图及真实 ID。', category: { id: 'new.star-atlas', title: '星图' }, keywords: ['星图 地图', 'star atlas maps'] },
      handler: () => ({ status: 200, body: { code: 0, data: { maps: [{ id: resourceId }] } } }) },
    { contract: fixtureApiContract({ operationId: 'new.StarAtlas.preview', method: 'GET', pathTemplate: '/api/new-star-atlas/maps/:mapId', description: 'Read a map preview.',
        request: { path: { type: 'object', required: ['mapId'], properties: { mapId: { type: 'string', minLength: 1 } }, additionalProperties: false }, query: empty, headers: { type: 'object' }, body: { kind: 'none' } },
        responses: { '200': resultSchema }, effects: { mode: 'read', description: 'Read the chosen map preview.' } }),
      discovery: { title: '预览星图地图', summary: '从地图目录取得 ID，读取对应星图预览。', category: { id: 'new.star-atlas', title: '星图' },
        keywords: ['星图 预览', 'star atlas preview'], inputSources: [{ field: 'path.mapId', operationId: 'new.StarAtlas.maps', resultPath: '/data/maps', valuePath: '/id' }], relatedOperations: ['new.StarAtlas.maps'],
        examples: [{ title: '按目录 ID 读取', input: { path: { mapId: resourceId } } }] },
      handler: (input: { path: Readonly<Record<string, string>> }) => ({ status: 200, body: { code: 0, data: { id: input.path.mapId, preview: 'actual-plugin-preview' } } }) },
  ];
  const registration = f.registry.registerOperations('new-plugin-with-no-host-keyword-entry', definitions);
  t.after(() => registration.dispose());
  const query = '星图 预览';
  const unified = await f.read(new URLSearchParams({ q: query, scope: 'operations', match: 'all' }).toString());
  const directory = await (await nativeHttpTestFetch(f.base + '/api/agent/operations?' + new URLSearchParams({ query, match: 'all' }))).json();
  assert.deepEqual(unified.data.items.map((item: any) => item.handle.operationId), directory.data.items.map((item: any) => item.operationId));
  assert.equal(unified.data.items[0].label, '预览星图地图');
  assert.equal(unified.data.items[0].handle.discoveryQuality.state, 'complete');
  const { createManagerClient } = await import(new URL('../../apps/rabi-agent/lib/manager-client.mjs', import.meta.url).href);
  const client = createManagerClient({ managerUrl: f.base, credential: 'fixture-only' });
  const described = await client.operations.describe(unified.data.items[0].handle.operationId);
  const source = described.operation.discovery.inputSources[0];
  const inventory = await client.operations.call(source.operationId);
  const actualId = inventory.data.data.maps[0].id;
  assert.equal(actualId, resourceId);
  const called = await client.operations.call(described.operation.id, { path: { mapId: actualId } });
  assert.equal(called.data.data.preview, 'actual-plugin-preview');
  const english = await f.read('scope=operations&match=all&q=star%20atlas%20preview');
  assert.equal(english.data.items[0].handle.operationId, described.operation.id);
  const ties = f.registry.registerOperations('new-tied-operations', ['a', 'A', 'z'].map(id => ({
    contract: fixtureApiContract({ operationId: 'new.tied.' + id, method: 'GET', pathTemplate: '/api/new-tied/' + id,
      description: 'Read a provider selection.', request: { path: empty, query: { type: 'object', properties: { provider: { enum: ['new-gazelle-provider'] } } }, headers: { type: 'object' }, body: { kind: 'none' } }, responses: { '200': resultSchema } }),
    discovery: { title: '同分目录记录', summary: '读取插件选择。', category: { id: 'new.tied', title: '同分目录' }, keywords: ['同分目录'] },
    handler: () => ({ status: 200, body: { code: 0 } })
  })));
  const sameQuery = 'new-gazelle-provider';
  const sameUnified = await f.read('scope=operations&match=all&q=' + sameQuery);
  const sameDirectory = await (await nativeHttpTestFetch(f.base + '/api/agent/operations?' + new URLSearchParams({ query: sameQuery, match: 'all' }))).json();
  assert.deepEqual(sameUnified.data.items.map((item: any) => item.handle.operationId), ['new.tied.A', 'new.tied.a', 'new.tied.z']);
  assert.deepEqual(sameUnified.data.items.map((item: any) => item.handle.operationId), sameDirectory.data.items.map((item: any) => item.operationId));
  await ties.dispose();
  const cursor = (await f.read('scope=operations&limit=1&q=star%20atlas')).data.nextCursor;
  await registration.dispose();
  const unloaded = await f.read('scope=operations&q=' + encodeURIComponent(query));
  assert.equal(unloaded.data.items.length, 0);
  const staleCursor = await f.read('scope=operations&limit=1&q=star%20atlas&cursor=' + encodeURIComponent(cursor));
  assert.equal(staleCursor.status, 409);
});
