import type { ApiOperationDefinition } from './apiOperationContract.js';
import type { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { parseSearchQuery, runUnifiedSearch, SearchError } from './unifiedSearch.js';
import { createSearchLanes, type UnifiedSearchSourceContext } from './unifiedSearchSources.js';
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from '../plugins/io.rabiroute.manager.persona/src/manager/personaResourceAdmission.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const descriptions = {
    q: 'Free text or keywords. Omit to browse the selected owner views.', scope: 'Comma-separated registered scopes. Default all. Reserved scopes are reported unsupported.',
    kind: 'Comma-separated owner kinds, such as plan, recent, consolidated, group or climate.', agent: 'Optional role scope. Omit to query all roles. Unknown role returns AGENT_NOT_FOUND.',
    adapter: 'Optional message endpoint adapter. Omit for all saved endpoints.', from: 'Inclusive observation time lower bound in Unix seconds.', to: 'Inclusive observation time upper bound in Unix seconds.',
    match: 'any (default) or all keywords.', mode: 'keywords (default) or owner fulltext matching.', strict: '0 (default) or 1. Query only explicitly selected scopes and kinds.',
    limit: 'Page size from 1 to 200. Default 20.', cursor: 'Opaque nextCursor. Keep other filters and limit unchanged. Source changes return 409.',
    budgetMs: 'Total remaining server budget, 1..2147483647 milliseconds. Default 3000.', sort: 'relevance (default) preserves matching sources. recent orders original observation time with modification-time fallback.',
    includeArchives: '0 (default) or 1, selects message archive coverage.', expand: 'Reserved for future synonym expansion. Omit in this version.'
};
const string = { type: 'string' };
const nullableTime = { type: ['string', 'null'] };
const itemSchema = { type: 'object', required: ['source', 'kind', 'agent', 'label', 'excerpt', 'origin', 'detailUrl', 'handle', 'state', 'confidence', 'userConfirmed', 'observedAt', 'retrievedAt', 'expiresAt', 'evidenceRefs', 'sourceKinds', 'score'], properties: {
        source: string, kind: string, agent: { type: ['string', 'null'] }, label: string, excerpt: string, detailUrl: string,
        origin: { type: 'object', minProperties: 1, description: 'Stable identity and original ownership supplied by the source.' },
        handle: { type: 'object', required: ['detailUrl'], properties: { detailUrl: string, operationId: string, contractUrl: string, resourceId: string, stateUrl: string, actionsUrl: string, stateVersion: string } },
        state: { enum: ['confirmed', 'candidate', 'inferred', 'unknown', 'unavailable'], description: 'Original content confirmation state. Ordinary unverified speech remains unknown.' },
        confidence: { type: ['number', 'null'], description: 'Owner-reported fact reliability. Unknown is null.' }, userConfirmed: { type: 'boolean' },
        observedAt: { ...nullableTime, description: 'Original observation time, independently of record modification and retrieval.' }, retrievedAt: { type: 'string', description: 'Time this adapter read the result.' },
        expiresAt: { ...nullableTime, description: 'Owner-provided validity end. Null means unknown.' }, updatedAt: string,
        evidenceRefs: { type: 'array', items: string }, sourceKinds: { type: 'array', items: string }, score: { type: 'number', description: 'Query-local ranking score, with matched terms as the highest weight.' }
    } };
const successSchema = { type: 'object', required: ['code', 'requestId', 'data'], properties: { code: { const: 0 }, requestId: string, data: { type: 'object',
            required: ['capabilities', 'legend', 'facets', 'coverage', 'degraded', 'warnings', 'conflicts', 'items', 'nextCursor'], properties: {
                capabilities: { type: 'object', description: 'Active registered sources, defaults, supported filters and real catalog/contract URLs.' }, legend: { type: 'object' },
                facets: { type: 'object', required: ['countScope'], properties: { countScope: { const: 'page' } } },
                coverage: { type: 'object', required: ['sources', 'notQueried', 'excluded', 'completenessUnknown'], properties: {
                    sources:{type:'array',items:{type:'object'}},notQueried:{type:'array',items:{type:'object'}},excluded:{type:'array',items:{type:'object'}},completenessUnknown:{type:'boolean'}
                }, description: 'Actual source execution and coverage gaps. Page exhaustion is independent of source completeness.' },
                degraded: { type: 'array', items: { type: 'object' } }, warnings: { type: 'array', items: { type: 'object' } }, conflicts: { type: 'array', items: { type: 'object' } },
                items: { type: 'array', items: itemSchema }, nextCursor: { type: ['string', 'null'] }
            } }
    } };
export function createUnifiedSearchOperation(registry: ManagerPluginRouteRegistry, context: UnifiedSearchSourceContext & {
    identity?(): PersonaResourceIdentity;
}): ApiOperationDefinition {
    const schema = { type: 'object', additionalProperties: true };
    return { contract: { operationId: 'manager.search', contractVersion: '1.0.0', method: 'GET', pathTemplate: '/api/search', description: 'Search plans, memories, messages, active operations and device entities. 统一搜索计划、记忆、聊天记录、接口与设备。',
            searchKeywords: ['搜索', '查找', '设备'], exposure: 'public', transport: 'http',
            request: { path: { type: 'object', additionalProperties: false }, query: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(descriptions).map(([name, description]) => [name, { type: 'string', description }])) },
                headers: { type: 'object', additionalProperties: true, properties: { 'x-rabiroute-agent-type': { type: 'string', description: '尽量填调用方类型。 Optional metadata, no registration required.' }, 'x-rabiroute-session-id': { type: 'string', description: '尽量填完整会话 ID。 Optional metadata, no binding required.' } } }, body: { kind: 'none' } },
            responses: { ...Object.fromEntries([400, 403, 404, 409, 503].map(status => [String(status), { mediaType: 'application/json', schema }])), '200': { mediaType: 'application/json', schema: successSchema } },
            effects: { mode: 'read', description: 'Read existing indexed owner views and active contracts. Returns summaries and real handles.' },
            recovery: { strategy: 'versioned-search-cursor', description: 'Restart from the first page after 409. Partial source failures retain successful results and explicit coverage.' }, validators: [] },
        async handler(input) {
            const requestIdHeader = (name: string) => { const value = input.request.headers[name]; return typeof value === 'string' ? value : undefined; };
            try {
                const assertCurrent = preparePersonaResourceAdmission(input.request, input.signal, context.identity);
                const snapshot = registry.catalogSnapshot();
                const query = parseSearchQuery(input.url.searchParams, snapshot);
                const roles=context.roles().filter(role=>!query.agent || role.roleId===query.agent);
                if (query.agent && !roles.length)
                    throw new SearchError(404, 'AGENT_NOT_FOUND', 'Read GET /api/roles and select an existing role.', { repair: 'GET /api/roles' });
                const directories=new Map(roles.map(role=>[role.roleId,context.roleDirectory(role.roleId)]));
                const knowledge=context.knowledge;
                const scopedContext={...context,roles:()=>roles,knowledge,roleDirectory:(roleId:string)=>directories.get(roleId)!};
                const result = await runUnifiedSearch({ query, snapshot, lanes: createSearchLanes(scopedContext, snapshot, input.request, query.agent), signal: input.signal,
                    identity: { agentType: requestIdHeader('x-rabiroute-agent-type'), id: requestIdHeader('x-rabiroute-session-id') } });
                assertCurrent();
                const roleSources=result.body.data.coverage.sources.some(source=>source.source==='knowledge' || source.source==='messages');
                const currentRoles=context.roles().filter(role=>!query.agent || role.roleId===query.agent);
                if(roleSources && (knowledge!==context.knowledge || roles.length!==currentRoles.length
                    || roles.some(role=>!currentRoles.some(current=>current.roleId===role.roleId)
                    || path.resolve(context.roleDirectory(role.roleId))!==path.resolve(directories.get(role.roleId)!)))) {
                    throw new SearchError(409,'SEARCH_SCOPE_CHANGED','The original role catalog or index owner changed. Restart the query.');
                }
                return { ...result, headers: { 'cache-control': 'no-store' } };
            }
            catch (error) {
                input.signal?.throwIfAborted();
                if (error instanceof SearchError)
                    return { status: error.status, headers: { 'cache-control': 'no-store' }, body: { code: -1, requestId: randomUUID(), errorCode: error.code, message: error.message, ...error.details } };
                throw error;
            }
        }
    };
}
