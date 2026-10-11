import { agentAdapterManifest, agentAdapterSupportsLifecycleHooks, type AgentAdapterType } from "./agentAdapterCapabilities.js";
import type { GatewayDefinition } from "./gatewayConfigModel.js";

/** Configuration is the source of availability; discovery does not add an Agent end. */
export function configuredPersonaHookAgents(gateways: readonly GatewayDefinition[], roleId: string): AgentAdapterType[] {
  if (!roleId) return [];
  return [...new Set(gateways.filter(route => route.enabled !== false && !route.agentRoleDeviceId && route.agentRoleId === roleId)
    .flatMap(route => route.agentAdapters ?? ["codex" as const]))].filter(agentAdapterSupportsLifecycleHooks);
}

export function personaHookAgentOptions(gateways: readonly GatewayDefinition[], roleId: string) {
  return configuredPersonaHookAgents(gateways, roleId).map(value => ({ value, title: agentAdapterManifest(value).label }));
}
