import type { NotificationRuleDefinition } from "./gatewayConfigModel.js";

export const builtinRolePanelRuleId = "role-panel-message";
export const builtinRolePanelRouteKind = "role_panel_message";
export const builtinRolePanelRuleName = "角色面板消息";

export type BuiltinPersonaRulePolicy = {
  readonly id: string;
  readonly name: string;
  readonly routeKind: string;
};

export const rolePanelPersonaRulePolicy: BuiltinPersonaRulePolicy = {
  id: builtinRolePanelRuleId,
  name: builtinRolePanelRuleName,
  routeKind: builtinRolePanelRouteKind
};

function normalizeTemplateText(value: unknown): string {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

export function createBuiltinRolePanelRule(): NotificationRuleDefinition {
  return {
    id: rolePanelPersonaRulePolicy.id,
    name: rolePanelPersonaRulePolicy.name,
    enabled: true,
    routeKinds: [rolePanelPersonaRulePolicy.routeKind],
    targetGroupId: "",
    regex: "",
    template: ""
  };
}

export function isBuiltinRolePanelRule(rule: Pick<NotificationRuleDefinition, "id" | "routeKinds"> | null | undefined): boolean {
  return Boolean(rule?.id === rolePanelPersonaRulePolicy.id
    || (Array.isArray(rule?.routeKinds) && rule.routeKinds.includes(rolePanelPersonaRulePolicy.routeKind)));
}

export function canonicalizeBuiltinRolePanelRule(rule: NotificationRuleDefinition): NotificationRuleDefinition {
  return {
    ...rule,
    id: rolePanelPersonaRulePolicy.id,
    name: rule.name?.trim() || rolePanelPersonaRulePolicy.name,
    enabled: true,
    routeKinds: [rolePanelPersonaRulePolicy.routeKind],
    targetGroupId: "",
    regex: "",
    schedules: undefined,
    template: normalizeTemplateText(rule.template)
  };
}

export function ensureBuiltinPersonaRules(rules: NotificationRuleDefinition[] | undefined): NotificationRuleDefinition[] {
  const next = Array.isArray(rules) ? [...rules] : [];
  const rolePanelRuleIndex = next.findIndex(isBuiltinRolePanelRule);
  if (rolePanelRuleIndex < 0) {
    return [...next, createBuiltinRolePanelRule()];
  }

  const [rolePanelRule] = next.splice(rolePanelRuleIndex, 1);
  return [...next, canonicalizeBuiltinRolePanelRule(rolePanelRule)];
}
