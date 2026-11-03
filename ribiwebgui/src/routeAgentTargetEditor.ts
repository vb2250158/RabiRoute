import type { AgentAdapterType, GatewayDefinition } from "./types";
import { addRemoteAgentTarget, localAgentTargetKey, normalizeRouteAgentTargets, removeRouteAgentTarget, type AgentTargetSession } from "@shared/routeAgentTargets";

/** Route drafts use the same target identity and migration rules as Manager. */
export function addRouteAgent(gateway: GatewayDefinition, provider: AgentAdapterType, instanceId?: string, agentId?: string, ownerDeviceId?: string): void {
  const next = instanceId && agentId
    ? addRemoteAgentTarget(gateway, { provider, instanceId, agentId, ...(ownerDeviceId ? { ownerDeviceId } : {}) })
    : normalizeRouteAgentTargets({ ...gateway, agentAdapters: [...new Set([...(gateway.agentAdapters || []), provider])] });
  applyRouteAgentDraft(gateway, next);
}

export function removeRouteAgent(gateway: GatewayDefinition, targetId: string): void {
  applyRouteAgentDraft(gateway, removeRouteAgentTarget(gateway, targetId));
}

/** Update only this Route's selected remote reference; never mutate a target Manager's Route or provider-wide defaults. */
export function selectPeerRouteSession(gateway: GatewayDefinition, targetId: string, session: AgentTargetSession): void {
  const normalized = normalizeRouteAgentTargets(gateway);
  const target = normalized.remoteAgentTargets.find(item => item.id === targetId && item.ownerDeviceId);
  if (!target) throw new Error("远端主机目标已移除，请刷新后选择。");
  applyRouteAgentDraft(gateway, normalizeRouteAgentTargets({ ...normalized,
    remoteAgentTargets: normalized.remoteAgentTargets.map(item => item.id === targetId ? { ...item, ...session } : item) }));
}

export function selectRouteAgent(gateway: GatewayDefinition, targetId: string): void {
  const current = normalizeRouteAgentTargets(gateway);
  const exists = current.agentAdapters.some(provider => localAgentTargetKey(provider) === targetId)
    || current.remoteAgentTargets.some(target => target.id === targetId);
  if (!exists) return;
  applyRouteAgentDraft(gateway, normalizeRouteAgentTargets({ ...current, primaryAgentTarget: targetId }));
}

export function applyRouteAgentDraft(gateway: GatewayDefinition, normalized = normalizeRouteAgentTargets(gateway)): void {
  Object.assign(gateway, normalized);
  delete gateway.agentInstanceBindings;
}
