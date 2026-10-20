import type { GatewayDefinition } from "./gatewayConfigModel.js";

// Only role-owned fields cross the independent role editor boundary.
export const ROLE_CONFIGURATION_KEYS = [
  "automationRules", "notificationRules", "recentMessageLimit", "recentMessageLimits",
  "speechTriggerKeywords", "languageStyle", "codexHooks"
] as const;
export type RoleConfiguration = Pick<GatewayDefinition, typeof ROLE_CONFIGURATION_KEYS[number]>;
export function roleConfigurationOf(value: Partial<GatewayDefinition>): RoleConfiguration {
  return Object.fromEntries(ROLE_CONFIGURATION_KEYS.filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])) as RoleConfiguration;
}
