import {
  normalizePerformanceMonitoringConfig,
  normalizePerformanceOperation,
  performancePercentile,
  type PerformanceMonitoringConfig,
  type PerformanceSample,
  type PerformanceSlowOperation
} from "@shared/performanceContract";

type RequestRecord = {
  operation: string;
  durationMs: number;
  statusCode: number;
  requestId?: string;
  time: string;
};

type OperationRecord = {
  operation: string;
  durationMs: number;
  error: boolean;
  time: string;
};

let installed = false;
let enabled = false;
let config = normalizePerformanceMonitoringConfig(undefined);
let timer: number | undefined;
let requests: RequestRecord[] = [];
let operations: OperationRecord[] = [];
let longTasks: number[] = [];
let navigationMs: number | undefined;
const runtimeId = globalThis.crypto?.randomUUID?.() || `webgui-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function managerOperation(input: RequestInfo | URL): string | undefined {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, window.location.href);
  if (url.origin !== window.location.origin) return undefined;
  if (!url.pathname.startsWith("/api/") && !["/meta", "/gateways", "/network-options", "/manager-config"].includes(url.pathname)) return undefined;
  if (url.pathname.startsWith("/api/performance/")) return undefined;
  return normalizePerformanceOperation(url.pathname);
}

function currentPage(): string {
  const hash = window.location.hash.replace(/^#/, "").split("?", 1)[0] || "/";
  return normalizePerformanceOperation(hash);
}

function schedule(): void {
  if (!enabled || timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    void submitSample();
    schedule();
  }, config.sampleIntervalMs);
}

function summarizeRequests(captured: RequestRecord[]) {
  if (!captured.length) return undefined;
  const durations = captured.map(item => item.durationMs);
  const byOperation = new Map<string, RequestRecord[]>();
  for (const item of captured) {
    const items = byOperation.get(item.operation) ?? [];
    items.push(item);
    byOperation.set(item.operation, items);
  }
  return {
    operation: "all",
    count: captured.length,
    errorCount: captured.filter(item => item.statusCode === 0 || item.statusCode >= 400).length,
    totalMs: Math.round(durations.reduce((total, value) => total + value, 0) * 10) / 10,
    p50Ms: performancePercentile(durations, 0.5),
    p95Ms: performancePercentile(durations, 0.95),
    maxMs: Math.round(Math.max(...durations) * 10) / 10,
    operations: [...byOperation.entries()].map(([operation, items]) => {
      const values = items.map(item => item.durationMs);
      return {
        operation,
        count: items.length,
        errorCount: items.filter(item => item.statusCode === 0 || item.statusCode >= 400).length,
        totalMs: Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10,
        p50Ms: performancePercentile(values, 0.5),
        p95Ms: performancePercentile(values, 0.95),
        maxMs: Math.round(Math.max(...values) * 10) / 10
      };
    }).sort((left, right) => right.count - left.count).slice(0, 24)
  };
}

function summarizeOperations(captured: OperationRecord[]) {
  const byOperation = new Map<string, OperationRecord[]>();
  for (const item of captured) {
    const items = byOperation.get(item.operation) ?? [];
    items.push(item);
    byOperation.set(item.operation, items);
  }
  return [...byOperation.entries()].map(([operation, items]) => {
    const values = items.map(item => item.durationMs);
    return {
      operation,
      count: items.length,
      errorCount: items.filter(item => item.error).length,
      totalMs: Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10,
      p50Ms: performancePercentile(values, 0.5),
      p95Ms: performancePercentile(values, 0.95),
      maxMs: Math.round(Math.max(...values) * 10) / 10
    };
  }).sort((left, right) => right.totalMs - left.totalMs).slice(0, 24);
}

async function submitSample(): Promise<void> {
  if (!enabled) return;
  const capturedRequests = requests;
  const capturedOperations = operations;
  const capturedLongTasks = longTasks;
  requests = [];
  operations = [];
  longTasks = [];
  const slowOperations: PerformanceSlowOperation[] = capturedRequests
    .filter(item => item.durationMs >= config.slowOperationMs)
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
  slowOperations.push(...capturedOperations
    .filter(item => item.durationMs >= config.slowOperationMs)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 20)
    .map(item => ({
      time: item.time,
      operation: item.operation,
      durationMs: Math.round(item.durationMs * 10) / 10,
      kind: "operation" as const
    })));
  slowOperations.sort((left, right) => right.durationMs - left.durationMs).splice(20);
  const operationSummaries = summarizeOperations(capturedOperations);
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
  }).memory;
  const sample: PerformanceSample = {
    schemaVersion: 1,
    kind: "performance_sample",
    sampleId: globalThis.crypto?.randomUUID?.() || `${runtimeId}-${Date.now()}`,
    time: new Date().toISOString(),
    intervalMs: config.sampleIntervalMs,
    source: { kind: "webgui", id: "webgui", runtimeId },
    http: summarizeRequests(capturedRequests),
    ...(operationSummaries.length ? { operations: operationSummaries } : {}),
    frontend: {
      page: currentPage(),
      navigationMs,
      longTaskCount: capturedLongTasks.length,
      longTaskMaxMs: capturedLongTasks.length ? Math.round(Math.max(...capturedLongTasks) * 10) / 10 : 0,
      jsHeapUsedBytes: memory?.usedJSHeapSize,
      jsHeapLimitBytes: memory?.jsHeapSizeLimit
    },
    ...(slowOperations.length ? { slowOperations } : {})
  };
  navigationMs = undefined;
  try {
    await fetch("/api/performance/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sample),
      keepalive: true
    });
  } catch {
    // Frontend telemetry failure must not affect the control UI.
  }
}

export function updateFrontendPerformanceConfig(value: unknown): void {
  config = normalizePerformanceMonitoringConfig(value);
  enabled = config.enabled;
  if (!enabled && timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
    requests = [];
    operations = [];
    longTasks = [];
    return;
  }
  schedule();
}

export function recordFrontendPerformanceOperation(operation: string, durationMs: number, error = false): void {
  if (!enabled) return;
  operations.push({
    operation: String(operation || "webgui.unknown").slice(0, 120),
    durationMs: Math.max(0, Number(durationMs) || 0),
    error,
    time: new Date().toISOString()
  });
  if (operations.length > 1_000) operations = operations.slice(-1_000);
}

export async function refreshFrontendPerformanceConfig(): Promise<PerformanceMonitoringConfig> {
  try {
    const response = await fetch("/api/performance/config", { headers: { accept: "application/json" } });
    const body = await response.json() as { data?: unknown };
    if (response.ok) updateFrontendPerformanceConfig(body.data);
  } catch {
    updateFrontendPerformanceConfig({ ...config, enabled: false });
  }
  return config;
}

export function installFrontendPerformanceReporter(): void {
  if (installed) return;
  installed = true;
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) navigationMs = Math.round(navigation.duration * 10) / 10;
  try {
    const observer = new PerformanceObserver(list => {
      if (!enabled) return;
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
      if (longTasks.length > 1_000) longTasks = longTasks.slice(-1_000);
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Browsers without Long Tasks support still report navigation and API timing.
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const operation = managerOperation(input);
    const startedAt = performance.now();
    try {
      const response = await originalFetch(input, init);
      if (enabled && operation) {
        requests.push({
          operation,
          durationMs: performance.now() - startedAt,
          statusCode: response.status,
          requestId: response.headers.get("x-rabiroute-request-id") || undefined,
          time: new Date().toISOString()
        });
      }
      return response;
    } catch (error) {
      if (enabled && operation) {
        requests.push({
          operation,
          durationMs: performance.now() - startedAt,
          statusCode: 0,
          time: new Date().toISOString()
        });
      }
      throw error;
    }
  };
  void refreshFrontendPerformanceConfig();
}
