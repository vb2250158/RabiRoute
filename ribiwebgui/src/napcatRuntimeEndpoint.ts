import type { RuntimeStatus } from "./types";

/** A saved zero is a preference; only the current native listener publishes a usable address. */
export function publishedNapcatWsUrl(
  runtime: Pick<RuntimeStatus, "running" | "pid" | "startedAt" | "gatewayStatus">,
  instanceId: string,
  enabled = true
): string {
  if (!enabled || !runtime.running || !Number.isInteger(runtime.pid) || Number(runtime.pid) <= 0 || !instanceId) return "";
  const status = runtime.gatewayStatus;
  const listener = status?.napcatInstances?.[instanceId];
  const startedAt = Date.parse(runtime.startedAt ?? "");
  const updatedAt = Date.parse(String(status?.updatedAt ?? ""));
  const listenerUpdatedAt = Date.parse(String(listener?.updatedAt ?? status?.messageAdapters?.napcat?.updatedAt ?? ""));
  const port = Number(listener?.gatewayPort);
  if (Number(status?.pid) !== runtime.pid || !Number.isFinite(startedAt) || !Number.isFinite(updatedAt)
      || !Number.isFinite(listenerUpdatedAt) || updatedAt < startedAt || listenerUpdatedAt < startedAt
      || listener?.listenerReady !== true || typeof listener.listenerLeaseId !== "string" || !listener.listenerLeaseId.trim()
      || typeof listener.gatewayGenerationId !== "string" || !listener.gatewayGenerationId.trim()
      || !Number.isInteger(port) || port <= 0 || port > 65535) return "";
  if (status?.gatewayGenerationId !== listener.gatewayGenerationId) return "";
  return `ws://127.0.0.1:${port}`;
}

export function isNapcatPortSetting(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}
