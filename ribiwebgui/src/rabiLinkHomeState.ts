/** Ephemeral view state; authorization and peer selection remain Manager-owned. */
export type RabiLinkHomeState<T> =
  | { phase: "idle" | "loading"; data?: never; error?: never }
  | { phase: "ready"; data: T; error?: never }
  | { phase: "error"; data?: never; error: string };

export function createRabiLinkHomeLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  publish: (state: RabiLinkHomeState<T>) => void,
  errorMessage: (reason: unknown) => string
) {
  let epoch = 0;
  let disposed = false;
  let pending: AbortController | undefined;
  let hasSnapshot = false;
  function invalidate() {
    epoch += 1;
    pending?.abort();
    pending = undefined;
    hasSnapshot = false;
    if (!disposed) publish({ phase: "idle" });
  }
  return {
    invalidate,
    async refresh() {
      if (disposed) return;
      const revision = ++epoch;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      if (!hasSnapshot) publish({ phase: "loading" });
      try {
        const data = await load(controller.signal);
        if (!disposed && revision === epoch) {
          hasSnapshot = true;
          publish({ phase: "ready", data });
        }
      } catch (reason) {
        if (!disposed && revision === epoch) {
          hasSnapshot = false;
          publish({ phase: "error", error: errorMessage(reason) });
        }
      } finally {
        if (revision === epoch) pending = undefined;
      }
    },
    dispose() { invalidate(); disposed = true; }
  };
}
