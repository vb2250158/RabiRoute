export type FrameBudgetTreeSchedulerOptions<T> = {
  process: (node: T) => void;
  children: (node: T) => readonly T[];
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
  now: () => number;
  budgetMs?: number;
  maxNodesPerFrame?: number;
};

export type FrameBudgetTreeScheduler<T> = {
  enqueue: (root: T) => void;
  clear: () => void;
  dispose: () => void;
};

export function createFrameBudgetTreeScheduler<T>(
  options: FrameBudgetTreeSchedulerOptions<T>
): FrameBudgetTreeScheduler<T> {
  const budgetMs = Math.max(1, options.budgetMs ?? 4);
  const maxNodesPerFrame = Math.max(1, options.maxNodesPerFrame ?? 200);
  const pending: T[] = [];
  let scheduledHandle: number | undefined;
  let disposed = false;

  const scheduleNext = (): void => {
    if (disposed || scheduledHandle !== undefined || pending.length === 0) return;
    scheduledHandle = options.schedule(flush);
  };

  const flush = (): void => {
    scheduledHandle = undefined;
    if (disposed) return;
    const startedAt = options.now();
    let processed = 0;
    while (
      pending.length > 0
      && processed < maxNodesPerFrame
      && (processed === 0 || options.now() - startedAt < budgetMs)
    ) {
      const node = pending.pop() as T;
      options.process(node);
      const children = options.children(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]);
      }
      processed += 1;
    }
    scheduleNext();
  };

  return {
    enqueue(root) {
      if (disposed) return;
      pending.push(root);
      scheduleNext();
    },
    clear() {
      pending.length = 0;
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      if (scheduledHandle !== undefined) options.cancel(scheduledHandle);
      scheduledHandle = undefined;
    }
  };
}
