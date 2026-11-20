import { agentAdapterManifest, agentAdapterSupportsLifecycleHooks, agentAdapterTypes, type AgentAdapterType } from "./agentAdapterCapabilities.js";
import { agentHookSettingsFor, type CodexHookSettings, type GatewayDefinition } from "./gatewayConfigModel.js";
import type { AgentCompletionDeliveryRule } from "./agentHookAutomation.js";
import { normalizePlanFollowup, type PlanFollowupRule } from "./planFollowup.js";

/** Configuration is the source of availability; discovery does not add an Agent end. */
export function configuredPersonaHookAgents(gateways: readonly GatewayDefinition[], roleId: string): AgentAdapterType[] {
  if (!roleId) return [];
  return [...new Set(gateways.filter(route => route.enabled !== false && !route.agentRoleDeviceId && route.agentRoleId === roleId)
    .flatMap(route => route.agentAdapters ?? ["codex" as const]))].filter(agentAdapterSupportsLifecycleHooks);
}

export function personaHookAgentOptions(gateways: readonly GatewayDefinition[], roleId: string) {
  const configured = new Set(configuredPersonaHookAgents(gateways, roleId));
  return agentAdapterTypes.filter(agentAdapterSupportsLifecycleHooks)
    .map(value => ({ value, title: agentAdapterManifest(value).label, configured: configured.has(value) }))
    .sort((left, right) => Number(right.configured) - Number(left.configured));
}


export type PersonaAgentRule = { kind: "followup"; value: PlanFollowupRule } | { kind: "delivery"; value: AgentCompletionDeliveryRule };

export function personaAgentHookDraft(settings: CodexHookSettings | undefined, agent: AgentAdapterType): Omit<CodexHookSettings, "byAgent"> {
  if (settings?.byAgent?.[agent]) return settings.byAgent[agent];
  if (!settings) return agentHookSettingsFor(undefined);
  const { byAgent: _scopes, ...defaults } = settings;
  return defaults;
}

export function editPersonaAgentRule(settings: CodexHookSettings | undefined, cue: {
  rule: PersonaAgentRule;
  targetAgent: AgentAdapterType;
  sourceAgent?: AgentAdapterType;
  remove?: boolean;
  enableFollowup?: boolean;
  createId: () => string;
}): CodexHookSettings {
  const { rule, sourceAgent, targetAgent } = cue;
  const target = personaAgentHookDraft(settings, targetAgent);
  const source = sourceAgent ? personaAgentHookDraft(settings, sourceAgent) : undefined;
  const moving = Boolean(sourceAgent && sourceAgent !== targetAgent);
  const byAgent = { ...settings?.byAgent };

  function writeList<T extends { id: string }>(items: T[], value: T, originalItems: T[]): T[] {
    if (cue.remove) return items.filter(item => item.id !== value.id);
    const existing = items.find(item => item.id === value.id);
    if (!existing) return [...items, value];
    const original = originalItems.find(item => item.id === value.id);
    if (moving && JSON.stringify(existing) !== JSON.stringify(original)) {
      return [...items, { ...value, id: cue.createId() }];
    }
    return items.map(item => item.id === value.id ? value : item);
  }

  if (rule.kind === "delivery") {
    byAgent[targetAgent] = { ...target, completionDeliveries: writeList(target.completionDeliveries ?? [], rule.value, source?.completionDeliveries ?? []) };
    if (moving && sourceAgent && source) {
      byAgent[sourceAgent] = { ...source, completionDeliveries: (source.completionDeliveries ?? []).filter(item => item.id !== rule.value.id) };
    }
  } else {
    const destination = target.planFollowup ?? normalizePlanFollowup(undefined);
    const original = source?.planFollowup ?? normalizePlanFollowup(undefined);
    byAgent[targetAgent] = { ...target, planFollowup: {
      ...destination,
      enabled: destination.enabled || cue.enableFollowup === true,
      rules: writeList(destination.rules, rule.value, original.rules)
    } };
    if (moving && sourceAgent && source) {
      byAgent[sourceAgent] = { ...source, planFollowup: { ...original, rules: original.rules.filter(item => item.id !== rule.value.id) } };
    }
  }
  return { ...settings, ...agentHookSettingsFor({ ...settings, byAgent: undefined }), byAgent };
}
