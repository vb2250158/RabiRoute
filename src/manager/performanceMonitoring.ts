import type { PerformanceMonitoringConfig, PerformanceSample, PerformanceSummary } from "../shared/performanceContract.js";
import { createNodePerformanceCollector } from "../performance/nodePerformanceCollector.js";
import { installPerformanceOperationSink } from "../performance/performanceInstrumentation.js";
import { PerformanceStore } from "./performanceStore.js";

export class PerformanceMonitoringService {
  readonly store: PerformanceStore;
  private config: PerformanceMonitoringConfig;
  private collector: ReturnType<typeof createNodePerformanceCollector>;
  private uninstallOperationSink: (() => void) | undefined;

  constructor(rootDir: string, config: PerformanceMonitoringConfig) {
    this.config = config;
    this.store = new PerformanceStore(rootDir, config);
    this.collector = createNodePerformanceCollector({
      sourceKind: "manager",
      sourceId: "manager",
      emit: sample => { this.store.append(sample); }
    });
  }

  async start(): Promise<void> {
    await this.store.start();
    this.uninstallOperationSink = installPerformanceOperationSink(record => this.collector.recordOperation(record));
    this.collector.start(this.config);
  }

  applyConfig(config: PerformanceMonitoringConfig): void {
    this.config = config;
    this.store.applyConfig(config);
    this.collector.update(config);
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

  async stop(): Promise<void> {
    this.uninstallOperationSink?.();
    this.uninstallOperationSink = undefined;
    this.collector.stop();
    await this.store.stop();
  }
}
