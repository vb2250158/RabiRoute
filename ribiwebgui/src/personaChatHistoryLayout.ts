/** Wait for one layout frame without retaining a hidden or disposed history view. */
export function waitForChatHistoryFrame(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || document.hidden) return Promise.resolve(false);
  return new Promise(resolve => {
    let frame: number | undefined;
    let settled = false;
    const finish = (visible: boolean) => {
      if (settled) return;
      settled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", visibilityChanged);
      resolve(visible);
    };
    const abort = () => finish(false);
    const visibilityChanged = () => { if (document.hidden) finish(false); };
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", visibilityChanged);
    frame = requestAnimationFrame(() => finish(!signal.aborted && !document.hidden));
  });
}
