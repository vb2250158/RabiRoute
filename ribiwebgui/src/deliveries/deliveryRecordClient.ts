import { getTimeoutMs } from "../timeoutSettingsClient";
import type { AgentDeliveryRecord, AgentDeliveryRecordPage } from "@shared/agentDeliveryRecord";
import type { AgentInstance } from "@shared/agentInstance";

export type DeliveryRecordQuery = { state?: string; query?: string; cursor?: string; limit?: number; nodeId?: string };

/** Read the existing owner through the WebGUI's authenticated relative-URL transport. */
async function readEnvelope(pathname: string, signal: AbortSignal, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(pathname, {
    method: "GET", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(getTimeoutMs("webgui.delivery.read", 15000))])
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || `Delivery records: HTTP ${response.status}`);
  return result;
}

async function read<T>(pathname: string, signal: AbortSignal, fetcher: typeof fetch): Promise<T> {
  return (await readEnvelope(pathname, signal, fetcher)).data as T;
}

/** Same computer catalog as RabiLink; this never scans Agent sessions. */
export async function readDeliveryComputers(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AgentInstance[]> {
  return (await readEnvelope("/api/lan-agent/instances", signal, fetcher)).instances as AgentInstance[];
}

export function readDeliveryRecords(query: DeliveryRecordQuery, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AgentDeliveryRecordPage> {
  const search = new URLSearchParams({ limit: String(query.limit ?? 50) });
  for (const key of ["state", "query", "cursor", "nodeId"] as const) if (query[key]) search.set(key, query[key]);
  return read(`/api/agent/deliveries?${search}`, signal, fetcher);
}

export function readDeliveryRecord(deliveryId: string, signal: AbortSignal, fetcher: typeof fetch = fetch, nodeId?: string): Promise<AgentDeliveryRecord> {
  const suffix = nodeId ? `?${new URLSearchParams({ nodeId })}` : "";
  return read(`/api/agent/deliveries/${encodeURIComponent(deliveryId)}${suffix}`, signal, fetcher);
}
