import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { apiDigest } from './apiOperationContract.js';
import type { ApiCatalogSnapshot } from './apiOperationCatalog.js';
import { normalizeSearchText, searchTerms, textMatches } from './searchText.js';
import { normalizeSearchEvidence, type SearchEvidence, type SearchConflict } from '../shared/searchEvidence.js';
export type SearchItem = {
    source: string;
    kind: string;
    agent: string | null;
    label: string;
    excerpt: string;
    origin: Record<string, unknown>;
    detailUrl: string;
    handle: {
        detailUrl: string;
        [key: string]: unknown;
    };
    evidence?: SearchEvidence;
    updatedAt?: string;
    archived?:boolean;
    status?:string;
    searchText: string;
    sourcePosition?: number;
};
export type SearchBatch = {
    items: SearchItem[];
    version: string;
    complete: boolean;
    conflicts?: SearchConflict[];
    gaps?: {
        code: string;
        message: string;
    }[];
    windowStart?: number;
    hasMore?: boolean;
    recordsRead?: number;
};
export type SearchLane = {
    key: string;
    source: string;
    agent: string | null;
    read(options: {
        signal: AbortSignal;
        deadlineAt: number;
        query: SearchQuery;
        position: number;
    }): Promise<SearchBatch>;
};
export type SearchQuery = {
    q: string;
    scopes: string[];
    kinds: string[];
    agent?: string;
    adapter?: string;
    from?: number;
    to?: number;
    match: 'any' | 'all';
    mode: 'keywords' | 'fulltext';
    strict: boolean;
    limit: number;
    cursor?: string;
    budgetMs: number;
    sort: 'relevance' | 'recent';
    includeArchives: boolean;
};
export class SearchError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
const reservedScopes = ['events', 'identities', 'scenarios', 'tasks'];
const values = (value: string | null) => [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))].sort();
export function parseSearchQuery(params: URLSearchParams, snapshot: ApiCatalogSnapshot): SearchQuery {
    const scopes = [...new Set(snapshot.searchSources.map(source => source.scope))].sort();
    const requested = values(params.get('scope'));
    const unknown = requested.filter(scope => scope !== 'all' && !scopes.includes(scope) && !reservedScopes.includes(scope));
    if (unknown.length)
        throw new SearchError(400, 'UNKNOWN_SCOPE', 'Select registered search scopes.', { legalValues: scopes, reservedScopes, unknown });
    const integer = (key: string, fallback: number, maximum: number) => {
        const raw = params.get(key);
        if (raw === null)
            return fallback;
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum)
            throw new SearchError(400, 'SEARCH_PARAMETER_INVALID', `${key} must be an integer from 1 to ${maximum}.`, { field: key });
        return Number(raw);
    };
    const choice = <T extends string>(key: string, choices: readonly T[], fallback: T): T => {
        const raw = params.get(key) ?? fallback;
        if (!choices.includes(raw as T))
            throw new SearchError(400, 'SEARCH_PARAMETER_INVALID', `Invalid ${key}.`, { field: key, legalValues: choices });
        return raw as T;
    };
    const time = (key: string) => {
        if (!params.has(key))
            return undefined;
        if (!params.get(key)?.trim() || !Number.isFinite(Number(params.get(key))))
            throw new SearchError(400, 'SEARCH_PARAMETER_INVALID', `${key} must be Unix seconds.`, { field: key });
        return Number(params.get(key));
    };
    const from = time('from'), to = time('to');
    if (from !== undefined && to !== undefined && from > to)
        throw new SearchError(400, 'SEARCH_PARAMETER_INVALID', 'from must be at most to.');
    if (params.has('expand'))
        throw new SearchError(400, 'SEARCH_EXPANSION_UNSUPPORTED', 'Synonym expansion is reserved for a later version. Omit expand.');
    return { q: params.get('q')?.trim() ?? '', scopes: !requested.length || requested.includes('all') ? [...new Set([...scopes, ...requested.filter(scope => scope !== 'all')])] : requested,
        kinds: values(params.get('kind')), agent: params.get('agent') || undefined, adapter: params.get('adapter') || undefined, from, to,
        match: choice('match', ['any', 'all'], 'any'), mode: choice('mode', ['keywords', 'fulltext'], 'keywords'), strict: choice('strict', ['0', '1'], '0') === '1',
        limit: integer('limit', 20, 200), cursor: params.get('cursor') || undefined, budgetMs: integer('budgetMs', 3000, 2147483647),
        sort: choice('sort', ['relevance', 'recent'], 'relevance'), includeArchives: choice('includeArchives', ['0', '1'], '0') === '1' };
}
type Cursor = {
    version: 1;
    manager: string;
    generation: string;
    filters: string;
    queryTime: string;
    versions: Record<string, string>;
    inventories: Record<string, string>;
    positions: Record<string, number>;
    rotation: number;
};
type RankedItem = Omit<SearchItem, 'evidence' | 'searchText'> & Required<Omit<SearchEvidence, 'sourceKinds' | 'conflicts'>> & {
    sourceKinds: string[];
    retrievedAt: string;
    score: number;
    key: string;
    sortTime: number;
    sortKey: string;
};
function readCursor(query: SearchQuery, snapshot: ApiCatalogSnapshot, filters: string): Cursor | undefined {
    if (!query.cursor)
        return undefined;
    let value: Cursor;
    try {
        value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    }
    catch {
        throw new SearchError(400, 'SEARCH_CURSOR_INVALID', 'Use the opaque nextCursor from the previous response.');
    }
    if (!value || value.version !== 1 || typeof value.versions !== 'object' || !value.versions || Array.isArray(value.versions) || typeof value.positions !== 'object' || !value.positions || Array.isArray(value.positions)
        || Object.values(value.positions).some(position=>!Number.isSafeInteger(position) || position<0)
        || !value.inventories || !Number.isSafeInteger(value.rotation) || value.rotation < 0 || !Number.isFinite(Date.parse(value.queryTime))) {
        throw new SearchError(400, 'SEARCH_CURSOR_INVALID', 'The search cursor is malformed.');
    }
    if (value.filters !== filters)
        throw new SearchError(400, 'SEARCH_CURSOR_INVALID', 'Keep the original search filters and page size.');
    if (value.manager !== snapshot.managerInstanceId || value.generation !== snapshot.applicationGenerationId)
        throw new SearchError(409, 'SEARCH_CURSOR_EXPIRED', 'Rediscover the Manager and restart this query.');
    return value;
}
function rank(item: SearchItem, terms: string[], query: SearchQuery, retrievedAt: string): RankedItem | undefined {
    if (!item.detailUrl || !item.handle?.detailUrl || !item.label || !item.origin || !Object.keys(item.origin).length)
        return undefined;
    if (query.kinds.length && !query.kinds.includes(item.kind))
        return undefined;
    if (!textMatches(item.searchText, terms, query.match))
        return undefined;
    const evidence = normalizeSearchEvidence(item.evidence) ?? {};
    const observedAt = evidence.observedAt ?? null;
    const observedTime = observedAt ? Date.parse(observedAt) / 1000 : NaN;
    const updatedTime=Date.parse(item.updatedAt ?? '');
    if ((query.from !== undefined && !(observedTime >= query.from)) || (query.to !== undefined && !(observedTime <= query.to)))
        return undefined;
    const matched = terms.filter(term => normalizeSearchText(item.searchText).includes(term)).length;
    const titleMatches = terms.filter(term => normalizeSearchText(item.label).includes(term)).length;
    const key = apiDigest({ source: item.source, origin: item.origin });
    const { searchText: _text, evidence: _evidence, ...publicItem } = item;
    const references = [...new Set([item.detailUrl, ...(evidence.evidenceRefs ?? [])])];
    return { ...publicItem, key, score: matched * Math.max(1000,terms.length+1) + titleMatches + (query.agent && item.agent === query.agent ? 0.1 : 0),
        state: evidence.state === 'confirmed' && !evidence.evidenceRefs?.length ? 'unknown' : evidence.state ?? 'unknown',
        confidence: evidence.confidence ?? null, userConfirmed: evidence.userConfirmed ?? false, observedAt, expiresAt: evidence.expiresAt ?? null,
        retrievedAt, evidenceRefs: references, sourceKinds: [...new Set([item.source, ...(evidence.sourceKinds ?? [])])],
        sortTime: Number.isFinite(observedTime) ? observedTime * 1000 : Number.isFinite(updatedTime)?updatedTime:-Infinity,
        sortKey: JSON.stringify([item.origin.recordId ?? item.origin.operationId ?? item.origin.resourceId ?? '', item.origin.adapter ?? '', item.origin.conversationKey ?? '', item.agent ?? '', item.kind]) };
}
const compare = (query: SearchQuery) => (a: RankedItem, b: RankedItem) => (query.sort === 'recent' ? (b.sortTime === a.sortTime ? 0 : b.sortTime > a.sortTime ? 1 : -1) : b.score - a.score)
    || a.source.localeCompare(b.source) || (a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? -1 : 1) || a.key.localeCompare(b.key);
/** Query state is reconstructed from owner views and version-bound positions. No additional search index is kept. */
export async function runUnifiedSearch(options: {
    query: SearchQuery;
    snapshot: ApiCatalogSnapshot;
    lanes: SearchLane[];
    signal?: AbortSignal;
    identity?: {
        agentType?: string;
        id?: string;
    };
}) {
    const { query, snapshot, signal } = options;
    const requestId = randomUUID(), began = performance.now(), deadlineAt = began + query.budgetMs;
    const { cursor: _cursor, budgetMs: _budget, ...filterValues } = query;
    const filters = apiDigest(Object.fromEntries(Object.entries(filterValues).filter(([, value]) => value !== undefined))), cursor = readCursor(query, snapshot, filters);
    const queryTime = cursor?.queryTime ?? new Date().toISOString();
    const definitions = snapshot.searchSources.filter(source => query.scopes.includes(source.scope));
    const selectedScopes = new Set(definitions.filter(source => (!query.adapter || source.scope === 'messages')
        && (!query.kinds.length || source.kinds.includes('*') || source.kinds.some(kind => query.kinds.includes(kind)))).map(source => source.scope));
    const lanes = options.lanes.filter(lane => selectedScopes.has(lane.source));
    const unsupported = query.scopes.filter(scope => !snapshot.searchSources.some(source => source.scope === scope));
    const notQueried: Record<string, unknown>[] = unsupported.map(source => ({ source, reason: 'unsupported' }));
    const degraded: Record<string, unknown>[] = [], conflicts: SearchConflict[] = [], terms = searchTerms(query.q);
    for (const source of selectedScopes) {
        if (lanes.some(lane => lane.source === source))
            continue;
        // Role sources have a valid empty view when the installation has no roles.
        if ((source === 'knowledge' || source === 'messages') && !options.lanes.some(lane => lane.agent !== null))
            continue;
        degraded.push({ source, errorCode: 'SEARCH_SOURCE_ADAPTER_UNAVAILABLE', message: 'The registered source has no active reader.', retryable: true });
        notQueried.push({ source, reason: 'degraded', errorCode: 'SEARCH_SOURCE_ADAPTER_UNAVAILABLE' });
    }
    const versions: Record<string, string> = {}, inventories: Record<string, string> = {}, positions: Record<string, number> = {};
    const outcomes = await Promise.all(lanes.map(async (lane) => {
        const controller = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const error = new SearchError(503, 'DEADLINE_EXCEEDED', 'The shared search budget expired.'); controller.abort(error); reject(error); }, Math.max(1, deadlineAt - performance.now())); });
            await yieldToEventLoop(undefined, { signal: requestSignal });
            const batch = await Promise.race([lane.read({ signal: requestSignal, deadlineAt, query, position: cursor?.positions[lane.key] ?? 0 }), timeout]);
            signal?.throwIfAborted();
            const retrievedAt = new Date().toISOString();
            const items: RankedItem[] = [], gaps = [...(batch.gaps ?? [])];
            for (const item of batch.items) {
                try {
                    const candidate = rank(item, terms, query, retrievedAt);
                    if (candidate)
                        items.push(candidate);
                    else if (!item.detailUrl || !item.label || !item.origin)
                        gaps.push({ code: 'SEARCH_ITEM_UNAVAILABLE', message: 'A candidate lacks content or a stable source reference.' });
                }
                catch {
                    gaps.push({ code: 'SEARCH_ITEM_UNAVAILABLE', message: 'One owner record could not be projected.' });
                }
            }
            const unique = [...new Map(items.map(item => [item.key, item])).values()].sort(compare(query));
            return { lane, batch, items: unique, gaps };
        }
        catch (error) {
            signal?.throwIfAborted();
            const cause = error as {
                code?: string;
                publicCode?: string;
                publicDetails?: {
                    errorCode?: string;
                };
                message?: string;
                status?: number;
                statusCode?: number;
            };
            const code = cause.publicDetails?.errorCode ?? cause.publicCode ?? cause.message?.match(/^[A-Z]+_[A-Z_]+/)?.[0] ?? cause.code ?? 'SEARCH_SOURCE_UNAVAILABLE';
            if ((cause.status === 409 || cause.statusCode === 409 || code.endsWith('CURSOR_EXPIRED')) && cursor)
                throw new SearchError(409, code, 'A source snapshot changed. Restart the query.', { source: lane.source });
            degraded.push({ source: lane.source, agent: lane.agent, errorCode: code, message: cause.message ?? 'Source unavailable.', retryable: true });
            notQueried.push({ source: lane.source, agent: lane.agent, reason: 'degraded', errorCode: code });
            return { lane, error: code };
        }
        finally {
            clearTimeout(timer);
        }
    }));
    const successful = outcomes.filter((value): value is Extract<typeof value, {
        batch: SearchBatch;
    }> => 'batch' in value);
    for (const outcome of successful) {
        const { lane, batch, items } = outcome;
        versions[lane.key] = batch.version;
        inventories[lane.key] = batch.windowStart === undefined ? apiDigest(items.map(item => item.key)) : batch.version;
        if (cursor && (cursor.versions[lane.key] !== batch.version || cursor.inventories[lane.key] !== inventories[lane.key])) {
            const code = lane.source === 'knowledge' ? 'KNOWLEDGE_CURSOR_EXPIRED' : lane.source === 'messages' ? 'MESSAGE_HISTORY_CURSOR_EXPIRED' : 'SEARCH_CURSOR_EXPIRED';
            throw new SearchError(409, code, 'A source snapshot changed. Restart the query.', { source: lane.source });
        }
        const position = (cursor?.positions[lane.key] ?? 0) - (batch.windowStart ?? 0);
        if (!Number.isSafeInteger(position) || position < 0 || position > items.length)
            throw new SearchError(400, 'SEARCH_CURSOR_INVALID', 'Invalid source position.');
        positions[lane.key] = position;
        if (batch.conflicts) {
            for (const conflict of normalizeSearchEvidence({ conflicts: batch.conflicts })?.conflicts ?? []) {
                try {
                    apiDigest(conflict);
                    conflicts.push(conflict);
                }
                catch {
                    outcome.gaps.push({ code: 'SEARCH_CONFLICT_UNAVAILABLE', message: 'An owner conflict report lacks stable evidence metadata.' });
                }
            }
        }
    }
    if (cursor && Object.keys(cursor.versions).some(key => !successful.some(outcome => outcome.lane.key === key)))
        throw new SearchError(409, 'SEARCH_CURSOR_EXPIRED', 'A previously queried source became unavailable. Restart the query.');
    const page: RankedItem[] = [], order = compare(query);
    const take = (outcome: typeof successful[number]) => { const item = outcome.items[positions[outcome.lane.key]!]!; positions[outcome.lane.key]!++; page.push(item); };
    let rotation = cursor?.rotation ?? 0;
    if (query.sort === 'relevance') {
        const sources = [...new Set(successful.filter(outcome => outcome.items.length > positions[outcome.lane.key]!).map(outcome => outcome.lane.source))].sort();
        const rotated = [...sources.slice(rotation % sources.length), ...sources.slice(0, rotation % sources.length)];
        for (const source of rotated.slice(0, query.limit)) {
            const first = successful.filter(outcome => outcome.lane.source === source && outcome.items.length > positions[outcome.lane.key]!)
                .sort((a, b) => order(a.items[positions[a.lane.key]!]!, b.items[positions[b.lane.key]!]!))[0];
            if (first)
                take(first);
        }
        if (sources.length > query.limit)
            rotation = (rotation + query.limit) % sources.length;
    }
    while (page.length < query.limit) {
        const first = successful.filter(outcome => outcome.items.length > positions[outcome.lane.key]!)
            .sort((a, b) => order(a.items[positions[a.lane.key]!]!, b.items[positions[b.lane.key]!]!))[0];
        if (!first)
            break;
        take(first);
    }
    page.sort(order);
    const hasMore = successful.some(outcome => outcome.items.length > positions[outcome.lane.key]!);
    const nextPositions = Object.fromEntries(successful.map(outcome => {
        const position = positions[outcome.lane.key]!, previous = outcome.items[position - 1];
        const next = previous?.sourcePosition !== undefined ? previous.sourcePosition + 1
            : outcome.batch.windowStart !== undefined && !outcome.items.length ? outcome.batch.windowStart + (outcome.batch.recordsRead ?? 0)
                : position + (outcome.batch.windowStart ?? 0);
        return [outcome.lane.key, next];
    }));
    const next: Cursor = { version: 1, manager: snapshot.managerInstanceId, generation: snapshot.applicationGenerationId, filters, queryTime, versions, inventories, positions: nextPositions, rotation };
    const coverageSources = [...new Set(lanes.map(lane => lane.source))].sort().map(source => {
        const results = successful.filter(outcome => outcome.lane.source === source), failed = outcomes.filter(outcome => outcome.lane.source === source && 'error' in outcome);
        const partial = failed.length > 0 || results.some(outcome => !outcome.batch.complete || outcome.gaps.length > 0);
        return { source, status: !results.length ? 'unavailable' : partial ? 'partial' : 'ok', returned: page.filter(item => item.source === source).length,
            hasMore: results.some(outcome => outcome.batch.hasMore || outcome.items.length > positions[outcome.lane.key]!) ? true : partial ? null : false,
            conflictCheck: results.some(outcome => outcome.batch.conflicts !== undefined) ? 'source_reported' : 'not_checked',
            coverage: results.map(outcome => ({ agent: outcome.lane.agent, complete: outcome.batch.complete, gaps: outcome.gaps })) };
    });
    const incomplete = degraded.length > 0 || coverageSources.some(source => source.status !== 'ok');
    const by = (key: 'source' | 'kind' | 'agent') => Object.fromEntries([...new Set(page.map(item => String(item[key])))].sort().map(value => [value, page.filter(item => String(item[key]) === value).length]));
    degraded.sort((a, b) => String(a.source).localeCompare(String(b.source)) || String(a.agent ?? '').localeCompare(String(b.agent ?? '')));
    const status = (lanes.length > 0 || degraded.length > 0) && !successful.length ? 503 : 200;
    return { status, body: { code: status === 200 ? 0 : -1, requestId, ...(status === 503 ? { errorCode: degraded.every(item => ['DEADLINE_EXCEEDED','SEARCH_DEADLINE_EXCEEDED'].includes(String(item.errorCode))) ? 'DEADLINE_EXCEEDED' : 'SEARCH_SOURCES_UNAVAILABLE' } : {}), data: {
                applicationGenerationId: snapshot.applicationGenerationId, managerInstanceId: snapshot.managerInstanceId,
                capabilities: { scopes: [...new Set(snapshot.searchSources.map(source => source.scope))].sort(), sources: snapshot.searchSources,
                    filters: ['scope', 'kind', 'agent', 'adapter', 'from', 'to', 'includeArchives'], parameters: ['q', 'scope', 'kind', 'agent', 'adapter', 'from', 'to', 'match', 'mode', 'strict', 'limit', 'cursor', 'budgetMs', 'sort', 'includeArchives', 'expand'],
                    defaults: { scope: 'all', match: 'any', mode: 'keywords', strict: 0, limit: 20, budgetMs: 3000, sort: 'relevance', includeArchives: 0 },
                    reservedScopes, operationsUrl: '/api/agent/operations', contractUrl: '/api/agent/help?operationId=manager.search' },
                legend: Object.fromEntries(snapshot.searchSources.map(source => [source.scope, { description: source.legend, kinds: source.kinds }])),
                facets: { countScope: 'page', bySource: by('source'), byKind: by('kind'), byAgent: by('agent') },
                coverage: { state: incomplete ? 'partial' : 'complete', completenessUnknown: incomplete || selectedScopes.has('messages'), sources: coverageSources, notQueried, excluded: [] },
                degraded, warnings: options.identity?.agentType?.trim() && options.identity?.id?.trim() ? [] : [{ code: 'AGENT_IDENTITY_MISSING', message: '尽量填写调用方 agentType 和完整 id。当前连接可正常检索全部已选择来源。' }],
                conflicts: [...new Map(conflicts.map(conflict => [apiDigest(conflict), conflict])).values()],
                items: page.map(({ key: _key, sortTime: _time, sortKey: _sortKey, sourcePosition: _position, ...item }) => item), nextCursor: hasMore || successful.some(outcome => outcome.batch.hasMore) ? Buffer.from(JSON.stringify(next)).toString('base64url') : null, queryTime
            } } };
}
