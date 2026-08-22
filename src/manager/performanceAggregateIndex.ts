import {
  isMeasuredPerformanceHttpOperation,
  performanceOperationTotalMs,
  type PerformanceHttpMetrics,
  type PerformanceMonitoringConfig,
  type PerformanceOperationAggregate,
  type PerformanceOperationSummary,
  type PerformanceSample,
  type PerformanceSeriesPoint,
  type PerformanceSource,
  type PerformanceSourceStatus,
  type PerformanceStoreStatus,
  type PerformanceSummary
} from "../shared/performanceContract.js";

const HOUR_MS = 60 * 60 * 1_000;
const MAX_SUMMARY_RANGE_MS = 48 * HOUR_MS;
const OTHER_OPERATION = "__other__";

export const PERFORMANCE_STORE_MEMORY_LIMITS = Object.freeze({
  recentSamples: 1_000,
  recentSampleBytes: 16 * 1024 * 1024,
  dedupeSampleIds: 10_000,
  aggregateBucketsPerTier: 20_000,
  aggregateOperationEntriesPerTier: 50_000,
  operationsPerBucket: 64,
  sourceSnapshots: 1_024,
  slowOperations: 100,
  serializedSampleBytes: 1024 * 1024
});

type OperationAccumulator = {
  operation: string;
  count: number;
  errorCount: number;
  totalMs: number;
  weightedP50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalBytes: number;
  maxBytes: number;
  hasBytes: boolean;
};

type AggregateBucket = {
  bucketTime: number;
  latestTime: number;
  source: PerformanceSource;
  sampleCount: number;
  systemCount: number;
  cpuPercentSum: number;
  rssBytesSum: number;
  heapUsedBytesSum: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  eventLoopUtilizationSum: number;
  gcCount: number;
  gcDurationMs: number;
  gcMaxMs: number;
  requestCount: number;
  errorCount: number;
  requestP95Ms: number;
  requestMaxMs: number;
  frontendCount: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  jsHeapCount: number;
  jsHeapUsedBytesSum: number;
  httpOperations: Map<string, OperationAccumulator>;
  hotOperations: Map<string, OperationAccumulator>;
};

type SourceSnapshot = {
  source: PerformanceSource;
  lastSeenAt: string;
  timeMs: number;
  intervalMs: number;
  latest: PerformanceSeriesPoint;
};

type SlowOperationSnapshot = NonNullable<PerformanceSample["slowOperations"]>[number] & {
  source: PerformanceSource;
};

export type PerformanceAggregateMemoryUsage = {
  aggregateBuckets: number;
  aggregateOperationEntries: number;
  representedSamples: number;
  sourceSnapshots: number;
  slowOperations: number;
};

function compactSource(source: PerformanceSource): PerformanceSource {
  return {
    kind: source.kind,
    id: source.id,
    runtimeId: source.runtimeId,
    ...(typeof source.pid === "number" && Number.isFinite(source.pid) ? { pid: source.pid } : {})
  };
}

function sourceKey(source: PerformanceSource): string {
  return `${source.kind}:${source.id}:${source.runtimeId}`;
}

function safeRange(rangeMs: number): number {
  return Math.min(MAX_SUMMARY_RANGE_MS, Math.max(60_000, Number.isFinite(rangeMs) ? rangeMs : HOUR_MS));
}

function summaryBucketMs(rangeMs: number): number {
  return rangeMs <= HOUR_MS ? 10_000 : rangeMs <= 6 * HOUR_MS ? 60_000 : 5 * 60_000;
}

function measuredHttpMetrics(http: PerformanceHttpMetrics | undefined): PerformanceHttpMetrics | undefined {
  if (!http) return undefined;
  const operations = http.operations.filter(item => isMeasuredPerformanceHttpOperation(item.operation));
  if (operations.length === http.operations.length) return http;
  if (!operations.length) return undefined;
  const count = operations.reduce((sum, item) => sum + item.count, 0);
  const totalBytes = operations.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0);
  const maxBytes = Math.max(0, ...operations.map(item => item.maxBytes ?? 0));
  return {
    operation: "all",
    count,
    errorCount: operations.reduce((sum, item) => sum + item.errorCount, 0),
    totalMs: Math.round(operations.reduce((sum, item) => sum + performanceOperationTotalMs(item), 0) * 10) / 10,
    p50Ms: count > 0
      ? Math.round((operations.reduce((sum, item) => sum + item.p50Ms * item.count, 0) / count) * 10) / 10
      : 0,
    p95Ms: Math.max(0, ...operations.map(item => item.p95Ms)),
    maxMs: Math.max(0, ...operations.map(item => item.maxMs)),
    ...(totalBytes > 0 ? { totalBytes, maxBytes } : {}),
    operations
  };
}

function singleSamplePoint(sample: PerformanceSample, timeMs: number): PerformanceSeriesPoint {
  const system = sample.system;
  const http = measuredHttpMetrics(sample.http);
  const frontend = sample.frontend;
  return {
    time: new Date(timeMs).toISOString(),
    source: compactSource(sample.source),
    cpuPercent: system?.cpuPercent,
    rssBytes: system?.rssBytes,
    heapUsedBytes: system?.heapUsedBytes,
    eventLoopP95Ms: system?.eventLoopP95Ms,
    eventLoopMaxMs: system?.eventLoopMaxMs,
    eventLoopUtilization: system?.eventLoopUtilization,
    gcCount: system?.gcCount ?? 0,
    gcDurationMs: system?.gcDurationMs ?? 0,
    gcMaxMs: system?.gcMaxMs ?? 0,
    requestCount: http?.count ?? 0,
    errorCount: http?.errorCount ?? 0,
    requestP95Ms: http?.p95Ms,
    requestMaxMs: http?.maxMs,
    longTaskCount: frontend?.longTaskCount ?? 0,
    longTaskMaxMs: frontend?.longTaskMaxMs,
    jsHeapUsedBytes: frontend?.jsHeapUsedBytes
  };
}

function createBucket(sample: PerformanceSample, bucketTime: number, timeMs: number): AggregateBucket {
  return {
    bucketTime,
    latestTime: timeMs,
    source: compactSource(sample.source),
    sampleCount: 0,
    systemCount: 0,
    cpuPercentSum: 0,
    rssBytesSum: 0,
    heapUsedBytesSum: 0,
    eventLoopP95Ms: 0,
    eventLoopMaxMs: 0,
    eventLoopUtilizationSum: 0,
    gcCount: 0,
    gcDurationMs: 0,
    gcMaxMs: 0,
    requestCount: 0,
    errorCount: 0,
    requestP95Ms: 0,
    requestMaxMs: 0,
    frontendCount: 0,
    longTaskCount: 0,
    longTaskMaxMs: 0,
    jsHeapCount: 0,
    jsHeapUsedBytesSum: 0,
    httpOperations: new Map(),
    hotOperations: new Map()
  };
}

function mergeOperation(target: OperationAccumulator, item: PerformanceOperationSummary): void {
  target.count += item.count;
  target.errorCount += item.errorCount;
  target.totalMs += performanceOperationTotalMs(item);
  target.weightedP50Ms += item.p50Ms * item.count;
  target.p95Ms = Math.max(target.p95Ms, item.p95Ms);
  target.maxMs = Math.max(target.maxMs, item.maxMs);
  if (typeof item.totalBytes === "number") {
    target.hasBytes = true;
    target.totalBytes += item.totalBytes;
    target.maxBytes = Math.max(target.maxBytes, item.maxBytes ?? 0);
  }
}

function newOperationAccumulator(operation: string): OperationAccumulator {
  return {
    operation,
    count: 0,
    errorCount: 0,
    totalMs: 0,
    weightedP50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    totalBytes: 0,
    maxBytes: 0,
    hasBytes: false
  };
}

class AggregateTier {
  readonly bucketMs: number;
  readonly retentionMs: number;
  private buckets = new Map<string, AggregateBucket>();
  private operationEntryCount = 0;
  private representedSamples = 0;

  constructor(bucketMs: number, retentionMs: number) {
    this.bucketMs = bucketMs;
    this.retentionMs = retentionMs;
  }

  add(sample: PerformanceSample, timeMs: number, now: number): void {
    if (timeMs < now - this.retentionMs || timeMs > now + this.bucketMs) return;
    const bucketTime = Math.floor(timeMs / this.bucketMs) * this.bucketMs;
    const key = `${sourceKey(sample.source)}:${bucketTime}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = createBucket(sample, bucketTime, timeMs);
      this.buckets.set(key, bucket);
      this.enforceBucketLimit();
      if (!this.buckets.has(key)) return;
    }
    bucket.latestTime = Math.max(bucket.latestTime, timeMs);
    bucket.sampleCount += 1;
    this.representedSamples += 1;

    if (sample.system) {
      bucket.systemCount += 1;
      bucket.cpuPercentSum += sample.system.cpuPercent;
      bucket.rssBytesSum += sample.system.rssBytes;
      bucket.heapUsedBytesSum += sample.system.heapUsedBytes;
      bucket.eventLoopP95Ms = Math.max(bucket.eventLoopP95Ms, sample.system.eventLoopP95Ms);
      bucket.eventLoopMaxMs = Math.max(bucket.eventLoopMaxMs, sample.system.eventLoopMaxMs);
      bucket.eventLoopUtilizationSum += sample.system.eventLoopUtilization;
      bucket.gcCount += sample.system.gcCount ?? 0;
      bucket.gcDurationMs += sample.system.gcDurationMs ?? 0;
      bucket.gcMaxMs = Math.max(bucket.gcMaxMs, sample.system.gcMaxMs ?? 0);
    }

    const http = measuredHttpMetrics(sample.http);
    if (http) {
      bucket.requestCount += http.count;
      bucket.errorCount += http.errorCount;
      bucket.requestP95Ms = Math.max(bucket.requestP95Ms, http.p95Ms);
      bucket.requestMaxMs = Math.max(bucket.requestMaxMs, http.maxMs);
      this.addOperations(bucket.httpOperations, http.operations);
    }

    if (sample.frontend) {
      bucket.frontendCount += 1;
      bucket.longTaskCount += sample.frontend.longTaskCount;
      bucket.longTaskMaxMs = Math.max(bucket.longTaskMaxMs, sample.frontend.longTaskMaxMs);
      if (typeof sample.frontend.jsHeapUsedBytes === "number") {
        bucket.jsHeapCount += 1;
        bucket.jsHeapUsedBytesSum += sample.frontend.jsHeapUsedBytes;
      }
    }

    this.addOperations(bucket.hotOperations, sample.operations ?? []);
  }

  prune(now: number, maximumRetentionMs: number): void {
    const cutoff = now - Math.min(this.retentionMs, maximumRetentionMs);
    for (const [key, bucket] of this.buckets) {
      if (bucket.latestTime < cutoff) this.deleteBucket(key, bucket);
    }
  }

  matching(from: number): AggregateBucket[] {
    const buckets: AggregateBucket[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.latestTime >= from) buckets.push(bucket);
    }
    return buckets;
  }

  usage(): Pick<PerformanceAggregateMemoryUsage, "aggregateBuckets" | "aggregateOperationEntries" | "representedSamples"> {
    return {
      aggregateBuckets: this.buckets.size,
      aggregateOperationEntries: this.operationEntryCount,
      representedSamples: this.representedSamples
    };
  }

  private addOperations(target: Map<string, OperationAccumulator>, items: PerformanceOperationSummary[]): void {
    for (const item of items) {
      const operation = String(item.operation || "unknown").slice(0, 240);
      let accumulator = target.get(operation);
      if (!accumulator) {
        const canAddNamed = target.size < PERFORMANCE_STORE_MEMORY_LIMITS.operationsPerBucket
          && this.operationEntryCount < PERFORMANCE_STORE_MEMORY_LIMITS.aggregateOperationEntriesPerTier;
        const key = canAddNamed ? operation : OTHER_OPERATION;
        accumulator = target.get(key);
        if (!accumulator) {
          if (this.operationEntryCount >= PERFORMANCE_STORE_MEMORY_LIMITS.aggregateOperationEntriesPerTier) continue;
          accumulator = newOperationAccumulator(key);
          target.set(key, accumulator);
          this.operationEntryCount += 1;
        }
      }
      mergeOperation(accumulator, item);
    }
  }

  private enforceBucketLimit(): void {
    while (this.buckets.size > PERFORMANCE_STORE_MEMORY_LIMITS.aggregateBucketsPerTier) {
      const first = this.buckets.entries().next().value as [string, AggregateBucket] | undefined;
      if (!first) return;
      this.deleteBucket(first[0], first[1]);
    }
  }

  private deleteBucket(key: string, bucket: AggregateBucket): void {
    if (!this.buckets.delete(key)) return;
    this.operationEntryCount -= bucket.httpOperations.size + bucket.hotOperations.size;
    this.representedSamples -= bucket.sampleCount;
  }
}

function pointFromBucket(bucket: AggregateBucket): PerformanceSeriesPoint {
  const average = (sum: number, count: number): number | undefined => count
    ? Math.round((sum / count) * 10) / 10
    : undefined;
  return {
    time: new Date(bucket.bucketTime).toISOString(),
    source: bucket.source,
    cpuPercent: average(bucket.cpuPercentSum, bucket.systemCount),
    rssBytes: average(bucket.rssBytesSum, bucket.systemCount),
    heapUsedBytes: average(bucket.heapUsedBytesSum, bucket.systemCount),
    eventLoopP95Ms: bucket.systemCount ? Math.round(bucket.eventLoopP95Ms * 10) / 10 : undefined,
    eventLoopMaxMs: bucket.systemCount ? Math.round(bucket.eventLoopMaxMs * 10) / 10 : undefined,
    eventLoopUtilization: average(bucket.eventLoopUtilizationSum, bucket.systemCount),
    gcCount: bucket.gcCount,
    gcDurationMs: bucket.systemCount ? Math.round(bucket.gcDurationMs * 10) / 10 : undefined,
    gcMaxMs: bucket.systemCount ? Math.round(bucket.gcMaxMs * 10) / 10 : undefined,
    requestCount: bucket.requestCount,
    errorCount: bucket.errorCount,
    requestP95Ms: bucket.requestCount ? Math.round(bucket.requestP95Ms * 10) / 10 : undefined,
    requestMaxMs: bucket.requestCount ? Math.round(bucket.requestMaxMs * 10) / 10 : undefined,
    longTaskCount: bucket.longTaskCount,
    longTaskMaxMs: bucket.frontendCount ? Math.round(bucket.longTaskMaxMs * 10) / 10 : undefined,
    jsHeapUsedBytes: average(bucket.jsHeapUsedBytesSum, bucket.jsHeapCount)
  };
}

function aggregateOperations(
  buckets: AggregateBucket[],
  select: (bucket: AggregateBucket) => Map<string, OperationAccumulator>
): PerformanceOperationAggregate[] {
  const groups = new Map<string, OperationAccumulator & { source: PerformanceSource }>();
  for (const bucket of buckets) {
    for (const item of select(bucket).values()) {
      const key = `${sourceKey(bucket.source)}:${item.operation}`;
      let group = groups.get(key);
      if (!group) {
        group = { ...newOperationAccumulator(item.operation), source: bucket.source };
        groups.set(key, group);
      }
      mergeOperation(group, {
        operation: item.operation,
        count: item.count,
        errorCount: item.errorCount,
        totalMs: item.totalMs,
        p50Ms: item.count ? item.weightedP50Ms / item.count : 0,
        p95Ms: item.p95Ms,
        maxMs: item.maxMs,
        ...(item.hasBytes ? { totalBytes: item.totalBytes, maxBytes: item.maxBytes } : {})
      });
    }
  }
  return [...groups.values()].map(group => ({
    source: group.source,
    operation: group.operation,
    count: group.count,
    errorCount: group.errorCount,
    totalMs: Math.round(group.totalMs * 10) / 10,
    p50Ms: group.count ? Math.round((group.weightedP50Ms / group.count) * 10) / 10 : 0,
    p95Ms: Math.round(group.p95Ms * 10) / 10,
    maxMs: Math.round(group.maxMs * 10) / 10,
    ...(group.hasBytes ? { totalBytes: group.totalBytes, maxBytes: group.maxBytes } : {})
  })).sort((left, right) => right.totalMs - left.totalMs).slice(0, 100);
}

export class PerformanceAggregateIndex {
  private tiers = [
    new AggregateTier(10_000, HOUR_MS),
    new AggregateTier(60_000, 6 * HOUR_MS),
    new AggregateTier(5 * 60_000, MAX_SUMMARY_RANGE_MS)
  ];
  private latestSources = new Map<string, SourceSnapshot>();
  private slowOperations: SlowOperationSnapshot[] = [];

  ingest(sample: PerformanceSample, now = Date.now()): void {
    const timeMs = Date.parse(sample.time);
    if (!Number.isFinite(timeMs)) return;
    for (const tier of this.tiers) tier.add(sample, timeMs, now);
    if (timeMs >= now - MAX_SUMMARY_RANGE_MS) {
      const key = sourceKey(sample.source);
      const existing = this.latestSources.get(key);
      if (!existing || timeMs >= existing.timeMs) {
        if (!existing && this.latestSources.size >= PERFORMANCE_STORE_MEMORY_LIMITS.sourceSnapshots) {
          const oldest = [...this.latestSources.entries()]
            .sort((left, right) => left[1].timeMs - right[1].timeMs)[0];
          if (oldest) this.latestSources.delete(oldest[0]);
        }
        const source = compactSource(sample.source);
        this.latestSources.set(key, {
          source,
          lastSeenAt: sample.time,
          timeMs,
          intervalMs: sample.intervalMs,
          latest: { ...singleSamplePoint(sample, timeMs), source }
        });
      }
      for (const operation of sample.slowOperations ?? []) {
        if (operation.kind === "http" && !isMeasuredPerformanceHttpOperation(operation.operation)) continue;
        this.slowOperations.push({
          time: String(operation.time).slice(0, 64),
          operation: String(operation.operation).slice(0, 240),
          durationMs: operation.durationMs,
          ...(operation.kind ? { kind: operation.kind } : {}),
          ...(typeof operation.statusCode === "number" ? { statusCode: operation.statusCode } : {}),
          ...(operation.requestId ? { requestId: String(operation.requestId).slice(0, 240) } : {}),
          source: compactSource(sample.source)
        });
      }
      if (this.slowOperations.length > PERFORMANCE_STORE_MEMORY_LIMITS.slowOperations) {
        this.slowOperations.sort((left, right) => right.time.localeCompare(left.time));
        this.slowOperations.length = PERFORMANCE_STORE_MEMORY_LIMITS.slowOperations;
      }
    }
  }

  prune(config: PerformanceMonitoringConfig, now = Date.now()): void {
    const maximumRetentionMs = Math.min(MAX_SUMMARY_RANGE_MS, config.retentionHours * HOUR_MS);
    for (const tier of this.tiers) tier.prune(now, maximumRetentionMs);
    const cutoff = now - maximumRetentionMs;
    for (const [key, snapshot] of this.latestSources) {
      if (snapshot.timeMs < cutoff) this.latestSources.delete(key);
    }
    this.slowOperations = this.slowOperations.filter(item => Date.parse(item.time) >= cutoff);
  }

  summary(
    rangeMs: number,
    config: PerformanceMonitoringConfig,
    status: PerformanceStoreStatus,
    now = Date.now()
  ): PerformanceSummary {
    const normalizedRangeMs = safeRange(rangeMs);
    const effectiveRangeMs = Math.min(normalizedRangeMs, config.retentionHours * HOUR_MS);
    const from = now - effectiveRangeMs;
    const bucketMs = summaryBucketMs(normalizedRangeMs);
    const tier = this.tiers.find(item => item.bucketMs === bucketMs) ?? this.tiers[this.tiers.length - 1];
    const buckets = tier.matching(from);
    const points = buckets.map(pointFromBucket).sort((left, right) => left.time.localeCompare(right.time));
    const sources: PerformanceSourceStatus[] = [...this.latestSources.values()]
      .filter(snapshot => snapshot.timeMs >= from)
      .map(snapshot => ({
        source: snapshot.source,
        lastSeenAt: snapshot.lastSeenAt,
        online: now - snapshot.timeMs <= Math.max(30_000, snapshot.intervalMs * 3),
        latest: snapshot.latest
      }))
      .sort((left, right) => sourceKey(left.source).localeCompare(sourceKey(right.source)));
    return {
      generatedAt: new Date(now).toISOString(),
      rangeMs: normalizedRangeMs,
      bucketMs,
      config,
      status,
      sources,
      points,
      httpOperations: aggregateOperations(buckets, bucket => bucket.httpOperations),
      hotOperations: aggregateOperations(buckets, bucket => bucket.hotOperations),
      slowOperations: this.slowOperations
        .filter(operation => Date.parse(operation.time) >= from)
        .sort((left, right) => right.time.localeCompare(left.time))
        .slice(0, PERFORMANCE_STORE_MEMORY_LIMITS.slowOperations)
    };
  }

  memoryUsage(): PerformanceAggregateMemoryUsage {
    return this.tiers.reduce<PerformanceAggregateMemoryUsage>((usage, tier) => {
      const tierUsage = tier.usage();
      usage.aggregateBuckets += tierUsage.aggregateBuckets;
      usage.aggregateOperationEntries += tierUsage.aggregateOperationEntries;
      usage.representedSamples = Math.max(usage.representedSamples, tierUsage.representedSamples);
      return usage;
    }, {
      aggregateBuckets: 0,
      aggregateOperationEntries: 0,
      representedSamples: 0,
      sourceSnapshots: this.latestSources.size,
      slowOperations: this.slowOperations.length
    });
  }
}
