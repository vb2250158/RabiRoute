import type { GatewayDefinition } from "./gatewayConfigModel.js";

// Only role-owned fields cross the independent role editor boundary.
export const ROLE_CONFIGURATION_KEYS = [
  "automationScheduleSchemaVersion", "automationRules", "notificationRules", "recentMessageLimit", "recentMessageLimits",
  "speechTriggerKeywords", "languageStyle", "codexHooks", "automationDeliveryTemplates"
] as const;
export type CustomAutomationDeliveryTemplate = {
  id: string;
  title: string;
  triggerType: "message" | "schedule";
  message: string;
  template: string;
};
export type RoleConfigurationRoute = {
  id: string;
  name: string;
  primaryAgent?: {
    type: string;
    label: string;
    sessionName?: string;
    hasSessionId: boolean;
  };
};
type RoleTemplateConfiguration = { automationDeliveryTemplates?: CustomAutomationDeliveryTemplate[] };
export type RoleConfiguration = Pick<GatewayDefinition, Exclude<typeof ROLE_CONFIGURATION_KEYS[number], "automationDeliveryTemplates">>
  & RoleTemplateConfiguration;
export function roleConfigurationOf(value: Partial<GatewayDefinition> & RoleTemplateConfiguration): RoleConfiguration {
  return Object.fromEntries(ROLE_CONFIGURATION_KEYS.filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])) as RoleConfiguration;
}
