import type { ApiOperationStream } from "../manager/apiOperationContract.js";
import type { PeerConnections } from "./connections.js";

export const PEER_EVENT_LIMITS = Object.freeze({ ids: 10, queuedBytes: 65_536, frameBytes: 65_536, heartbeatMs: 15_000 });
type Frame = { event?: string; data?: unknown; comment?: string };

/** The connection owner publishes events; consumers never execute business work from notification callbacks. */
export function openPeerEvents(connections: PeerConnections, stopped: AbortSignal, ids: string[], assertCurrent: () => void): ApiOperationStream {
  if (ids.length > PEER_EVENT_LIMITS.ids || ids.some(id => typeof id !== "string")) throw new Error("Invalid event subscription.");
  const controller = new AbortController();
  const queue: Array<{ frame: Frame; bytes: number }> = [];
  const pending = new Set<Promise<unknown>>();
  let queuedBytes = 0, closed = false, wake: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = (error?: Error) => {
    if (closed) return;
    closed = true; queue.length = 0; queuedBytes = 0;
    if (timer) clearInterval(timer);
    connections.off("status", status); connections.off("selection", selection); stopped.removeEventListener("abort", stop);
    if (error) controller.abort(error);
    wake?.(); wake = undefined;
  };
  const push = (frame: Frame) => {
    if (closed) return;
    try {
      assertCurrent();
      const json = JSON.stringify(frame), bytes = Buffer.byteLength(json) + 32;
      if (bytes > PEER_EVENT_LIMITS.frameBytes || queuedBytes + bytes > PEER_EVENT_LIMITS.queuedBytes) throw new Error("Peer event queue capacity exceeded.");
      queue.push({ frame: JSON.parse(json), bytes }); queuedBytes += bytes;
      wake?.(); wake = undefined;
    } catch (error) { close(error instanceof Error ? error : new Error("Peer event publication failed.")); }
  };
  const status = (data: { deviceId: string }) => { if (ids.includes(data.deviceId)) push({ event: "status", data }); };
  const selection = (data: unknown) => push({ event: "selection", data });
  const stop = () => close();
  assertCurrent(); stopped.throwIfAborted();
  connections.on("status", status); connections.on("selection", selection); stopped.addEventListener("abort", stop, { once: true });
  push({ comment: "connected" });
  // event-driven-allow: transport heartbeat keepalive; ping only live channels, no directory or business reads.
  if (!closed) timer = setInterval(() => {
    if (closed || pending.size) return;
    try { assertCurrent(); }
    catch (error) { close(error instanceof Error ? error : new Error("Peer authority revoked.")); return; }
    const work = connections.refreshLatency(ids); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    push({ comment: "keepalive" });
  }, PEER_EVENT_LIMITS.heartbeatMs);
  timer?.unref?.();
  const cancel = async () => { close(); await Promise.allSettled([...pending]); };
  return { signal: controller.signal, cancel, frames: (async function* () {
    try {
      while (!closed) {
        const next = queue.shift();
        if (next) { queuedBytes -= next.bytes; yield next.frame; continue; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally { await cancel(); }
  })() };
}
