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

/** Preserve legacy local receipt keys while fencing each trusted remote session. */
export function planBindingSourceKey(source: PlanBindingSource): string {
  if (!source.sourceInstance) return source.sessionId;
  return JSON.stringify(["remote", source.sourceInstance.ownerDeviceId || "",
    source.sourceInstance.instanceId, source.agentType || "codex", source.sessionId,
    ...(source.sourceInstance.agentId ? [source.sourceInstance.agentId] : [])]);
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
