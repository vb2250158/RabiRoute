import type { ApiOperationContract, ApiOperationDiscovery } from './apiOperationContract.js';
export const normalizeSearchText = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const words = new Intl.Segmenter('zh', { granularity: 'word' });
export function searchTerms(query: string): string[] {
    return [...new Set(normalizeSearchText(query).split(/[\s,，、]+/).filter(Boolean).flatMap(part => {
        if (!/\p{Script=Han}/u.test(part)) return [part];
        return part.split(queryVocabulary).filter(Boolean).flatMap(value => querySynonyms.has(value)
            ? [value] : [...words.segment(value)].filter(segment => segment.isWordLike).map(segment => segment.segment));
    }))];
}
export function textMatches(text: string, terms: readonly string[], match: 'any' | 'all' = 'any'): boolean {
    const normalized = normalizeSearchText(text);
    return terms.length === 0 || (match === 'all' ? terms.every(term => normalized.includes(term)) : terms.some(term => normalized.includes(term)));
}

/** Query vocabulary is shared by the operation directory and the unified search source. */
const querySynonyms: ReadonlyMap<string, readonly string[]> = new Map([
    ['记忆', ['memory', 'memories']], ['计划', ['plan', 'plans']], ['技能', ['skill', 'skills']],
    ['文件', ['file', 'files', 'filesystem']], ['终端', ['terminal', 'terminals', 'shell']],
    ['屏幕', ['screen', 'screenshot']], ['窗口', ['window']], ['插件', ['plugin', 'plugins']],
    ['角色', ['role', 'persona']], ['配置', ['config', 'settings', 'configure']], ['设置', ['config', 'settings']],
    ['消息', ['message', 'messages', 'chat']], ['语音', ['speech', 'voice']], ['视频', ['video']],
    ['电脑控制', ['computer control', 'remote desktop']], ['电脑', ['computer', 'computers']], ['设备', ['device', 'devices']],
    ['列表', ['list', 'catalog', 'directory']], ['查询', ['query', 'list', 'read']],
    ['读取', ['read', 'get']], ['查看', ['read', 'get', 'list', 'status']],
    ['搜索', ['search', 'query']], ['安装', ['install', 'import']], ['更新', ['update', 'patch']],
    ['删除', ['delete', 'remove']], ['保存', ['save', 'write']], ['绑定', ['bind', 'binding']],
    ['发送', ['send', 'deliver']], ['识别', ['recognition', 'asr']], ['合成', ['synthesis', 'tts']],
]);

export type OperationSearchDocument = Readonly<{
    operationId: string;
    text: string;
    fields: readonly Readonly<{ value: string; weight: number }>[];
}>;
function schemaSearchValues(schema: unknown): string[] {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
    const value = schema as Record<string, unknown>;
    const literals = Array.isArray(value.enum) ? value.enum.filter((item): item is string => typeof item === 'string') : [];
    if (typeof value.const === 'string') literals.push(value.const);
    const children = [value.properties, value.$defs, value.definitions].flatMap(properties =>
        properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.values(properties) : []);
    children.push(value.items, ...['allOf', 'anyOf', 'oneOf'].flatMap(key => Array.isArray(value[key]) ? value[key] as unknown[] : []));
    return [...literals, ...children.flatMap(schemaSearchValues)];
}
const queryVocabulary = new RegExp('(' + [...querySynonyms.keys()].sort((a, b) => b.length - a.length).join('|') + ')', 'u');
const operationDocuments = new WeakMap<ApiOperationContract, { discovery: ApiOperationDiscovery | undefined; document: OperationSearchDocument }>();
type OperationSearchQuery = Readonly<{ phrase: string; terms: readonly Readonly<{ literal: string; alternatives?: RegExp }>[] }>;
const operationQueries = new Map<string, OperationSearchQuery>();

function operationQuery(query: string): OperationSearchQuery {
    const phrase = normalizeSearchText(query).replace(/\s+/gu, ' ');
    const cached = operationQueries.get(phrase);
    if (cached) return cached;
    const prepared = Object.freeze({ phrase, terms: Object.freeze(searchTerms(phrase).map(literal => {
        const aliases = querySynonyms.get(literal);
        return Object.freeze({ literal, ...(aliases ? { alternatives: new RegExp(`(?:^|[^a-z0-9])(?:${aliases.join('|')})(?=$|[^a-z0-9])`, 'u') } : {}) });
    })) });
    if (operationQueries.size >= 64) operationQueries.delete(operationQueries.keys().next().value!);
    operationQueries.set(phrase, prepared);
    return prepared;
}

/** Categories filter results. Each operation's own declaration supplies its searchable meaning. */
export function operationSearchDocument(contract: ApiOperationContract, discovery?: ApiOperationDiscovery): OperationSearchDocument {
    const cached = operationDocuments.get(contract);
    if (cached && cached.discovery === discovery) return cached.document;
    const title = discovery?.title || contract.discovery?.title || contract.operationId;
    const fields = [
        { value: contract.operationId, weight: 128 },
        ...(contract.aliases ?? []).map(value => ({ value, weight: 96 })),
        { value: title, weight: 64 },
        ...[...(contract.searchKeywords ?? []), ...(discovery?.keywords ?? [])].map(value => ({ value, weight: 24 })),
        ...[...(contract.discovery?.tags ?? []), ...(discovery?.tags ?? [])].map(value => ({ value, weight: 16 })),
        { value: discovery?.provider || contract.discovery?.provider || '', weight: 12 },
        { value: contract.pathTemplate, weight: 8 },
        ...[...new Set([contract.request.path, contract.request.query, contract.request.headers,
            ...('schema' in contract.request.body ? [contract.request.body.schema] : [])].flatMap(schemaSearchValues))]
            .map(value => ({ value, weight: 4 })),
        { value: discovery?.summary || contract.description, weight: 2 },
    ].filter(field => typeof field.value === 'string' && field.value.trim())
        .map(field => Object.freeze({ value: normalizeSearchText(field.value), weight: field.weight }));
    const document = Object.freeze({ operationId: contract.operationId,
        fields: Object.freeze(fields), text: fields.map(field => field.value).join(' ') });
    operationDocuments.set(contract, { discovery, document });
    return document;
}

/** A missing score means no match. The fractional rank keeps other search sources comparable. */
export function scoreOperationSearch(document: OperationSearchDocument, query: string, match: 'any' | 'all' = 'all'): number | undefined {
    const prepared = operationQuery(query);
    const terms = prepared.terms;
    if (!terms.length) return 0;
    let matched = 0;
    let literals = 0;
    let weight = 0;
    for (const { literal: term, alternatives } of terms) {
        let strongest = 0;
        for (const field of document.fields) {
            if (field.value.includes(term)) strongest = Math.max(strongest, field.weight * (field.value === term ? 2 : 1));
        }
        if (strongest) literals++;
        else if (alternatives) {
            for (const field of document.fields) if (alternatives.test(field.value)) strongest = Math.max(strongest, field.weight);
        }
        if (!strongest) continue;
        matched++;
        weight += strongest;
    }
    if (!matched || match === 'all' && matched !== terms.length) return undefined;
    const phrase = prepared.phrase;
    const phraseWeight = terms.length > 1 ? Math.max(0, ...document.fields.filter(field => field.value.includes(phrase)).map(field => field.weight)) : 0;
    const identityMatch = document.fields.some(field => field.weight >= 96 && field.value === normalizeSearchText(query));
    return matched * 1000 + (identityMatch ? 500 : 0) + (phraseWeight ? 200 + phraseWeight / 512 : 0)
        + literals / (terms.length + 1) + Math.log1p(weight) / 1000;
}
