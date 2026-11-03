import { randomUUID } from "node:crypto";
import { requestPeerRouteDelivery } from "./peerRouteClient.js";
import { renderRabiDelivery, normalizeRabiMessageSource } from "../shared/rabiMessage.js";
import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeAgentInstanceBindings, type AgentInstance, type AgentInstanceBinding } from "../shared/agentInstance.js";
import { resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";

export function configuredInstanceBinding(provider: string): AgentInstanceBinding | undefined {
  if (process.env.PRIMARY_AGENT_TARGET !== undefined) {
    const target = resolvePrimaryAgentTarget({
      agentAdapters: [],
      remoteAgentTargets: JSON.parse(process.env.REMOTE_AGENT_TARGETS || "[]"),
      primaryAgentTarget: process.env.PRIMARY_AGENT_TARGET
    });
    return target?.provider === provider ? target.binding : undefined;
  }
  // Transitional child processes launched before instance-target configuration.
  if (process.env.PRIMARY_AGENT_ADAPTER && process.env.PRIMARY_AGENT_ADAPTER !== provider) return undefined;
  return normalizeAgentInstanceBindings(JSON.parse(process.env.AGENT_INSTANCE_BINDINGS || "{}"))?.[provider];
}

async function instanceRequest(suffix: string, body?: unknown): Promise<any> {
  const baseUrl = process.env.GATEWAY_MANAGER_URL?.trim();
  const token = process.env.LAN_AGENT_ACCESS_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("The owning Manager has not supplied the instance connection.");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/lan-agent/instances${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(getTimeoutMs("backend.agentAdapters.instanceClient.instanceRequest.AbortSignal.timeout.request", 35_000))
  });
  const result = await response.json() as any;
  if (!response.ok || result.code !== 0) throw new Error(result.message || `Instance request failed: HTTP ${response.status}`);
  return result;
}

export async function requestInstanceThread(binding: AgentInstanceBinding, payload: Record<string, unknown>): Promise<Record<string, any>> {
  if (Array.isArray(payload.imagePaths) && payload.imagePaths.length) throw new Error("Instance tasks require remotely accessible attachments; local image paths cannot be sent to another computer.");
  if (binding.ownerDeviceId && (payload.action === "send" || payload.action === "reconcile_delivery" || payload.action === "read" && payload.deliveryId)) {
    const messageDelivery = payload.messageDelivery as { deliveryId?: string } | undefined;
    const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : messageDelivery?.deliveryId || (payload.action === "send" ? randomUUID() : undefined);
    const prompt = payload.action === "send" && payload.messageSource ? renderRabiDelivery({
      messageSource: normalizeRabiMessageSource(payload.messageSource), messageContent: String(payload.prompt || ""), deliveryId,
      contextBlocks: payload.contextBlocks as string[] | undefined, controlBlocks: payload.controlBlocks as string[] | undefined,
      ...(typeof payload.sentAt === "string" ? { sentAt: payload.sentAt } : {})
    }) : payload.prompt;
    return requestPeerRouteDelivery(binding, { ...payload, deliveryId, prompt });
  }
  if (binding.ownerDeviceId) {
    const baseUrl = process.env.GATEWAY_MANAGER_URL?.trim(), token = process.env.LAN_AGENT_ACCESS_TOKEN?.trim();
    if (!baseUrl) throw new Error("The owning Manager has not supplied the instance connection.");
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/agent/threads`, { method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...payload, instanceBinding: binding }), signal: AbortSignal.timeout(getTimeoutMs("backend.agentAdapters.instanceClient.instanceRequest.AbortSignal.timeout.request", 35_000)) });
    const body = await response.json() as Record<string, any>;
    if (!response.ok || body.code === -1) throw new Error(body.message || "Peer task operation failed; inspect the original delivery receipt.");
    return body;
  }
  const { result } = await instanceRequest(`/${encodeURIComponent(binding.instanceId)}/agents/${encodeURIComponent(binding.agentId)}/threads`, payload);
  if (!result || result.statusCode >= 400) throw new Error(result?.data?.message || "Instance task operation failed.");
  return result.data;
}

/** Changing computer or primary task cannot revive workers from an unrelated owner. */
export function instanceWorkerStateDirectory(dataDir: string, binding: AgentInstanceBinding, sessionId: string): string {
  const identity = binding.ownerDeviceId ? [binding.ownerDeviceId, binding.instanceId, binding.agentId, sessionId] : [binding.instanceId, binding.agentId, sessionId];
  const scope = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return path.join(dataDir, "instance-workers", scope);
}
