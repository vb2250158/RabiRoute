/** One declaration of the unified search defaults. The manager parser, the capabilities response, the WebGUI test dialog and the scripts all read this file. */
export const unifiedSearchDefaults = {
  scope: 'all',
  match: 'any',
  mode: 'keywords',
  strict: 0,
  limit: 20,
  budgetMs: 3000,
  sort: 'relevance',
  includeArchives: 0,
} as const;

/** Inclusive bounds for the numeric query parameters. */
export const unifiedSearchLimits = {
  limit: 200,
  budgetMs: 2147483647,
} as const;

/** True when the value is a positive integer no greater than the shared bound. */
export function isIntegerWithinBound(value: unknown, maximum: number) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return false;
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) && numeric <= maximum;
}

/** Reads a positive integer query value, or the shared default when the parameter is absent. */
export function readSearchInteger(params: URLSearchParams, key: string, fallback: number, maximum: number) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return isIntegerWithinBound(raw, maximum) ? Number(raw) : undefined;
}

/** Reads one enumerated query value, or the shared default when the parameter is absent. */
export function readSearchChoice<T extends string>(params: URLSearchParams, key: string, choices: readonly T[], fallback: T) {
  const raw = params.get(key) ?? fallback;
  return choices.includes(raw as T) ? raw as T : undefined;
}
