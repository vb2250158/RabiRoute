import type { AgentInstanceBinding } from "./agentInstance.js";

/** Coordinates attributed by authenticated ingress, never by Hook request JSON. */
export type PlanBindingSourceInstance = {
  instanceId: string;
  ownerDeviceId?: string;
  /** Omitted when ingress knows the provider/session but not a configured Agent ID. */
  agentId?: string;
};

export type PlanBindingSource = {
  sessionId: string;
  agentType?: string;
  sourceInstance?: PlanBindingSourceInstance;
};

type BindingOwner = {
  sessionId: string;
  agentType: string;
  instanceBinding?: AgentInstanceBinding;
};

/** Local bindings remain local; an identical remote session ID is a different owner. */
export function planBindingMatchesSource(binding: BindingOwner | undefined, source: PlanBindingSource): boolean {
  if (!binding || binding.sessionId !== source.sessionId
    || binding.agentType !== (source.agentType || "codex")) return false;
  const expected = binding.instanceBinding;
  const actual = source.sourceInstance;
  if (!expected || !actual) return !expected && !actual;
  return expected.instanceId === actual.instanceId
    && (expected.ownerDeviceId || "") === (actual.ownerDeviceId || "")
    && (!actual.agentId || expected.agentId === actual.agentId);
}

/** Stable receipt/hash identity: existing local IDs remain strings, remote owners are typed tuples. */
export function planBindingDeliveryIdentity(source: PlanBindingSource): string | readonly string[] {
  if (!source.sourceInstance) return source.sessionId;
  return ["remote", source.sourceInstance.ownerDeviceId || "",
    source.sourceInstance.instanceId, source.agentType || "codex", source.sessionId,
    ...(source.sourceInstance.agentId ? [source.sourceInstance.agentId] : [])];
}

/** Storage/pending identity. Escape bracket-prefixed locals so they cannot equal a remote JSON tuple. */
export function planBindingSourceKey(source: PlanBindingSource): string {
  const identity = planBindingDeliveryIdentity(source);
  if (typeof identity !== "string") return JSON.stringify(identity);
  return identity.startsWith("[") ? JSON.stringify(["local", identity]) : identity;
}

/** Comparison/grouping identity only; transport ownership remains at the endpoint. */
export function planBindingTargetKey(binding: {
  agentType?: string;
  sessionId?: string;
  instanceBinding?: AgentInstanceBinding;
  baseUrl?: string;
  workspace?: string;
}): string {
  return JSON.stringify([binding.agentType || "codex", binding.sessionId || "",
    binding.instanceBinding?.ownerDeviceId || "", binding.instanceBinding?.instanceId || "",
    binding.instanceBinding?.agentId || "", binding.agentType === "dsh" && !binding.instanceBinding ? binding.baseUrl || "" : ""]);
}
