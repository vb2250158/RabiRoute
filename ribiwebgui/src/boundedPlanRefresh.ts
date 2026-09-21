export function createBoundedPlanRefresh(options: {
  allowed: () => boolean;
  busy: () => boolean;
  refresh: (signal: AbortSignal) => Promise<void>;
  failed: (error: unknown) => void;
}) {
  let pending = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  async function flush() {
    clearTimer();
    if (!pending || controller || !options.allowed() || options.busy()) return;
    pending = false;
    const active = new AbortController();
    controller = active;
    try { await options.refresh(active.signal); }
    catch (error) { if (!active.signal.aborted) options.failed(error); }
    finally {
      controller = undefined;
      // New events are coalesced into at most one subsequent bounded request.
      if (pending && options.allowed() && !options.busy()) timer = setTimeout(() => void flush(), 300);
    }
  }
  return {
    get running() { return Boolean(controller); },
    request() { pending = true; clearTimer(); if (options.allowed()) timer = setTimeout(() => void flush(), 300); },
    idle() { if (pending) void flush(); },
    cancel(keepPending = false) { clearTimer(); pending = keepPending && (pending || Boolean(controller)); controller?.abort(); }
  };
}
