import type http from 'node:http';
import { apiDigest } from './apiOperationContract.js';
import type { ApiCatalogSnapshot } from './apiOperationCatalog.js';
import type { KnowledgeSearchService } from './knowledgeSearchService.js';
import type { MessageEndpointHistoryContext } from '../plugins/io.rabiroute.manager.persona/src/manager/messageEndpointHistoryRoutes.js';
import type { HomeDeviceDirectory } from '../shared/homeDeviceDirectoryContract.js';
import type { XiaomiHomeResource } from '../plugins/io.rabiroute.manager.xiaomi-home/src/integrations/xiaomiHome/managerApi.js';
import type { SearchBatch, SearchItem, SearchLane } from './unifiedSearch.js';
import { operationSearchText, searchTerms } from './searchText.js';
import { normalizeSearchEvidence, type SearchConflict } from '../shared/searchEvidence.js';
export type UnifiedSearchSourceContext = {
    roles(): readonly {
        roleId: string;
    }[];
    roleDirectory(roleId: string): string;
    knowledge?: KnowledgeSearchService;
    queryHistory: MessageEndpointHistoryContext['queryHistory'];
    entities(request: http.IncomingMessage, signal: AbortSignal): Promise<HomeDeviceDirectory<XiaomiHomeResource>>;
};
/** Each adapter reads its original owner. Only candidate summaries enter the query response. */
export function createSearchLanes(context: UnifiedSearchSourceContext, snapshot: ApiCatalogSnapshot, request: http.IncomingMessage, agent?: string): SearchLane[] {
    const roles = context.roles().filter(role => !agent || role.roleId === agent);
    const lanes: SearchLane[] = roles.flatMap(({ roleId }) => [
            { key: 'knowledge:' + roleId, source: 'knowledge', agent: roleId, async read({ query, signal,deadlineAt }) {
                signal.throwIfAborted();
                if (!context.knowledge)
                    throw new Error('KNOWLEDGE_INDEX_WARMING');
                const index = context.knowledge.ensure(roleId, context.roleDirectory(roleId));
                const result = index.candidates({ query: query.q || undefined, mode: query.mode, match: query.match, signal,deadlineAt });
                const status = context.knowledge.status(context.roleDirectory(roleId));
                const errors = 'errors' in status ? status.errors : 0;
                const conflicts = result.items.flatMap(item => item.searchEvidence?.conflicts ?? []);
                return { version: String(result.version), complete: errors === 0, gaps: errors ? [{ code: 'KNOWLEDGE_COVERAGE_PARTIAL', message: `${errors} knowledge records could not be read.` }] : [], ...(result.items.some(item=>item.searchEvidence?.conflicts!==undefined) ? { conflicts } : {}), items: result.items.map(item => ({
                        source: 'knowledge', kind: item.kind, agent: roleId, label: item.title, excerpt: item.excerpt, updatedAt: item.updatedAt,archived:item.archived,...(item.status?{status:item.status}:{}),
                        origin: { agent: roleId, kind: item.kind, recordId: item.id }, detailUrl: item.detailUrl, handle: { detailUrl: item.detailUrl },
                        searchText: item.searchText, evidence: item.searchEvidence
                    })) };
            } },
        { key: 'messages:' + roleId, source: 'messages', agent: roleId, async read({ query, signal, deadlineAt, position }) {
                signal.throwIfAborted();
                const result = await context.queryHistory(context.roleDirectory(roleId), {
                    limit: query.limit + 1, maxChars: 200000, query: query.q ? searchTerms(query.q).join(' ') : undefined, queryMatch: query.match, adapter: query.adapter,
                    from: query.from, to: query.to, includeArchives: query.includeArchives,
                    unified: { sort: query.sort, offset: position, kinds: query.kinds }
                }, { signal, deadlineAt });
                if (Array.isArray(result) || !result.page)
                    throw new Error('MESSAGE_HISTORY_TIMELINE_UNAVAILABLE');
                const items: SearchItem[] = [], gaps: NonNullable<SearchBatch['gaps']> = [];
                for (const [recordIndex, record] of result.entries.entries()) {
                    const recordId = record.id || (record.messageId !== undefined ? String(record.messageId) : record.sequence !== undefined ? 'sequence:' + record.sequence : undefined);
                    const observation=new Date(record.time*1000);
                    if (!recordId || !record.adapter || !record.conversationKey || typeof record.text !== 'string' || !Number.isFinite(observation.getTime())) {
                        gaps.push({ code: 'SEARCH_ITEM_UNAVAILABLE', message: 'A message lacks content, conversation identity or a stable record ID.' });
                        continue;
                    }
                    const params = new URLSearchParams({ adapter: record.adapter, conversationKey: record.conversationKey, from: String(record.time), to: String(record.time), includeArchives: query.includeArchives ? '1' : '0', limit: '200' });
                    const detailUrl = '/api/roles/' + encodeURIComponent(roleId) + '/message-endpoint-timeline?' + params;
                    items.push({ source: 'messages', kind: record.kind ?? 'message', agent: roleId, label: record.text.slice(0, 120), excerpt: record.text, sourcePosition: position + recordIndex,
                        origin: { agent: roleId, adapter: record.adapter, conversationKey: record.conversationKey, recordId, messageTime: observation.toISOString() },
                        detailUrl, handle: { detailUrl }, searchText: record.text, evidence: { state: 'unknown', observedAt: observation.toISOString() } });
                }
                return { items, gaps, version: apiDigest({ index: result.coverage.indexVersion, source: result.coverage.sourceVersion }),
                    complete: result.coverage.indexCoverage === 'complete' && !result.coverage.legacyCoverageUnknown,
                    windowStart: position, hasMore: Boolean(result.page.nextCursor), recordsRead: result.entries.length };
            } }
    ]);
    lanes.push({ key: 'operations', source: 'operations', agent: null, async read({ signal }) {
            signal.throwIfAborted();
            return { version: snapshot.catalogDigest, complete: snapshot.coverage.complete, items: snapshot.operations.map(({ contract, discovery }) => {
                    const detailUrl = '/api/agent/help?operationId=' + encodeURIComponent(contract.operationId);
                    return { source: 'operations', kind: 'operation', agent: null, label: contract.operationId, excerpt: contract.description,
                        origin: { operationId: contract.operationId, catalogSource: 'active-api-catalog', method: contract.method, pathTemplate: contract.pathTemplate }, detailUrl,
                        handle: { detailUrl, operationId: contract.operationId, contractUrl: detailUrl }, searchText: operationSearchText(contract, discovery),
                        evidence: { state: 'confirmed', evidenceRefs: [detailUrl], observedAt: null } };
                }) };
        } });
    lanes.push({ key: 'entities', source: 'entities', agent: null, async read({ signal }) {
            const directory = await context.entities(request, signal);
            const entries = [...directory.devices.flatMap(device => device.resources.map(resource => ({ resource, deviceId: device.deviceId, deviceText: [device.displayName, device.areaName, device.model, device.manufacturer].join(' ') }))),
                ...directory.unassignedResources.map(resource => ({ resource, deviceId: null, deviceText: '' }))];
            const gaps: NonNullable<SearchBatch['gaps']> = [], items: SearchItem[] = [];
            for (const { resource, deviceId, deviceText } of entries) {
                if (!resource?.resourceId || !resource.displayName) {
                    gaps.push({ code: 'SEARCH_ITEM_UNAVAILABLE', message: 'An entity lacks a resource ID or content.' });
                    continue;
                }
                const detailUrl = '/api/agent/xiaomi-home/resources/' + encodeURIComponent(resource.resourceId);
                const actionsUrl = '/api/agent/xiaomi-home/entity-actions?resourceId=' + encodeURIComponent(resource.resourceId);
                items.push({ source: 'entities', kind: resource.kind, agent: null, label: resource.displayName, excerpt: resource.state,
                    origin: { integration: 'xiaomi-home', resourceId: resource.resourceId, deviceId, stateUrl: detailUrl }, detailUrl,
                    handle: { detailUrl, resourceId: resource.resourceId, stateUrl: detailUrl, actionsUrl, ...(resource.stateVersion ? { stateVersion: resource.stateVersion } : {}) },
                    searchText: [resource.resourceId, resource.displayName, resource.kind, resource.state, deviceText, JSON.stringify(resource.attributes)].join(' '),
                    evidence: { state: 'unknown', observedAt: resource.observedAt ?? null,...normalizeSearchEvidence(resource.searchEvidence) } });
            }
            const conflicts=entries.flatMap(({resource})=>normalizeSearchEvidence(resource.searchEvidence)?.conflicts ?? []);
            return { items, gaps, complete: true,...(entries.some(({resource})=>normalizeSearchEvidence(resource.searchEvidence)?.conflicts!==undefined)?{conflicts}:{}), version: apiDigest(JSON.parse(JSON.stringify(entries.map(({ resource, deviceId, deviceText }) => ({ resource, deviceId, deviceText }))))) };
        } });
    return lanes;
}
