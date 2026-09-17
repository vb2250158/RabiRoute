import { isAgentAdapterType, type AgentAdapterType } from "./agentAdapterCapabilities.js";
import { normalizeAgentInstanceBinding, normalizeAgentInstanceBindings, type AgentInstanceBinding } from "./agentInstance.js";

export type RemoteAgentTarget = AgentInstanceBinding & { id: string; provider: AgentAdapterType };
export type RouteAgentTarget = { id: string; provider: AgentAdapterType; binding?: AgentInstanceBinding };
export type RouteAgentTargetsDefinition = {
  agentAdapters?: AgentAdapterType[];
  remoteAgentTargets?: RemoteAgentTarget[];
  primaryAgentTarget?: string;
  primaryAgentAdapter?: AgentAdapterType;
  /** Input-only migration for pre-instance-target configurations. */
  agentInstanceBindings?: Record<string, AgentInstanceBinding>;
};
export function localAgentTargetKey(provider: AgentAdapterType): string { return `local:${provider}`; }
export function remoteAgentTargetKey(binding: AgentInstanceBinding): string {
  return `remote:${encodeURIComponent(binding.instanceId)}:${encodeURIComponent(binding.agentId)}`;
}

export function normalizeRouteAgentTargets<T extends RouteAgentTargetsDefinition>(definition: T): T & { agentAdapters: AgentAdapterType[]; remoteAgentTargets: RemoteAgentTarget[]; primaryAgentTarget: string } {
  const agentAdapters = [...new Set((definition.agentAdapters ?? ["codex"]).filter(isAgentAdapterType))];
  const legacy = definition.remoteAgentTargets === undefined ? normalizeAgentInstanceBindings(definition.agentInstanceBindings) : undefined;
  if (definition.remoteAgentTargets !== undefined && !Array.isArray(definition.remoteAgentTargets)) throw new Error("Invalid remote Agent targets.");
  const remoteAgentTargets: RemoteAgentTarget[] = [];
  for (const raw of definition.remoteAgentTargets ?? Object.entries(legacy ?? {}).map(([provider, binding]) => ({ ...binding, provider, id: remoteAgentTargetKey(binding) }))) {
    if (!isAgentAdapterType(raw.provider)) throw new Error("Unknown remote Agent provider.");
    const binding = normalizeAgentInstanceBinding(raw);
    if (!binding || raw.id !== remoteAgentTargetKey(binding)) throw new Error("Invalid remote Agent target identity.");
    if (remoteAgentTargets.some(target => target.id === raw.id)) throw new Error("Duplicate remote Agent target identity.");
    remoteAgentTargets.push({ ...binding, id: raw.id, provider: raw.provider });
  }
  const candidates: RouteAgentTarget[] = [...agentAdapters.map(provider => ({ id: localAgentTargetKey(provider), provider })), ...remoteAgentTargets];
  const oldPrimary = definition.primaryAgentAdapter ?? agentAdapters[0];
  const requested = definition.primaryAgentTarget ?? (oldPrimary && legacy?.[oldPrimary] ? remoteAgentTargetKey(legacy[oldPrimary]) : oldPrimary ? localAgentTargetKey(oldPrimary) : undefined);
  const selected = candidates.find(target => target.id === requested) ?? (definition.primaryAgentTarget === undefined ? candidates[0] : undefined);
  const { agentInstanceBindings: _legacy, ...rest } = definition;
  return { ...rest, agentAdapters, remoteAgentTargets, primaryAgentTarget: selected?.id ?? "", primaryAgentAdapter: selected?.provider } as T & { agentAdapters: AgentAdapterType[]; remoteAgentTargets: RemoteAgentTarget[]; primaryAgentTarget: string };
}
export function resolvePrimaryAgentTarget(definition: RouteAgentTargetsDefinition): RouteAgentTarget | undefined {
  const normalized = normalizeRouteAgentTargets(definition);
  const remote = normalized.remoteAgentTargets.find(target => target.id === normalized.primaryAgentTarget);
  if (remote) return { id: remote.id, provider: remote.provider, binding: { instanceId: remote.instanceId, agentId: remote.agentId } };
  return normalized.primaryAgentAdapter ? { id: localAgentTargetKey(normalized.primaryAgentAdapter), provider: normalized.primaryAgentAdapter } : undefined;
}
export function primaryAgentInstanceBindings(definition: RouteAgentTargetsDefinition): Record<string, AgentInstanceBinding> | undefined {
  const target = resolvePrimaryAgentTarget(definition);
  return target?.binding ? { [target.provider]: target.binding } : undefined;
}
export function addRemoteAgentTarget<T extends RouteAgentTargetsDefinition>(definition: T, target: Omit<RemoteAgentTarget, "id">) {
  const normalized = normalizeRouteAgentTargets(definition);
  const id = remoteAgentTargetKey(target);
  if (normalized.remoteAgentTargets.some(item => item.id === id && item.provider !== target.provider)) throw new Error("Remote Agent identity cannot change provider.");
  return normalizeRouteAgentTargets({ ...normalized, remoteAgentTargets: [...normalized.remoteAgentTargets.filter(item => item.id !== id), { ...target, id }] });
}
export function removeRouteAgentTarget<T extends RouteAgentTargetsDefinition>(definition: T, targetId: string) {
  const normalized = normalizeRouteAgentTargets(definition);
  return normalizeRouteAgentTargets({ ...normalized, agentAdapters: normalized.agentAdapters.filter(provider => localAgentTargetKey(provider) !== targetId), remoteAgentTargets: normalized.remoteAgentTargets.filter(target => target.id !== targetId) });
}
