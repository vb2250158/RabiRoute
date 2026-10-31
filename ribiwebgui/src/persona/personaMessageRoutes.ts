import type { GatewayDefinition } from "../types";

export function routesForPersona(routes: readonly GatewayDefinition[], roleId: string, sourceDeviceId = ""): GatewayDefinition[] {
  return roleId ? routes.filter(route => route.agentRoleId === roleId && (route.agentRoleDeviceId || "") === sourceDeviceId) : [];
}

export function personaMessagesLocation(route: GatewayDefinition) {
  return {
    path: `/roles/${encodeURIComponent(route.agentRoleId || "")}/config`,
    query: { tab: "messages", route: route.id, ...(route.agentRoleDeviceId ? { source: route.agentRoleDeviceId } : {}) }
  };
}
