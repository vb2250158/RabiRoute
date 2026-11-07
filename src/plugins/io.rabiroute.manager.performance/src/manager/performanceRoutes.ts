import type { IncomingMessage } from "node:http";
import { Session, type Profiler } from "node:inspector";
import { normalizePerformanceMonitoringConfig, type PerformanceSample, type PerformanceInitializationStatus } from "@rabiroute/host-api/shared/performanceContract";
import type { RabiGlobalConfigStore } from "@rabiroute/host-api/manager/globalConfig";
import { PerformanceMonitoringService } from "@rabiroute/host-api/manager/performanceMonitoring";
import { isLoopbackRemoteAddress } from "@rabiroute/host-api/manager/webguiLanAccess";
import type { ApiOperationStream } from "@rabiroute/host-api/manager/apiOperationContract";

export const PERFORMANCE_EVENT_LIMITS = Object.freeze({ queuedFrames: 256, frameBytes: 4096, keepAliveMs: 15_000 });

/** Owns performance actions and subscriptions; HTTP routing belongs to the executable contracts. */
export class PerformanceApi {
  private readonly streams = new Set<() => Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private cpuCapture?: { result: Promise<Profiler.Profile>; cancelAndJoin(): Promise<void> };

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
    return { code: 0, data: this.context.service.store.recent(Number.isFinite(requested) ? Math.trunc(requested) : 100), status: this.context.service.status() };
  }

  status() { this.assertActive(); return { code: 0, data: this.context.service.status(), config: this.config() }; }

  /** One requested main-isolate sample; independent of recording config and startup diagnostics. */
  captureCpuProfile(): Promise<Profiler.Profile> {
    this.assertActive();
    if (this.cpuCapture) return this.cpuCapture.result;
    const session = new Session(), lifetime = new AbortController();
    const cancellation = new Error("The original performance owner retired during CPU capture.");
    let timer: NodeJS.Timeout | undefined;
    const post = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
      lifetime.signal.throwIfAborted();
      const abort = () => reject(lifetime.signal.reason);
      lifetime.signal.addEventListener("abort", abort, { once: true });
      try {
        session.post(method, params, (error, value) => {
          lifetime.signal.removeEventListener("abort", abort);
          if (error) reject(error); else resolve(value as T);
        });
      } catch (error) {
        lifetime.signal.removeEventListener("abort", abort); reject(error);
      }
    });
    const capture = async () => {
      try {
        session.connect();
        await post("Profiler.enable");
        await post("Profiler.setSamplingInterval", { interval: 10_000 });
        await post("Profiler.start");
        await new Promise<void>((resolve, reject) => {
          lifetime.signal.throwIfAborted();
          const abort = () => { if (timer) clearTimeout(timer); reject(lifetime.signal.reason); };
          lifetime.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => { lifetime.signal.removeEventListener("abort", abort); resolve(); }, 10_000);
        });
        return (await post<{ profile: Profiler.Profile }>("Profiler.stop")).profile;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let released = false, releaseFailed = false;
    const release = () => {
      if (released) return;
      try {
        session.disconnect();
        released = true; releaseFailed = false;
        if (this.cpuCapture?.result === result) this.cpuCapture = undefined;
      } catch (error) { releaseFailed = true; throw error; }
    };
    const measurement = capture();
    // Sampling errors belong to its callers; retirement joins only the actual native release.
    const settled = measurement.then(() => {}, () => {});
    const cleanup = settled.then(release);
    const result = measurement.then(async profile => { await cleanup; return profile; }, async error => {
      try { await cleanup; }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "CPU capture and Session release failed."); }
      throw error;
    });
    this.cpuCapture = { result, cancelAndJoin: () => {
      // A later explicit close can retry this same native release after a confirmed failure.
      const retryRelease = releaseFailed;
      lifetime.abort(cancellation);
      return retryRelease ? settled.then(release) : cleanup;
    } };
    return result;
  }

  events(): ApiOperationStream {
    this.assertActive();
    type Frame = { event: "ready"; retry: number; data: Record<string, never> }
      | { event: "sample"; data: Pick<PerformanceSample, "time" | "source"> }
      | { event: "status"; data: { state: PerformanceInitializationStatus["state"]; collecting: boolean } } | { comment: string };
    const queued: Frame[] = [{ event: "ready", retry: 3000, data: {} }];
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let producer: AsyncGenerator<Frame>;
    let wake: (() => void) | undefined;
    const abort = new AbortController();
    const stop = () => {
      if (stopped) return stopping ?? Promise.resolve();
      stopped = true; queued.length = 0; unsubscribe(); unsubscribeStatus(); clearInterval(heartbeat); wake?.();
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
    const unsubscribeStatus = this.context.service.subscribeStatus(() => {
      const status = this.context.service.status();
      push({ event: "status", data: { state: status.initialization.state, collecting: status.collecting } });
    });
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
    const pending = [...this.streams].map(stop => stop()), capture = this.cpuCapture;
    if (capture) pending.push(capture.cancelAndJoin());
    this.closing = Promise.all(pending).then(() => {}, error => {
      // Do not discard an unreleased CPU owner or cache its failed close as final completion.
      if (capture && this.cpuCapture === capture) this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
