import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import type { AgentRequestParty } from "./store.js";

/** Full opaque owner identity; names and workspaces are not owner substitutes. */
export type AgentRequestEndpoint = {
  kind: "local" | "instance" | "device";
  managerInstanceId: string;
  instanceId?: string;
  nodeId?: string;
  agentId: string;
  provider: string;
  sessionId: string;
  authorizationIncarnation: string;
};

export function normalizeAgentRequestEndpoint(value: AgentRequestEndpoint): AgentRequestEndpoint {
  if (!value || !["local", "instance", "device"].includes(value.kind)) throw new Error("Invalid Agent endpoint kind.");
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
    .every(key => left[key as keyof AgentRequestEndpoint] === right[key as keyof AgentRequestEndpoint]);
}

export function sameAgentParty(left: AgentRequestParty, right: AgentRequestParty): boolean {
  if (left.endpoint || right.endpoint) return sameAgentEndpoint(left.endpoint, right.endpoint)
    && left.threadId === right.threadId && left.agentAdapter === right.agentAdapter
    && left.agentType === right.agentType;
  return left.threadId === right.threadId
    && (!left.agentAdapter || !right.agentAdapter || left.agentAdapter === right.agentAdapter)
    && (!left.workspace || !right.workspace || sameCodexWorkspace(left.workspace, right.workspace));
}
