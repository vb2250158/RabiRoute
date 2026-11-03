import type { PerformanceInitializationStatus, PerformanceMonitoringConfig, PerformanceMonitoringStatus, PerformanceSample, PerformanceSummary } from "../shared/performanceContract.js";
import type { PluginLifecycle } from "../plugin-kernel/types.js";
import { createNodePerformanceCollector } from "../performance/nodePerformanceCollector.js";
import { installPerformanceOperationSink } from "../performance/performanceInstrumentation.js";
import { PerformanceStore } from "./performanceStore.js";

export class PerformanceMonitoringService {
  readonly store: PerformanceStore;
  private config: PerformanceMonitoringConfig;
  private collector: ReturnType<typeof createNodePerformanceCollector>;
  private uninstallOperationSink: (() => void) | undefined;
  private running = false;
  private transition: Promise<void> = Promise.resolve();
  private stopSequence = 0;
  private readonly activationLeases = new Set<object>();
  private readonly statusListeners = new Set<() => void>();
  private initialization: PerformanceInitializationStatus = Object.freeze({
    state: "idle", attempt: 0, incidents: 0, lastTransitionAt: new Date().toISOString()
  });

  constructor(rootDir: string, config: PerformanceMonitoringConfig, collectorFactory = createNodePerformanceCollector) {
    this.config = config;
    this.store = new PerformanceStore(rootDir, config);
    this.collector = collectorFactory({
      sourceKind: "manager",
      sourceId: "manager",
      emit: sample => { this.store.append(sample); }
    });
  }

  start(isCurrent: () => boolean = () => true): Promise<void> {
    const sequence = this.stopSequence;
    return this.enqueue(async () => {
      if (sequence !== this.stopSequence || !isCurrent() || this.running) return;
      this.setInitialization({ state: "loading", attempt: this.initialization.attempt + 1, incidents: 0,
        startedAt: new Date().toISOString(), completedAt: undefined, lastError: undefined });
      try {
        await this.store.start();
        const loadError = this.store.status().lastError;
        if (loadError) throw new Error(loadError);
        // The load owns its original I/O until completion. A retired activation
        // cannot start a collector merely because that I/O completed later.
        if (sequence !== this.stopSequence || !isCurrent()) return;
        this.collector.start(this.config);
        this.uninstallOperationSink = installPerformanceOperationSink(record => this.collector.recordOperation(record));
        this.running = true;
        this.setInitialization({ state: "ready", incidents: 0, completedAt: new Date().toISOString(), lastError: undefined });
      } catch (error) {
        this.collector.stop();
        let failure = error;
        try { await this.store.stop(); }
        catch (cleanupError) { failure = new AggregateError([error, cleanupError], "Performance startup and cleanup failed."); }
        this.setInitialization({ state: "degraded", incidents: 1, completedAt: new Date().toISOString(),
          lastError: failure instanceof Error ? failure.message : String(failure) });
        throw failure;
      }
    });
  }

  /** Native collector lease; the same owner tracks background initialization and retirement. */
  createActivation(readOnly: boolean, lifecycle?: PluginLifecycle) {
    const lease = {};
    let disposed = false;
    let startup: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    const isCurrent = () => !disposed && this.activationLeases.has(lease) && !lifecycle?.signal.aborted;
    return Object.freeze({
      publish: () => {
        if (disposed) throw new Error("Performance collector activation has retired.");
        this.activationLeases.add(lease);
      },
      rollback: () => { this.activationLeases.delete(lease); },
      start: () => {
        if (!isCurrent() || readOnly || startup) return;
        // afterPublish registers owned background work, rather than putting a
        // historical scan inside the kernel's short publication-operation budget.
        // Retirement joins this exact observed flight; failures retain the original
        // activation identity through PluginLifecycle.fail and native reconciliation.
        startup = this.start(isCurrent).catch(error => {
          if (isCurrent()) lifecycle?.fail(error);
        });
      },
      dispose: () => {
        if (disposal) return disposal;
        disposed = true;
        const held = this.activationLeases.delete(lease);
        const stopping = !this.activationLeases.size && (held || startup) ? this.stop() : Promise.resolve();
        disposal = Promise.allSettled([startup ?? Promise.resolve(), stopping]).then(results => {
          const failures = results.filter(result => result.status === "rejected");
          if (failures.length === 1) throw failures[0].reason;
          if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), "Performance background owner cleanup failed.");
        });
        return disposal;
      }
    });
  }

  initializationSnapshot(): PerformanceInitializationStatus { return this.initialization; }

  status(): PerformanceMonitoringStatus {
    return { ...this.store.status(), collecting: this.running && this.config.enabled,
      initialization: this.initialization,
      ...(this.initialization.lastError ? { lastError: this.initialization.lastError } : {}) };
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  applyConfig(config: PerformanceMonitoringConfig): void {
    this.config = config;
    this.store.applyConfig(config);
    if (this.running) this.collector.update(config);
    this.setInitialization({});
  }

  recordHttpRequest(pathname: string, statusCode: number, durationMs: number, requestId?: string, responseBytes?: number): void {
    this.collector.recordHttpRequest(pathname, statusCode, durationMs, requestId, responseBytes);
  }

  ingest(sample: PerformanceSample): boolean {
    if (!this.running || (sample.source.kind !== "gateway" && sample.source.kind !== "webgui")) return false;
    return this.store.append(sample);
  }

  summary(rangeMs: number): PerformanceSummary {
    return { ...this.store.summary(rangeMs), status: this.status() };
  }

  configSnapshot(): PerformanceMonitoringConfig {
    return { ...this.config };
  }

  stop(): Promise<void> {
    this.stopSequence++;
    this.setInitialization({ state: "stopping" });
    return this.enqueue(async () => {
      this.uninstallOperationSink?.();
      this.uninstallOperationSink = undefined;
      this.collector.stop();
      this.running = false;
      await this.store.stop();
      this.setInitialization({ state: "stopped", incidents: 0 });
    });
  }

  private setInitialization(change: Partial<PerformanceInitializationStatus>): void {
    this.initialization = Object.freeze({ ...this.initialization, ...change, lastTransitionAt: new Date().toISOString() });
    for (const listener of this.statusListeners) listener();
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.transition.then(action);
    this.transition = result.catch(() => {});
    return result;
  }
}
