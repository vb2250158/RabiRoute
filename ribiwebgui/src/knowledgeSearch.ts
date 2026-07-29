function searchableStrings(value: unknown, seen: WeakSet<object>, output: string[]): void {
  if (typeof value === "string") {
    output.push(value.toLowerCase());
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) searchableStrings(item, seen, output);
    return;
  }

  for (const item of Object.values(value as Record<string, unknown>)) {
    searchableStrings(item, seen, output);
  }
}

export function normalizeKnowledgeQuery(query: unknown): string {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

export function knowledgeItemMatchesQuery(item: unknown, query: unknown): boolean {
  const normalizedQuery = normalizeKnowledgeQuery(query);
  if (!normalizedQuery) return true;

  const values: string[] = [];
  searchableStrings(item, new WeakSet<object>(), values);
  return values.some((value) => value.includes(normalizedQuery));
}
