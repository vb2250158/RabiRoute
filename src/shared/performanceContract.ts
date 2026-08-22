export type PerformanceSourceKind = "manager" | "gateway" | "webgui";

export type PerformanceMonitoringConfig = {
  enabled: boolean;
  sampleIntervalMs: number;
  retentionHours: number;
  maxDiskMb: number;
  slowOperationMs: number;
};

export type PerformanceSource = {
  kind: PerformanceSourceKind;
  id: string;
  runtimeId: string;
  pid?: number;
};

export type PerformanceSystemMetrics = {
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  eventLoopP50Ms: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  eventLoopUtilization: number;
  gcCount?: number;
  gcDurationMs?: number;
  gcMaxMs?: number;
};

export type PerformanceOperationSummary = {
  operation: string;
  count: number;
  errorCount: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalBytes?: number;
  maxBytes?: number;
};

export type PerformanceHttpMetrics = PerformanceOperationSummary & {
  operations: PerformanceOperationSummary[];
};

export type FrontendPerformanceMetrics = {
  page: string;
  navigationMs?: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  jsHeapUsedBytes?: number;
  jsHeapLimitBytes?: number;
};

export type PerformanceSlowOperation = {
  time: string;
  operation: string;
  durationMs: number;
  kind?: "http" | "operation";
  statusCode?: number;
  requestId?: string;
};

export type PerformanceSample = {
  schemaVersion: 1;
  kind: "performance_sample";
  sampleId: string;
  time: string;
  intervalMs: number;
  source: PerformanceSource;
  system?: PerformanceSystemMetrics;
  http?: PerformanceHttpMetrics;
  operations?: PerformanceOperationSummary[];
  frontend?: FrontendPerformanceMetrics;
  slowOperations?: PerformanceSlowOperation[];
};

export type PerformanceSeriesPoint = {
  time: string;
  source: PerformanceSource;
  cpuPercent?: number;
  rssBytes?: number;
  heapUsedBytes?: number;
  eventLoopP95Ms?: number;
  eventLoopMaxMs?: number;
  eventLoopUtilization?: number;
  gcCount: number;
  gcDurationMs?: number;
  gcMaxMs?: number;
  requestCount: number;
  errorCount: number;
  requestP95Ms?: number;
  requestMaxMs?: number;
  longTaskCount: number;
  longTaskMaxMs?: number;
  jsHeapUsedBytes?: number;
};

export type PerformanceSourceStatus = {
  source: PerformanceSource;
  lastSeenAt: string;
  online: boolean;
  latest?: PerformanceSeriesPoint;
};

export type PerformanceStoreStatus = {
  enabled: boolean;
  loaded: boolean;
  logDirectory: string;
  pendingRecords: number;
  retainedRecords: number;
  fileCount: number;
  diskBytes: number;
  lastPersistedAt?: string;
  droppedRecords: number;
  lastAppendDurationMs?: number;
  lastSummaryDurationMs?: number;
  lastFlushDurationMs?: number;
  lastCleanupDurationMs?: number;
  summaryCacheHits: number;
  lastError?: string;
};

export type PerformanceOperationAggregate = PerformanceOperationSummary & {
  source: PerformanceSource;
};

export type PerformanceSummary = {
  generatedAt: string;
  rangeMs: number;
  bucketMs: number;
  config: PerformanceMonitoringConfig;
  status: PerformanceStoreStatus;
  sources: PerformanceSourceStatus[];
  points: PerformanceSeriesPoint[];
  httpOperations: PerformanceOperationAggregate[];
  hotOperations: PerformanceOperationAggregate[];
  slowOperations: Array<PerformanceSlowOperation & { source: PerformanceSource }>;
};

export const defaultPerformanceMonitoringConfig = (): PerformanceMonitoringConfig => ({
  enabled: false,
  sampleIntervalMs: 5_000,
  retentionHours: 48,
  maxDiskMb: 256,
  slowOperationMs: 2_000
});

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function normalizePerformanceMonitoringConfig(raw: unknown): PerformanceMonitoringConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<PerformanceMonitoringConfig>
    : {};
  const defaults = defaultPerformanceMonitoringConfig();
  return {
    enabled: source.enabled === true,
    sampleIntervalMs: boundedNumber(source.sampleIntervalMs, defaults.sampleIntervalMs, 1_000, 60_000),
    retentionHours: boundedNumber(source.retentionHours, defaults.retentionHours, 1, 24 * 30),
    maxDiskMb: boundedNumber(source.maxDiskMb, defaults.maxDiskMb, 16, 4_096),
    slowOperationMs: boundedNumber(source.slowOperationMs, defaults.slowOperationMs, 100, 120_000)
  };
}

export function normalizePerformanceOperation(value: string): string {
  let pathname = String(value || "/").split("?", 1)[0] || "/";
  pathname = pathname
    .replace(/\/api\/roles\/[^/]+/g, "/api/roles/:roleId")
    .replace(/\/api\/roles\/:roleId\/plans\/[^/]+/g, "/api/roles/:roleId/plans/:planId")
    .replace(/\/gateways\/[^/]+/g, "/gateways/:gatewayId")
    .replace(/\/api\/message-processing\/requirements\/[^/]+/g, "/api/message-processing/requirements/:requirementId")
    .replace(/\/api\/agent\/requests\/[^/]+/g, "/api/agent/requests/:requestId")
    .replace(/\/api\/agent\/threads\/[^/]+/g, "/api/agent/threads/:threadId")
    .replace(/\/api\/plans\/[^/]+/g, "/api/plans/:planId")
    .replace(/\/routes\/[^/]+/g, "/routes/:routeId")
    .replace(/\/persona\/[^/]+/g, "/persona/:roleId")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id");
  return pathname.slice(0, 240);
}

const nonTerminatingPerformanceHttpOperations = new Set([
  "/api/events",
  "/api/speech/events"
]);

export function isMeasuredPerformanceHttpOperation(value: string): boolean {
  const operation = normalizePerformanceOperation(value);
  return !operation.startsWith("/api/performance/")
    && !nonTerminatingPerformanceHttpOperations.has(operation);
}

export function performanceOperationTotalMs(summary: Pick<PerformanceOperationSummary, "count" | "p50Ms" | "totalMs">): number {
  return Number.isFinite(summary.totalMs) ? summary.totalMs : summary.p50Ms * summary.count;
}

export function performancePercentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] * 10) / 10;
}
