import type { PerformanceMonitoringConfig, PerformanceSample, PerformanceSummary } from "../shared/performanceContract.js";
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
  private readonly activationLeases = new Set<object>();

  constructor(rootDir: string, config: PerformanceMonitoringConfig, collectorFactory = createNodePerformanceCollector) {
    this.config = config;
    this.store = new PerformanceStore(rootDir, config);
    this.collector = collectorFactory({
      sourceKind: "manager",
      sourceId: "manager",
      emit: sample => { this.store.append(sample); }
    });
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.running) return;
      try {
        await this.store.start();
        this.collector.start(this.config);
        this.uninstallOperationSink = installPerformanceOperationSink(record => this.collector.recordOperation(record));
        this.running = true;
      } catch (error) {
        this.collector.stop();
        try { await this.store.stop(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Performance startup and cleanup failed."); }
        throw error;
      }
    });
  }

  /** Native collector lease; publication and rollback are driven only by the kernel transaction. */
  createActivation(readOnly: boolean) {
    const lease = {};
    let disposed = false;
    let disposal: Promise<void> | undefined;
    return Object.freeze({
      publish: () => {
        if (disposed) throw new Error("Performance collector activation has retired.");
        this.activationLeases.add(lease);
      },
      rollback: () => { this.activationLeases.delete(lease); },
      start: async () => {
        if (!disposed && this.activationLeases.has(lease) && !readOnly) await this.start();
      },
      // Release only after the original operations, subscriptions and producers join.
      dispose: () => {
        if (disposal) return disposal;
        disposed = true;
        const held = this.activationLeases.delete(lease);
        disposal = held && !this.activationLeases.size ? this.stop() : Promise.resolve();
        return disposal;
      }
    });
  }

  applyConfig(config: PerformanceMonitoringConfig): void {
    this.config = config;
    this.store.applyConfig(config);
    if (this.running) this.collector.update(config);
  }

  recordHttpRequest(pathname: string, statusCode: number, durationMs: number, requestId?: string, responseBytes?: number): void {
    this.collector.recordHttpRequest(pathname, statusCode, durationMs, requestId, responseBytes);
  }

  ingest(sample: PerformanceSample): boolean {
    if (sample.source.kind !== "gateway" && sample.source.kind !== "webgui") return false;
    return this.store.append(sample);
  }

  summary(rangeMs: number): PerformanceSummary {
    return this.store.summary(rangeMs);
  }

  configSnapshot(): PerformanceMonitoringConfig {
    return { ...this.config };
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.uninstallOperationSink?.();
      this.uninstallOperationSink = undefined;
      this.collector.stop();
      this.running = false;
      await this.store.stop();
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.transition.then(action);
    this.transition = result.catch(() => {});
    return result;
  }
}
