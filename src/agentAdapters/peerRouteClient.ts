import { randomUUID } from "node:crypto";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";

export const PEER_NATIVE_DELIVERY_UNCONFIRMED = "PEER_NATIVE_DELIVERY_UNCONFIRMED";

export async function requestPeerRouteDelivery(binding: AgentInstanceBinding, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrl = process.env.GATEWAY_MANAGER_URL?.trim();
  if (!baseUrl || !binding.ownerDeviceId) throw new Error("The owning Manager has not supplied the Peer target connection.");
  const receiptQuery = payload.action === "read" || payload.action === "reconcile_delivery";
  const messageDelivery = payload.messageDelivery as { deliveryId?: string } | undefined;
  const originalDeliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : messageDelivery?.deliveryId;
  if (receiptQuery && !originalDeliveryId?.trim()) throw new Error("Reconciliation requires the original delivery ID.");
  const deliveryId = originalDeliveryId || randomUUID();
  const token = process.env.LAN_AGENT_ACCESS_TOKEN?.trim();
  const body = { instanceId: binding.instanceId, provider: payload.agentAdapter, threadId: payload.threadId, deliveryId,
    ...(!receiptQuery ? { prompt: payload.prompt, cwd: payload.cwd, model: payload.model, reasoningEffort: payload.reasoningEffort,
      sandbox: payload.sandbox, dshDeliveryMode: payload.dshDeliveryMode } : {}) };
  const responseReceipt = { action: payload.action || "send", agentAdapter: payload.agentAdapter, threadId: payload.threadId,
    ok: false, status: "delivery_unconfirmed", delivery: { deliveryId, state: "uncertain", status: "unconfirmed" } };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/rabilink/peer/http/${encodeURIComponent(binding.ownerDeviceId)}/manager/api/agent/route-deliveries${receiptQuery ? "/reconcile" : ""}`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(getTimeoutMs("backend.agentAdapters.instanceClient.instanceRequest.AbortSignal.timeout.request", 35000))
    });
    const result = await response.json() as { code?: number; commitState?: string; message?: string; result?: { status?: string }; delivery?: { state?: string } };
    if (!response.ok || result.code !== 0) throw Object.assign(new Error(result.message || `Peer native operation failed: HTTP ${response.status}`), { statusCode: response.status,
      response: result.commitState === "not_started" ? { ...result, deliveryId, error: { commitState: "not_started", message: result.message } }
        : { ...result, delivery: responseReceipt.delivery } });
    const accepted = result.result?.status === "delivered";
    const receipt = { ...responseReceipt, ok: accepted, status: accepted ? "delivered" : "delivery_unconfirmed",
      delivery: { deliveryId, state: result.delivery?.state || (accepted ? "accepted" : "uncertain"), status: accepted ? "delivered" : "unconfirmed" } };
    if (receiptQuery) return receipt;
    if (!accepted) throw Object.assign(new Error("Native delivery is unconfirmed; query the original receipt before retry."), { response: receipt, statusCode: 202, code: PEER_NATIVE_DELIVERY_UNCONFIRMED });
    return receipt;
  } catch (error) {
    if (error && typeof error === "object" && !("response" in error)) Object.assign(error, { response: responseReceipt, code: PEER_NATIVE_DELIVERY_UNCONFIRMED });
    throw error;
  }
}
