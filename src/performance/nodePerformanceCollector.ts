import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import {
  isMeasuredPerformanceHttpOperation,
  normalizePerformanceOperation,
  performancePercentile,
  type PerformanceHttpMetrics,
  type PerformanceMonitoringConfig,
  type PerformanceOperationSummary,
  type PerformanceSample,
  type PerformanceSlowOperation,
  type PerformanceSourceKind
} from "../shared/performanceContract.js";
import type { RecordedPerformanceOperation } from "./performanceInstrumentation.js";

type RecordedRequest = {
  operation: string;
  durationMs: number;
  statusCode: number;
  requestId?: string;
  responseBytes?: number;
  time: string;
};

export type NodePerformanceCollector = {
  start(config: PerformanceMonitoringConfig): void;
  update(config: PerformanceMonitoringConfig): void;
  stop(): void;
  sampleNow(): PerformanceSample | undefined;
  recordHttpRequest(pathname: string, statusCode: number, durationMs: number, requestId?: string, responseBytes?: number): void;
  recordOperation(record: RecordedPerformanceOperation): void;
};

export function createNodePerformanceCollector(options: {
  sourceKind: Exclude<PerformanceSourceKind, "webgui">;
  sourceId: string;
  emit: (sample: PerformanceSample) => void | Promise<void>;
  now?: () => Date;
  pid?: number;
}): NodePerformanceCollector {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const runtimeId = randomUUID();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  let eventLoopBaseline = performance.eventLoopUtilization();
  let cpuBaseline = process.cpuUsage();
  let wallBaseline = performance.now();
  let timer: NodeJS.Timeout | undefined;
  let config: PerformanceMonitoringConfig | undefined;
  let requests: RecordedRequest[] = [];
  let operations: RecordedPerformanceOperation[] = [];
  let gcDurations: number[] = [];
  let gcObserverActive = false;
  const gcObserver = new PerformanceObserver(list => {
    if (!config?.enabled) return;
    for (const entry of list.getEntries()) gcDurations.push(entry.duration);
    if (gcDurations.length > 10_000) gcDurations = gcDurations.slice(-10_000);
  });

  const enableGcObserver = (): void => {
    if (gcObserverActive) return;
    try {
      gcObserver.observe({ entryTypes: ["gc"] });
      gcObserverActive = true;
    } catch {
      gcObserverActive = false;
    }
  };

  const disableGcObserver = (): void => {
    if (!gcObserverActive) return;
    gcObserver.disconnect();
    gcObserverActive = false;
  };

  const summarizeOperations = (
    captured: Array<{ operation: string; durationMs: number; error: boolean; responseBytes?: number }>
  ): PerformanceOperationSummary[] => {
    const byOperation = new Map<string, typeof captured>();
    for (const item of captured) {
      const list = byOperation.get(item.operation) ?? [];
      list.push(item);
      byOperation.set(item.operation, list);
    }
    return [...byOperation.entries()].map(([operation, list]) => {
      const durations = list.map(item => item.durationMs);
      const responseBytes = list.flatMap(item => typeof item.responseBytes === "number" ? [item.responseBytes] : []);
      return {
        operation,
        count: list.length,
        errorCount: list.filter(item => item.error).length,
        totalMs: Math.round(durations.reduce((sum, value) => sum + value, 0) * 10) / 10,
        p50Ms: performancePercentile(durations, 0.5),
        p95Ms: performancePercentile(durations, 0.95),
        maxMs: Math.round(Math.max(...durations) * 10) / 10,
        ...(responseBytes.length ? {
          totalBytes: responseBytes.reduce((sum, value) => sum + value, 0),
          maxBytes: Math.max(...responseBytes)
        } : {})
      };
    }).sort((left, right) => right.totalMs - left.totalMs).slice(0, 32);
  };

  const summarizeRequests = (captured: RecordedRequest[]): { http?: PerformanceHttpMetrics; slowOperations?: PerformanceSlowOperation[] } => {
    if (!captured.length) return {};
    const operationSummaries = summarizeOperations(captured.map(item => ({
      operation: item.operation,
      durationMs: item.durationMs,
      error: item.statusCode === 0 || item.statusCode >= 400,
      responseBytes: item.responseBytes
    })));
    const durations = captured.map(item => item.durationMs);
    const responseBytes = captured.flatMap(item => typeof item.responseBytes === "number" ? [item.responseBytes] : []);
    const total: PerformanceOperationSummary = {
      operation: "all",
      count: captured.length,
      errorCount: captured.filter(item => item.statusCode === 0 || item.statusCode >= 400).length,
      totalMs: Math.round(durations.reduce((sum, value) => sum + value, 0) * 10) / 10,
      p50Ms: performancePercentile(durations, 0.5),
      p95Ms: performancePercentile(durations, 0.95),
      maxMs: Math.round(Math.max(...durations) * 10) / 10,
      ...(responseBytes.length ? {
        totalBytes: responseBytes.reduce((sum, value) => sum + value, 0),
        maxBytes: Math.max(...responseBytes)
      } : {})
    };
    const slowOperations = captured
      .filter(item => item.durationMs >= (config?.slowOperationMs ?? 2_000))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 20)
      .map(item => ({
        time: item.time,
        operation: item.operation,
        durationMs: Math.round(item.durationMs * 10) / 10,
        kind: "http" as const,
        statusCode: item.statusCode,
        requestId: item.requestId
      }));
    return {
      http: { ...total, operations: operationSummaries },
      ...(slowOperations.length ? { slowOperations } : {})
    };
  };

  const sampleNow = (): PerformanceSample | undefined => {
    if (!config?.enabled) return undefined;
    const currentWall = performance.now();
    const elapsedMs = Math.max(1, currentWall - wallBaseline);
    const cpuDelta = process.cpuUsage(cpuBaseline);
    cpuBaseline = process.cpuUsage();
    wallBaseline = currentWall;
    const loopUtilization = performance.eventLoopUtilization(eventLoopBaseline);
    eventLoopBaseline = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const captured = requests;
    requests = [];
    const capturedOperations = operations;
    operations = [];
    const capturedGcDurations = gcDurations;
    gcDurations = [];
    const requestSummary = summarizeRequests(captured);
    const operationSummaries = summarizeOperations(capturedOperations);
    const slowOperationMs = config.slowOperationMs;
    const slowOperations = capturedOperations
      .filter(item => item.durationMs >= slowOperationMs)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 20)
      .map(item => ({
        time: item.time,
        operation: item.operation,
        durationMs: Math.round(item.durationMs * 10) / 10,
        kind: "operation" as const
      }));
    const nanosecondsToMilliseconds = (value: number): number => Number.isFinite(value)
      ? Math.round((value / 1_000_000) * 10) / 10
      : 0;
    const sample: PerformanceSample = {
      schemaVersion: 1,
      kind: "performance_sample",
      sampleId: randomUUID(),
      time: now().toISOString(),
      intervalMs: Math.max(1_000, Math.round(elapsedMs)),
      source: {
        kind: options.sourceKind,
        id: options.sourceId,
        runtimeId,
        pid
      },
      system: {
        cpuPercent: Math.round((((cpuDelta.user + cpuDelta.system) / 1_000) / elapsedMs * 100) * 10) / 10,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        eventLoopP50Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(50)),
        eventLoopP95Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
        eventLoopMaxMs: nanosecondsToMilliseconds(eventLoopDelay.max),
        eventLoopUtilization: Math.round(loopUtilization.utilization * 1_000) / 1_000,
        gcCount: capturedGcDurations.length,
        gcDurationMs: Math.round(capturedGcDurations.reduce((sum, value) => sum + value, 0) * 10) / 10,
        gcMaxMs: capturedGcDurations.length ? Math.round(Math.max(...capturedGcDurations) * 10) / 10 : 0
      },
      ...requestSummary,
      ...(operationSummaries.length ? { operations: operationSummaries } : {}),
      ...(slowOperations.length ? {
        slowOperations: [...(requestSummary.slowOperations ?? []), ...slowOperations]
          .sort((left, right) => right.durationMs - left.durationMs)
          .slice(0, 20)
      } : {})
    };
    eventLoopDelay.reset();
    void options.emit(sample);
    return sample;
  };

  const schedule = (): void => {
    if (!config?.enabled) return;
    timer = setTimeout(() => {
      timer = undefined;
      sampleNow();
      schedule();
    }, config.sampleIntervalMs);
    timer.unref();
  };

  return {
    start(nextConfig) {
      config = nextConfig;
      if (!config.enabled || timer) return;
      cpuBaseline = process.cpuUsage();
      wallBaseline = performance.now();
      eventLoopBaseline = performance.eventLoopUtilization();
      eventLoopDelay.enable();
      enableGcObserver();
      schedule();
    },
    update(nextConfig) {
      const intervalChanged = config?.sampleIntervalMs !== nextConfig.sampleIntervalMs;
      config = nextConfig;
      if (!nextConfig.enabled) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        eventLoopDelay.disable();
        disableGcObserver();
        requests = [];
        operations = [];
        gcDurations = [];
        return;
      }
      if (intervalChanged && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      eventLoopDelay.enable();
      enableGcObserver();
      if (!timer) schedule();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      eventLoopDelay.disable();
      disableGcObserver();
      requests = [];
      operations = [];
      gcDurations = [];
    },
    sampleNow,
    recordHttpRequest(pathname, statusCode, durationMs, requestId, responseBytes) {
      const operation = normalizePerformanceOperation(pathname);
      if (!config?.enabled || !isMeasuredPerformanceHttpOperation(operation)) return;
      requests.push({
        operation,
        durationMs: Math.max(0, durationMs),
        statusCode,
        requestId,
        responseBytes,
        time: now().toISOString()
      });
      if (requests.length > 20_000) requests.splice(0, requests.length - 20_000);
    },
    recordOperation(record) {
      if (!config?.enabled) return;
      operations.push(record);
      if (operations.length > 20_000) operations.splice(0, operations.length - 20_000);
    }
  };
}
