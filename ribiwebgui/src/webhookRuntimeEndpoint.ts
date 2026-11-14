import type { GatewayDefinition, RuntimeStatus } from "./types";

/** Read the original named HTTP owner's active publication, including its process and lease fences. */
export function publishedHttpCallbackUrl(
  runtime: Pick<RuntimeStatus, "running" | "pid" | "startedAt" | "gatewayStatus">,
  type: string,
  pathname: string,
  bindHost = "127.0.0.1"
): string {
  const status = runtime.gatewayStatus;
  const listener = status?.messageAdapters?.[type];
  const startedAt = Date.parse(runtime.startedAt ?? "");
  const updatedAt = Date.parse(String(listener?.updatedAt ?? ""));
  if (!runtime.running || !Number.isInteger(runtime.pid) || Number(runtime.pid) <= 0 || status?.pid !== runtime.pid
    || !Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt < startedAt
    || listener?.listenerReady !== true || typeof listener.listenerLeaseId !== "string" || !listener.listenerLeaseId.trim()
    || typeof listener.gatewayGenerationId !== "string" || !listener.gatewayGenerationId.trim()
    || listener.gatewayGenerationId !== status?.gatewayGenerationId) return "";
  try {
    const url = new URL(String(status?.httpCallbacks?.[type]?.url || ""));
    const host = ["0.0.0.0", "::", "[::]"].includes(bindHost) ? "127.0.0.1"
      : bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
    return url.protocol === "http:" && url.hostname === host && Number(url.port) > 0
      && url.pathname === pathname && !url.username && !url.password && !url.search && !url.hash ? url.href : "";
  } catch { return ""; }
}

/** Only the original running listener may supply an automatic endpoint address. */
export function publishedAutomaticWebhookUrl(
  saved: Pick<GatewayDefinition, "webhookPort" | "webhookPath"> | null,
  runtime: Pick<RuntimeStatus, "running" | "pid" | "startedAt" | "gatewayStatus">,
  pathname: string
): string {
  if (!saved || (saved.webhookPort ?? 0) !== 0) return "";
  const savedPath = saved.webhookPath?.trim() || "/webhook";
  const normalizedPath = savedPath.startsWith("/") ? savedPath : `/${savedPath}`;
  return normalizedPath === pathname ? publishedHttpCallbackUrl(runtime, "webhook", pathname) : "";
}
