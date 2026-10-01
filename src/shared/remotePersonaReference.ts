import { sanitizeRoleId } from "./routeIdentity.js";

/** Persona-owned projections must never become an adapter's durable configuration. */
export function removePersonaOwnedGatewayConfig<T extends object>(value: T): T {
  const result = { ...value };
  for (const key of [
    "automationRules", "notificationRules", "recentMessageLimit", "recentMessageLimits",
    "languageStyle", "codexHooks", "speechTriggerKeywords", "roleNotificationRules", "roleRouteNames"
  ] as const) {
    delete (result as Record<string, unknown>)[key];
  }
  return result;
}

/** A stable PC device ID is a reference key, never a display name or URL. */
export function normalizeAgentRoleDeviceId(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Remote persona device ID must be a string.");
  const deviceId = value.trim();
  if (!deviceId) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(deviceId)) {
    throw new Error("Invalid remote persona device ID.");
  }
  return deviceId;
}

export function normalizeRemotePersonaReference(input: {
  agentRoleDeviceId?: unknown;
  agentRoleId?: unknown;
}): { agentRoleDeviceId: string | undefined; agentRoleId: string } {
  const agentRoleDeviceId = normalizeAgentRoleDeviceId(input.agentRoleDeviceId);
  const agentRoleId = sanitizeRoleId(input.agentRoleId);
  if (agentRoleDeviceId && (!agentRoleId || agentRoleId !== input.agentRoleId)) {
    throw new Error("Remote persona reference requires a valid role ID.");
  }
  return { agentRoleDeviceId, agentRoleId };
}
