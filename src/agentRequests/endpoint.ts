import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { createHash } from "node:crypto";
import type { AgentRequestParty } from "./store.js";

/** Full opaque owner identity; names and workspaces are not owner substitutes. */
export type AgentRequestEndpoint = {
  kind: "local" | "instance" | "device" | "service";
  managerInstanceId: string;
  instanceId?: string;
  nodeId?: string;
  agentId: string;
  provider: string;
  sessionId: string;
  authorizationIncarnation: string;
};

export function normalizeAgentRequestEndpoint(value: AgentRequestEndpoint): AgentRequestEndpoint {
  if (!value || !["local", "instance", "device", "service"].includes(value.kind)) throw new Error("Invalid Agent endpoint kind.");
  const required = ["managerInstanceId", "agentId", "provider", "sessionId", "authorizationIncarnation"] as const;
  for (const key of required) {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 4096) {
      throw new Error(`Invalid Agent endpoint ${key}.`);
    }
  }
  if (value.kind === "instance") {
    for (const key of ["instanceId", "nodeId"] as const) {
      if (typeof value[key] !== "string" || !value[key]!.trim() || value[key] !== value[key]!.trim() || value[key]!.length > 4096) throw new Error(`Invalid instance endpoint ${key}.`);
    }
  }
  if (value.kind === "device") {
    if (typeof value.instanceId !== "string" || !value.instanceId.trim() || value.instanceId !== value.instanceId.trim()
      || value.instanceId.length > 4096 || value.nodeId !== undefined || value.provider !== "deviceAgent") throw new Error("Invalid device endpoint owner.");
  }
  return { kind: value.kind, managerInstanceId: value.managerInstanceId,
    ...(value.kind === "instance" ? { instanceId: value.instanceId, nodeId: value.nodeId } : value.kind === "device" ? { instanceId: value.instanceId } : {}),
    agentId: value.agentId, provider: value.provider, sessionId: value.sessionId,
    authorizationIncarnation: value.authorizationIncarnation };
}

export function sameAgentEndpoint(left?: AgentRequestEndpoint, right?: AgentRequestEndpoint): boolean {
  return !!left && !!right && ["kind", "managerInstanceId", "instanceId", "nodeId", "agentId", "provider", "sessionId", "authorizationIncarnation"]
    .every(key => key === "agentId" && left.kind === "instance" && right.kind === "instance" || left[key as keyof AgentRequestEndpoint] === right[key as keyof AgentRequestEndpoint]);
}

/** Instance catalog aliases locate a backend; they do not create a different session owner. */
export function stableAgentEndpointIdentity(value: AgentRequestEndpoint) {
  const normalized = normalizeAgentRequestEndpoint(value);
  if (normalized.kind !== "instance") return normalized;
  const { agentId: _alias, ...identity } = normalized;
  return identity;
}

/** Rebound authority must still locate its original reservation before authorization rejects it. */
export function agentDeliverySourceIdentity(value: AgentRequestEndpoint): string {
  const { authorizationIncarnation: _incarnation, ...identity } = stableAgentEndpointIdentity(value);
  return JSON.stringify(identity);
}

export function sourceScopedAgentDeliveryId(source: AgentRequestEndpoint, callerDeliveryId: string, legacyAlias = false): string {
  return `agent-${createHash("sha256").update(JSON.stringify([source.managerInstanceId, source.kind, source.instanceId,
    source.nodeId, source.kind === "instance" && !legacyAlias ? undefined : source.agentId, source.provider, source.sessionId, callerDeliveryId])).digest("hex")}`;
}

export function sameAgentParty(left: AgentRequestParty, right: AgentRequestParty): boolean {
  if (left.endpoint || right.endpoint) return sameAgentEndpoint(left.endpoint, right.endpoint)
    && left.threadId === right.threadId && left.agentAdapter === right.agentAdapter
    && left.agentType === right.agentType;
  return left.threadId === right.threadId
    && (!left.agentAdapter || !right.agentAdapter || left.agentAdapter === right.agentAdapter)
    && (!left.workspace || !right.workspace || sameCodexWorkspace(left.workspace, right.workspace));
}
