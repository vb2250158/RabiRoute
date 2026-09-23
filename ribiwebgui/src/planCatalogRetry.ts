export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : Number.POSITIVE_INFINITY;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Only the caller's explicitly identified initialization error is retryable. */
export async function retryPlanCatalogInitialization<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    retryDelay: (error: unknown) => number | undefined;
    onInitializing?: () => void;
    budgetMs?: number;
    maxAttempts?: number;
  }
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const budget = options.budgetMs ?? 300_000;
  const deadline = performance.now() + budget;
  const timeout = setTimeout(() => controller.abort(new DOMException("Plan initialization timed out", "TimeoutError")), budget);
  const check = () => controller.signal.throwIfAborted();
  try {
    for (let attempt = 1; ; attempt++) {
      check();
      try {
        const result = await run(controller.signal);
        check();
        return result;
      } catch (error) {
        check();
        const requestedDelay = options.retryDelay(error);
        if (requestedDelay === undefined || !Number.isFinite(requestedDelay) || requestedDelay < 0) throw error;
        const delay = Math.max(250, requestedDelay);
        if (attempt >= (options.maxAttempts ?? 150) || delay >= deadline - performance.now()) throw error;
        options.onInitializing?.();
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", cancelled);
            resolve();
          }, delay);
          controller.signal.addEventListener("abort", cancelled, { once: true });
          if (controller.signal.aborted) cancelled();
        });
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
