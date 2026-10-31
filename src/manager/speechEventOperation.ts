import { constants as bufferConstants } from "node:buffer";
import type { ApiOperationInput, ApiOperationResult, ApiOperationStream } from "./apiOperationContract.js";
import type { SpeechAuthorityGuard } from "./speechRequestAuthority.js";

/** Native raw SSE bytes, including comments and non-JSON events; completion owns upstream cancellation. */
export class SpeechEventStreamOwner {
  private readonly active = new Set<{ controller: AbortController; closed: Promise<void> }>();
  private stopping = false;
  static readonly maxChunkBytes = bufferConstants.MAX_LENGTH;
  async open(input: ApiOperationInput, open: (signal: AbortSignal) => Promise<Response>, guard: SpeechAuthorityGuard): Promise<ApiOperationResult> {
    if (this.stopping) throw new Error("Speech event owner is stopping.");
    const controller = new AbortController(); let finished!: () => void;
    const item = { controller, closed: new Promise<void>(resolve => { finished = resolve; }) }; this.active.add(item);
    const close = () => { this.active.delete(item); finished(); };
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true }); if (input.signal?.aborted) abort();
    let upstream: Response | undefined;
    try {
      guard(); upstream = await open(controller.signal); guard();
      if (controller.signal.aborted) { await upstream.body?.cancel(controller.signal.reason); throw controller.signal.reason; }
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); close(); input.signal?.removeEventListener("abort", abort); return { status: upstream.status || 502, ...([204, 304].includes(upstream.status) ? {} : { body: { code: -1, message: "RabiSpeech event stream is unavailable." } }) }; }
      if (!String(upstream.headers.get("content-type") || "").toLowerCase().startsWith("text/event-stream")) { await upstream.body.cancel(); close(); input.signal?.removeEventListener("abort", abort); return { status: 502, body: { code: -1, message: "RabiSpeech event endpoint did not return an SSE stream." } }; }
      const reader = upstream.body.getReader(); let started = false, eof = false, cancelling: Promise<void> | undefined;
      const cancel = (reason: unknown): Promise<void> => cancelling ??= Promise.resolve().then(async () => {
        controller.abort(reason);
        try { await reader.cancel(reason); }
        finally { if (!started) { controller.signal.removeEventListener("abort", onAbort); reader.releaseLock(); close(); input.signal?.removeEventListener("abort", abort); } }
      });
      const onAbort = () => { void cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const stream: ApiOperationStream = {
        signal: controller.signal,
        frames: (async function* () {
          started = true;
          try {
            while (true) { guard(); const next = await reader.read(); guard(); if (next.done) { eof = true; break; } yield Buffer.from(next.value); }
          } finally {
            try { if (!eof) await cancel(controller.signal.reason); }
            finally { controller.signal.removeEventListener("abort", onAbort); input.signal?.removeEventListener("abort", abort); reader.releaseLock(); close(); }
          }
        })(), cancel
      };
      return { status: 200, stream, headers: { "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no", "content-type": "text/event-stream; charset=utf-8" } };
    } catch (error) {
      try { if (upstream?.body && !upstream.body.locked) await upstream.body.cancel(error); }
      finally { controller.abort(error); close(); input.signal?.removeEventListener("abort", abort); }
      throw error;
    }
  }
  async stop(): Promise<void> { this.stopping = true; for (const item of this.active) item.controller.abort(new Error("Speech event owner retired.")); await Promise.all([...this.active].map(item => item.closed)); }
  activeCount(): number { return this.active.size; }
}
