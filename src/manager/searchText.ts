import type { ApiOperationContract, ApiOperationDiscovery } from './apiOperationContract.js';
export const normalizeSearchText = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const words = new Intl.Segmenter('zh', { granularity: 'word' });
export function searchTerms(query: string): string[] {
    return [...new Set(normalizeSearchText(query).split(/[\s,，、]+/).filter(Boolean).flatMap(part => /\p{Script=Han}/u.test(part) ? [...words.segment(part)].filter(segment => segment.isWordLike).map(segment => segment.segment) : [part]))];
}
export function textMatches(text: string, terms: readonly string[], match: 'any' | 'all' = 'any'): boolean {
    const normalized = normalizeSearchText(text);
    return terms.length === 0 || (match === 'all' ? terms.every(term => normalized.includes(term)) : terms.some(term => normalized.includes(term)));
}
export function operationSearchText(contract: ApiOperationContract, discovery?: ApiOperationDiscovery): string {
    return [contract.operationId, ...(contract.aliases ?? []), contract.description, contract.method, contract.pathTemplate,
        ...(contract.searchKeywords ?? []), contract.searchable?.legend ?? '', contract.discovery?.title ?? '', contract.discovery?.categoryId ?? '',
        ...(contract.discovery?.tags ?? []), contract.discovery?.provider ?? '', discovery?.title ?? '', discovery?.summary ?? '', discovery?.category?.id ?? '', ...(discovery?.tags ?? []), ...(discovery?.keywords ?? []), discovery?.provider ?? ''].join(' ');
}
