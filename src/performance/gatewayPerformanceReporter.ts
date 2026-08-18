import type { PerformanceMonitoringConfig, PerformanceSample } from "../shared/performanceContract.js";
import { normalizePerformanceMonitoringConfig } from "../shared/performanceContract.js";
import { createNodePerformanceCollector } from "./nodePerformanceCollector.js";
import { installPerformanceOperationSink } from "./performanceInstrumentation.js";

export function startGatewayPerformanceReporter(options: {
  managerUrl?: string;
  gatewayId?: string;
} = {}): () => void {
  const managerUrl = String(options.managerUrl || process.env.GATEWAY_MANAGER_URL || "").replace(/\/+$/, "");
  const gatewayId = String(options.gatewayId || process.env.GATEWAY_ID || "").trim();
  if (!managerUrl || !gatewayId) return () => undefined;
  let stopped = false;
  let config: PerformanceMonitoringConfig = normalizePerformanceMonitoringConfig(undefined);
  let refreshTimer: NodeJS.Timeout | undefined;
  let queued: PerformanceSample[] = [];
  let sending = false;

  const sendQueued = async (): Promise<void> => {
    if (sending || stopped || !queued.length) return;
    sending = true;
    const batch = queued.splice(0, 20);
    try {
      const response = await fetch(`${managerUrl}/api/performance/batches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samples: batch })
      });
      if (!response.ok) queued = [...batch.slice(-5), ...queued].slice(-20);
    } catch {
      queued = [...batch.slice(-5), ...queued].slice(-20);
    } finally {
      sending = false;
      if (queued.length) setTimeout(() => { void sendQueued(); }, 1_000).unref();
    }
  };

  const collector = createNodePerformanceCollector({
    sourceKind: "gateway",
    sourceId: gatewayId,
    emit(sample) {
      queued.push(sample);
      if (queued.length > 20) queued = queued.slice(-20);
      void sendQueued();
    }
  });
  const uninstallOperationSink = installPerformanceOperationSink(record => collector.recordOperation(record));

  const refreshConfig = async (): Promise<void> => {
    if (stopped) return;
    try {
      const response = await fetch(`${managerUrl}/api/performance/config`, { headers: { accept: "application/json" } });
      const payload = await response.json() as { data?: unknown };
      if (response.ok) {
        config = normalizePerformanceMonitoringConfig(payload.data);
        collector.update(config);
      }
    } catch {
      // Manager may be restarting; the last confirmed setting remains active.
    } finally {
      if (!stopped) {
        refreshTimer = setTimeout(() => { void refreshConfig(); }, 30_000);
        refreshTimer.unref();
      }
    }
  };

  collector.start(config);
  void refreshConfig();
  return () => {
    stopped = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    uninstallOperationSink();
    collector.stop();
    queued = [];
  };
}
