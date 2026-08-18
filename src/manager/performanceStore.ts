import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";
import {
  performanceOperationTotalMs,
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
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";

type Listener = (sample: PerformanceSample) => void;

function sampleTime(sample: PerformanceSample): number {
  return Date.parse(sample.time);
}

function shardName(time: string): string {
  return `performance-${time.slice(0, 13).replace("T", "-")}.jsonl`;
}

export function isPerformanceSample(value: unknown): value is PerformanceSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Partial<PerformanceSample>;
  return sample.schemaVersion === 1
    && sample.kind === "performance_sample"
    && typeof sample.sampleId === "string"
    && sample.sampleId.length > 0
    && typeof sample.time === "string"
    && Number.isFinite(Date.parse(sample.time))
    && typeof sample.intervalMs === "number"
    && Number.isFinite(sample.intervalMs)
    && sample.intervalMs >= 1_000
    && Boolean(sample.source
      && ["manager", "gateway", "webgui"].includes(sample.source.kind)
      && typeof sample.source.id === "string"
      && sample.source.id.length > 0
      && typeof sample.source.runtimeId === "string"
      && sample.source.runtimeId.length > 0);
}

function aggregatePoint(samples: PerformanceSample[], bucketTime: number): PerformanceSeriesPoint {
  const source = samples[0].source;
  const systems = samples.flatMap(sample => sample.system ? [sample.system] : []);
  const http = samples.flatMap(sample => sample.http ? [sample.http] : []);
  const frontend = samples.flatMap(sample => sample.frontend ? [sample.frontend] : []);
  const average = (values: number[]): number | undefined => values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
    : undefined;
  const maximum = (values: number[]): number | undefined => values.length
    ? Math.round(Math.max(...values) * 10) / 10
    : undefined;
  return {
    time: new Date(bucketTime).toISOString(),
    source,
    cpuPercent: average(systems.map(item => item.cpuPercent)),
    rssBytes: average(systems.map(item => item.rssBytes)),
    heapUsedBytes: average(systems.map(item => item.heapUsedBytes)),
    eventLoopP95Ms: maximum(systems.map(item => item.eventLoopP95Ms)),
    eventLoopMaxMs: maximum(systems.map(item => item.eventLoopMaxMs)),
    eventLoopUtilization: average(systems.map(item => item.eventLoopUtilization)),
    gcCount: systems.reduce((sum, item) => sum + (item.gcCount ?? 0), 0),
    gcDurationMs: systems.reduce((sum, item) => sum + (item.gcDurationMs ?? 0), 0),
    gcMaxMs: maximum(systems.map(item => item.gcMaxMs ?? 0)),
    requestCount: http.reduce((sum, item) => sum + item.count, 0),
    errorCount: http.reduce((sum, item) => sum + item.errorCount, 0),
    requestP95Ms: maximum(http.map(item => item.p95Ms)),
    requestMaxMs: maximum(http.map(item => item.maxMs)),
    longTaskCount: frontend.reduce((sum, item) => sum + item.longTaskCount, 0),
    longTaskMaxMs: maximum(frontend.map(item => item.longTaskMaxMs)),
    jsHeapUsedBytes: average(frontend.flatMap(item => typeof item.jsHeapUsedBytes === "number" ? [item.jsHeapUsedBytes] : []))
  };
}

function aggregateOperationSummaries(
  samples: PerformanceSample[],
  select: (sample: PerformanceSample) => PerformanceOperationSummary[]
): PerformanceOperationAggregate[] {
  const groups = new Map<string, {
    source: PerformanceSource;
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
  }>();
  for (const sample of samples) {
    for (const item of select(sample)) {
      const key = `${sample.source.kind}:${sample.source.id}:${sample.source.runtimeId}:${item.operation}`;
      const group = groups.get(key) ?? {
        source: sample.source,
        operation: item.operation,
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
      group.count += item.count;
      group.errorCount += item.errorCount;
      group.totalMs += performanceOperationTotalMs(item);
      group.weightedP50Ms += item.p50Ms * item.count;
      group.p95Ms = Math.max(group.p95Ms, item.p95Ms);
      group.maxMs = Math.max(group.maxMs, item.maxMs);
      if (typeof item.totalBytes === "number") {
        group.hasBytes = true;
        group.totalBytes += item.totalBytes;
        group.maxBytes = Math.max(group.maxBytes, item.maxBytes ?? 0);
      }
      groups.set(key, group);
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

export function buildPerformanceSummary(
  samples: PerformanceSample[],
  rangeMs: number,
  config: PerformanceMonitoringConfig,
  status: PerformanceStoreStatus,
  now = Date.now()
): PerformanceSummary {
  const safeRangeMs = Math.min(48 * 60 * 60 * 1_000, Math.max(60_000, rangeMs));
  const from = now - safeRangeMs;
  const bucketMs = safeRangeMs <= 60 * 60 * 1_000
    ? 10_000
    : safeRangeMs <= 6 * 60 * 60 * 1_000
      ? 60_000
      : 5 * 60_000;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sampleTime(samples[middle]) < from) low = middle + 1;
    else high = middle;
  }
  const matching = samples.slice(low);
  const buckets = new Map<string, PerformanceSample[]>();
  for (const sample of matching) {
    const bucketTime = Math.floor(sampleTime(sample) / bucketMs) * bucketMs;
    const key = `${sample.source.kind}:${sample.source.id}:${sample.source.runtimeId}:${bucketTime}`;
    const list = buckets.get(key) ?? [];
    list.push(sample);
    buckets.set(key, list);
  }
  const points = [...buckets.values()]
    .map(bucketSamples => aggregatePoint(
      bucketSamples,
      Math.floor(sampleTime(bucketSamples[0]) / bucketMs) * bucketMs
    ))
    .sort((left, right) => left.time.localeCompare(right.time));
  const latestBySource = new Map<string, PerformanceSample>();
  for (const sample of matching) {
    const key = `${sample.source.kind}:${sample.source.id}:${sample.source.runtimeId}`;
    const existing = latestBySource.get(key);
    if (!existing || sample.time > existing.time) latestBySource.set(key, sample);
  }
  const sources: PerformanceSourceStatus[] = [...latestBySource.values()].map(sample => ({
    source: sample.source,
    lastSeenAt: sample.time,
    online: now - sampleTime(sample) <= Math.max(30_000, sample.intervalMs * 3),
    latest: aggregatePoint([sample], sampleTime(sample))
  })).sort((left, right) =>
    `${left.source.kind}:${left.source.id}:${left.source.runtimeId}`
      .localeCompare(`${right.source.kind}:${right.source.id}:${right.source.runtimeId}`)
  );
  const slowOperations = matching
    .flatMap(sample => (sample.slowOperations ?? []).map(operation => ({ ...operation, source: sample.source })))
    .sort((left, right) => right.time.localeCompare(left.time))
    .slice(0, 100);
  return {
    generatedAt: new Date(now).toISOString(),
    rangeMs: safeRangeMs,
    bucketMs,
    config,
    status,
    sources,
    points,
    httpOperations: aggregateOperationSummaries(matching, sample => sample.http?.operations ?? []),
    hotOperations: aggregateOperationSummaries(matching, sample => sample.operations ?? []),
    slowOperations
  };
}

export class PerformanceStore {
  readonly logDirectory: string;
  private config: PerformanceMonitoringConfig;
  private samples: PerformanceSample[] = [];
  private sampleIds = new Set<string>();
  private pending = new Map<string, string[]>();
  private flushTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private activeFlush: Promise<void> | undefined;
  private listeners = new Set<Listener>();
  private loaded = false;
  private lastPersistedAt: string | undefined;
  private lastError: string | undefined;
  private droppedRecords = 0;
  private fileCount = 0;
  private diskBytes = 0;
  private sampleVersion = 0;
  private summaryCache = new Map<number, { version: number; expiresAt: number; summary: PerformanceSummary }>();
  private summaryCacheHits = 0;
  private lastAppendDurationMs: number | undefined;
  private lastSummaryDurationMs: number | undefined;
  private lastFlushDurationMs: number | undefined;
  private lastCleanupDurationMs: number | undefined;

  constructor(rootDir: string, config: PerformanceMonitoringConfig) {
    this.logDirectory = projectDirectoryLayout(rootDir).performanceLogRoot;
    this.config = config;
  }

  async start(): Promise<void> {
    await fs.promises.mkdir(this.logDirectory, { recursive: true });
    await this.cleanup();
    await this.loadRecent();
    this.scheduleCleanup();
  }

  applyConfig(config: PerformanceMonitoringConfig): void {
    this.config = config;
    this.pruneMemory();
    this.sampleVersion += 1;
    this.summaryCache.clear();
    void this.cleanup();
  }

  append(sample: PerformanceSample): boolean {
    const startedAt = performance.now();
    if (!this.config.enabled || !isPerformanceSample(sample)) return false;
    if (this.sampleIds.has(sample.sampleId)) return false;
    const serialized = `${JSON.stringify(sample)}\n`;
    const pendingCount = [...this.pending.values()].reduce((sum, lines) => sum + lines.length, 0);
    if (pendingCount >= 1_000) {
      const firstShard = this.pending.keys().next().value as string | undefined;
      if (firstShard) {
        const lines = this.pending.get(firstShard);
        if (lines?.length) lines.shift();
        if (!lines?.length) this.pending.delete(firstShard);
      }
      this.droppedRecords += 1;
    }
    const shard = shardName(sample.time);
    const lines = this.pending.get(shard) ?? [];
    lines.push(serialized);
    this.pending.set(shard, lines);
    this.remember(sample);
    this.sampleVersion += 1;
    this.summaryCache.clear();
    this.scheduleFlush();
    for (const listener of this.listeners) listener(sample);
    this.lastAppendDurationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(rangeMs: number): PerformanceSummary {
    const startedAt = performance.now();
    const safeRangeMs = Math.min(48 * 60 * 60 * 1_000, Math.max(60_000, rangeMs));
    const now = Date.now();
    const cached = this.summaryCache.get(safeRangeMs);
    if (cached && cached.version === this.sampleVersion && cached.expiresAt > now) {
      this.summaryCacheHits += 1;
      return cached.summary;
    }
    const summary = buildPerformanceSummary(this.samples, safeRangeMs, this.config, this.status(), now);
    this.lastSummaryDurationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    summary.status = this.status();
    this.summaryCache.set(safeRangeMs, { version: this.sampleVersion, expiresAt: now + 1_000, summary });
    recordPerformanceOperation(PERFORMANCE_OPERATIONS.performanceStoreSummary, this.lastSummaryDurationMs);
    return summary;
  }

  recent(limit = 100): PerformanceSample[] {
    return this.samples.slice(-Math.min(1_000, Math.max(1, limit)));
  }

  status(): PerformanceStoreStatus {
    return {
      enabled: this.config.enabled,
      loaded: this.loaded,
      logDirectory: "data/.runtime/performance",
      pendingRecords: [...this.pending.values()].reduce((sum, lines) => sum + lines.length, 0),
      retainedRecords: this.samples.length,
      fileCount: this.fileCount,
      diskBytes: this.diskBytes,
      lastPersistedAt: this.lastPersistedAt,
      droppedRecords: this.droppedRecords,
      lastAppendDurationMs: this.lastAppendDurationMs,
      lastSummaryDurationMs: this.lastSummaryDurationMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
      lastCleanupDurationMs: this.lastCleanupDurationMs,
      summaryCacheHits: this.summaryCacheHits,
      lastError: this.lastError
    };
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0 || this.activeFlush) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      const active = this.activeFlush ?? this.startFlush();
      if (active) await active;
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.flushTimer = undefined;
    this.cleanupTimer = undefined;
    await this.flush();
  }

  private remember(sample: PerformanceSample): void {
    if (this.sampleIds.has(sample.sampleId)) return;
    this.sampleIds.add(sample.sampleId);
    const last = this.samples[this.samples.length - 1];
    if (!last || last.time <= sample.time) {
      this.samples.push(sample);
    } else {
      let low = 0;
      let high = this.samples.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.samples[middle].time <= sample.time) low = middle + 1;
        else high = middle;
      }
      this.samples.splice(low, 0, sample);
    }
    this.pruneMemory();
  }

  private pruneMemory(): void {
    const cutoff = Date.now() - this.config.retentionHours * 60 * 60 * 1_000;
    let low = 0;
    let high = this.samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sampleTime(this.samples[middle]) < cutoff) low = middle + 1;
      else high = middle;
    }
    const removeCount = Math.max(low, this.samples.length - 100_000);
    if (removeCount <= 0) return;
    for (let index = 0; index < removeCount; index += 1) {
      this.sampleIds.delete(this.samples[index].sampleId);
    }
    this.samples = this.samples.slice(removeCount);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.activeFlush) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.startFlush();
    }, 100);
    this.flushTimer.unref();
  }

  private startFlush(): Promise<void> | undefined {
    if (this.activeFlush || !this.pending.size) return this.activeFlush;
    const batch = new Map(this.pending);
    this.pending.clear();
    const startedAt = performance.now();
    this.activeFlush = (async () => {
      await fs.promises.mkdir(this.logDirectory, { recursive: true });
      for (const [shard, lines] of batch) {
        await fs.promises.appendFile(path.join(this.logDirectory, shard), lines.join(""), "utf8");
      }
      this.lastPersistedAt = new Date().toISOString();
      this.lastError = undefined;
      await this.refreshDiskStatus();
    })().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.droppedRecords += [...batch.values()].reduce((sum, lines) => sum + lines.length, 0);
    }).finally(() => {
      this.lastFlushDurationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      this.activeFlush = undefined;
      if (this.pending.size) this.scheduleFlush();
    });
    return this.activeFlush;
  }

  private async loadRecent(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.logDirectory, { withFileTypes: true });
      const cutoff = Date.now() - this.config.retentionHours * 60 * 60 * 1_000;
      const files = entries
        .filter(entry => entry.isFile() && /^performance-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
        .map(entry => entry.name)
        .sort();
      for (const filename of files) {
        const input = fs.createReadStream(path.join(this.logDirectory, filename), { encoding: "utf8" });
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const sample = JSON.parse(line) as unknown;
            if (isPerformanceSample(sample) && sampleTime(sample) >= cutoff) this.remember(sample);
          } catch {
            // A partially written final line is ignored; later records remain readable.
          }
        }
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loaded = true;
      await this.refreshDiskStatus();
    }
  }

  private scheduleCleanup(): void {
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      void this.cleanup().finally(() => this.scheduleCleanup());
    }, 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  private async cleanup(): Promise<void> {
    const startedAt = performance.now();
    await fs.promises.mkdir(this.logDirectory, { recursive: true });
    const entries = await fs.promises.readdir(this.logDirectory, { withFileTypes: true });
    const cutoff = Date.now() - this.config.retentionHours * 60 * 60 * 1_000;
    const files = (await Promise.all(entries
      .filter(entry => entry.isFile() && /^performance-.*\.jsonl$/.test(entry.name))
      .map(async entry => {
        const filePath = path.join(this.logDirectory, entry.name);
        const stat = await fs.promises.stat(filePath);
        return { filePath, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size };
      }))).sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files.filter(item => item.mtimeMs < cutoff)) {
      await fs.promises.rm(file.filePath, { force: true });
    }
    const remaining = files.filter(item => item.mtimeMs >= cutoff);
    const maximumBytes = this.config.maxDiskMb * 1024 * 1024;
    let totalBytes = remaining.reduce((sum, item) => sum + item.size, 0);
    for (const file of remaining) {
      if (totalBytes <= maximumBytes) break;
      await fs.promises.rm(file.filePath, { force: true });
      totalBytes -= file.size;
    }
    await this.refreshDiskStatus();
    this.lastCleanupDurationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  }

  private async refreshDiskStatus(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.logDirectory, { withFileTypes: true });
      const files = entries.filter(entry => entry.isFile() && /^performance-.*\.jsonl$/.test(entry.name));
      const stats = await Promise.all(files.map(entry => fs.promises.stat(path.join(this.logDirectory, entry.name))));
      this.fileCount = files.length;
      this.diskBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
    } catch {
      this.fileCount = 0;
      this.diskBytes = 0;
    }
  }
}
