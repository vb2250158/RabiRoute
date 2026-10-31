import type { IncomingMessage } from "node:http";
import { normalizePerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import type { RabiGlobalConfigStore } from "./globalConfig.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import type { ApiOperationStream } from "./apiOperationContract.js";

export const PERFORMANCE_EVENT_LIMITS = Object.freeze({ queuedFrames: 256, frameBytes: 4096, keepAliveMs: 15_000 });

/** Owns performance actions and subscriptions; HTTP routing belongs to the executable contracts. */
export class PerformanceApi {
  private readonly streams = new Set<() => Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly context: {
    service: PerformanceMonitoringService;
    globalConfig: RabiGlobalConfigStore;
    gatewayExists: (gatewayId: string) => boolean;
  }) {}

  assertActive(): void {
    if (this.closed) throw new Error("The original performance owner has retired.");
  }

  config() { this.assertActive(); return this.context.service.configSnapshot(); }

  saveConfig(body: unknown) {
    this.assertActive();
    const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const performance = normalizePerformanceMonitoringConfig({ ...this.context.globalConfig.read().performance, ...source });
    const saved = this.context.globalConfig.patch({ performance }).performance;
    this.context.service.applyConfig(saved);
    return saved;
  }

  ingest(body: unknown, request: IncomingMessage) {
    this.assertActive();
    const candidate = body as { samples?: unknown[] } | null;
    const samples = Array.isArray(candidate?.samples) ? candidate.samples : [body];
    let accepted = 0;
    for (const item of samples) {
      const sample = item as PerformanceSample | null;
      if (sample?.source?.kind === "manager") continue;
      if (sample?.source?.kind === "gateway"
        && (!isLoopbackRemoteAddress(request.socket.remoteAddress) || !this.context.gatewayExists(sample.source.id))) continue;
      if (sample?.source?.kind !== "gateway" && sample?.source?.kind !== "webgui") continue;
      if (this.context.service.ingest(sample)) accepted++;
    }
    return { code: accepted ? 0 : -1, accepted, rejected: samples.length - accepted };
  }

  summary(rawRange: string | null) {
    this.assertActive();
    return this.context.service.summary(Number(rawRange || 60 * 60 * 1_000));
  }

  logs(rawLimit: string | null) {
    this.assertActive();
    const requested = Number(rawLimit || 100);
    return { code: 0, data: this.context.service.store.recent(Number.isFinite(requested) ? Math.trunc(requested) : 100), status: this.context.service.store.status() };
  }

  status() { this.assertActive(); return { code: 0, data: this.context.service.store.status(), config: this.config() }; }

  events(): ApiOperationStream {
    this.assertActive();
    type Frame = { event: "ready"; retry: number; data: Record<string, never> }
      | { event: "sample"; data: Pick<PerformanceSample, "time" | "source"> } | { comment: string };
    const queued: Frame[] = [{ event: "ready", retry: 3000, data: {} }];
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let producer: AsyncGenerator<Frame>;
    let wake: (() => void) | undefined;
    const abort = new AbortController();
    const stop = () => {
      if (stopped) return stopping ?? Promise.resolve();
      stopped = true; queued.length = 0; unsubscribe(); clearInterval(heartbeat); wake?.();
      stopping = producer.return(undefined).then(() => { this.streams.delete(stop); });
      return stopping;
    };
    const push = (frame: Frame) => {
      if (stopped) return;
      if (queued.length >= PERFORMANCE_EVENT_LIMITS.queuedFrames) {
        void stop(); abort.abort(new Error("Performance event consumer exceeded its bounded notification queue; reconnect and read current summary.")); return;
      }
      queued.push(frame); wake?.();
    };
    const unsubscribe = this.context.service.store.subscribe(sample => push({ event: "sample", data: { time: sample.time, source: sample.source } }));
    // event-driven-allow: SSE protocol keepalive; no performance or business state is queried.
    const heartbeat = setInterval(() => push({ comment: `keepalive ${Date.now()}` }), PERFORMANCE_EVENT_LIMITS.keepAliveMs);
    heartbeat.unref();
    this.streams.add(stop);
    producer = (async function* () {
      try {
        while (!stopped) {
          if (!queued.length) await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
          while (!stopped && queued.length) yield queued.shift()!;
        }
      } finally { void stop(); }
    })();
    return {
      signal: abort.signal,
      frames: producer,
      cancel: stop
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.all([...this.streams].map(stop => stop())).then(() => {});
    return this.closing;
  }
}
