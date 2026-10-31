import type { ApiOperationStream } from "./apiOperationContract.js";
import type { LanAgentTerminals, RemoteTerminalEvent } from "./lanAgentTerminals.js";
import { TERMINAL_LIMITS } from "../../apps/rabi-agent/lib/interactive-protocol.mjs";

/** One viewer over the existing bounded replay owner; no second terminal or output log. */
export function openTerminalEventStream(owner: LanAgentTerminals, instanceId: string, terminalId: string, after: number, guard: () => void): ApiOperationStream {
  type Frame = { id: string; data: RemoteTerminalEvent } | { comment: string };
  const queue: Array<{ frame: Frame; bytes: number }> = [];
  const controller = new AbortController();
  let closed = false, finished = false, queuedBytes = 0;
  let wake: (() => void) | undefined, unsubscribe: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (failure?: unknown) => {
    if (closed) return; closed = true; queue.length = 0; queuedBytes = 0;
    if (heartbeat) clearInterval(heartbeat); heartbeat = undefined;
    unsubscribe?.(); unsubscribe = undefined;
    if (failure) controller.abort(failure);
    wake?.(); wake = undefined;
  };
  const push = (frame: Frame) => {
    if (closed) return;
    const bytes = Buffer.byteLength("data" in frame ? `id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n` : `: ${frame.comment}\n\n`);
    if (queuedBytes + bytes > TERMINAL_LIMITS.streamQueueBytes) { close(new Error("Terminal output viewer exceeded its queue capacity.")); return; }
    queue.push({ frame, bytes }); queuedBytes += bytes; wake?.(); wake = undefined;
  };
  push({ comment: "terminal stream" });
  try {
    guard();
    const remove = owner.subscribe(instanceId, terminalId, after, event => {
      push({ id: String(event.sequence), data: { ...event } });
      if (["exit", "disconnected"].includes(event.type)) {
        finished = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
    if (closed) remove(); else unsubscribe = remove;
    if (!closed && !finished) {
      // event-driven-allow: SSE protocol keepalive; never queries terminal or business state.
      heartbeat = setInterval(() => { try { guard(); push({ comment: "keepalive" }); } catch (error) { close(error); } }, TERMINAL_LIMITS.heartbeatMs);
      heartbeat.unref?.();
    }
  } catch (error) { close(); throw error; }
  return { signal: controller.signal, cancel: () => close(), frames: (async function* () {
    try {
      while (!closed) {
        const next = queue.shift();
        if (next) { queuedBytes -= next.bytes; guard(); yield next.frame; continue; }
        if (finished) break;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally { close(); }
  })() };
}
