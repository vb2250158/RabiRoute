export function mergeKnowledgePage<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = [...current];
  const positions = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const existingIndex = positions.get(item.id);
    if (existingIndex === undefined) {
      positions.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[existingIndex] = item;
    }
  }
  return merged;
}

export function nextKnowledgeRenderLimit(current: number, total: number, batchSize: number): number {
  return Math.min(total, Math.max(batchSize, current + batchSize));
}

export function knowledgeRenderWindow<T>(items: readonly T[], start: number, count: number): T[] {
  const safeStart = Math.min(items.length, Math.max(0, Math.trunc(start)));
  const safeCount = Math.max(0, Math.trunc(count));
  return items.slice(safeStart, safeStart + safeCount);
}

export function hasMoreKnowledgeAfterWindow(total: number, start: number, count: number): boolean {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeStart = Math.min(safeTotal, Math.max(0, Math.trunc(start)));
  const safeCount = Math.max(0, Math.trunc(count));
  return safeStart + safeCount < safeTotal;
}

export function hasMoreKnowledgeBeforeWindow(start: number): boolean {
  return Math.max(0, Math.trunc(start)) > 0;
}

export function previousKnowledgeRenderWindow(
  start: number,
  count: number,
  batchSize: number
): { start: number; count: number } {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeCount = Math.max(0, Math.trunc(count));
  const safeBatchSize = Math.max(0, Math.trunc(batchSize));
  const previousStart = Math.max(0, safeStart - safeBatchSize);
  return {
    start: previousStart,
    count: safeCount + safeStart - previousStart
  };
}

export function shouldAutoLoadNextKnowledgeBatch(
  sentinelIsIntersecting: boolean,
  directoryJumpInProgress: boolean
): boolean {
  return sentinelIsIntersecting && !directoryJumpInProgress;
}

export async function drainKnowledgePages(options: {
  nextCursor: () => string;
  shouldContinue: () => boolean;
  loadNextPage: () => Promise<void>;
  yieldToUi?: () => Promise<void>;
}): Promise<void> {
  while (options.shouldContinue()) {
    const cursor = options.nextCursor();
    if (!cursor) return;
    await options.yieldToUi?.();
    if (!options.shouldContinue()) return;
    await options.loadNextPage();
    if (options.nextCursor() === cursor) return;
  }
}
