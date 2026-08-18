import type { PerformanceMonitoringConfig, PerformanceSample, PerformanceSummary } from "@shared/performanceContract";

type ApiEnvelope<T> = { code: number; data: T; message?: string };

async function apiJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, init);
  const body = await response.json() as ApiEnvelope<T>;
  if (!response.ok || body.code < 0) throw new Error(body.message || `HTTP ${response.status}`);
  return body.data;
}

export function loadPerformanceSummary(rangeMs: number): Promise<PerformanceSummary> {
  return apiJson(`/api/performance/summary?rangeMs=${encodeURIComponent(String(rangeMs))}`);
}

export function loadPerformanceConfig(): Promise<PerformanceMonitoringConfig> {
  return apiJson("/api/performance/config");
}

export function savePerformanceConfig(config: PerformanceMonitoringConfig): Promise<PerformanceMonitoringConfig> {
  return apiJson("/api/performance/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config)
  });
}

export async function loadPerformanceLogs(limit = 40): Promise<PerformanceSample[]> {
  const response = await fetch(`/api/performance/logs?limit=${encodeURIComponent(String(limit))}`);
  const body = await response.json() as { code: number; data?: PerformanceSample[]; message?: string };
  if (!response.ok || body.code < 0) throw new Error(body.message || `HTTP ${response.status}`);
  return body.data ?? [];
}
