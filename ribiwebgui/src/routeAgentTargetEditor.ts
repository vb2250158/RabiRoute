import type { AgentAdapterType, GatewayDefinition } from "./types";
import { addRemoteAgentTarget, localAgentTargetKey, normalizeRouteAgentTargets, removeRouteAgentTarget } from "@shared/routeAgentTargets";

/** Route drafts use the same target identity and migration rules as Manager. */
export function addRouteAgent(gateway: GatewayDefinition, provider: AgentAdapterType, instanceId?: string, agentId?: string): void {
  const next = instanceId && agentId
    ? addRemoteAgentTarget(gateway, { provider, instanceId, agentId })
    : normalizeRouteAgentTargets({ ...gateway, agentAdapters: [...new Set([...(gateway.agentAdapters || []), provider])] });
  applyRouteAgentDraft(gateway, next);
}

export function removeRouteAgent(gateway: GatewayDefinition, targetId: string): void {
  applyRouteAgentDraft(gateway, removeRouteAgentTarget(gateway, targetId));
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
