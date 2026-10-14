import { createHash } from "node:crypto";
import { defaultAgentRecipients, type AgentDeliveryTarget } from "../shared/agentDeliveryTarget.js";
import { normalizePersonaAutomationRules, personaAutomationRulesFromNotificationRules, primaryMessageProcessingAgentAdapter,
  type GatewayDefinition, type PersonaAutomationRuleDefinition } from "../shared/gatewayConfigModel.js";

export const AGENT_DELIVERY_CONFIGURATION_VERSION = 1;
// Frozen migration semantics of the retired implicit routing switches.
const groupedKinds = new Set(["private", "group_message", "direct_at", "direct_reply", "indirect_reply", "role_panel_message", "rabilink", "wecom_message", "weixin_message", "feishu_message", "heartbeat"]);
const otherKinds = ["manual_trigger", "plan_feedback", "voice_transcript", "wearable_health_alert", "xiaomi_home_event"];
const recipient = (recipientId: string): AgentDeliveryTarget => ({ kind: "recipient", recipientId });

/** Pure conversion. The repository transaction owns snapshots and persistence. */
export function migrateAgentDeliveryConfiguration(
  persona: Record<string, unknown>, routes: readonly GatewayDefinition[]
): { persona: Record<string, unknown>; routes: GatewayDefinition[]; changed: boolean } {
  if (!routes.length) throw new Error("No Routes reference this persona; migration cannot infer previous delivery behavior.");
  if (persona.agentDeliveryConfigurationVersion === AGENT_DELIVERY_CONFIGURATION_VERSION) {
    return { persona: structuredClone(persona), routes: structuredClone([...routes]), changed: false };
  }
  const originals = Array.isArray(persona.automationRules)
    ? persona.automationRules as PersonaAutomationRuleDefinition[]
    : personaAutomationRulesFromNotificationRules(persona.notificationRules as GatewayDefinition["notificationRules"]);
  if (!Array.isArray(persona.automationRules)) {
    const legacy = persona.notificationRules as GatewayDefinition["notificationRules"];
    for (const rule of originals) if (rule.action.type === "deliver_agent" && !legacy?.find(item => item.id === rule.id)?.agentTarget) {
      delete rule.action.target;
    }
  }
  const rules: PersonaAutomationRuleDefinition[] = [];
  for (const route of routes) {
    const poolAdapter = primaryMessageProcessingAgentAdapter(route);
    const pool = Boolean(poolAdapter && route.messageProcessingAgents?.[poolAdapter]?.enabled === true);
    const scope = routes.length > 1 ? { sourceRouteIds: [route.id] } : {};
    const suffix = routes.length > 1 ? `-${createHash("sha256").update(route.id).digest("hex").slice(0, 10)}` : "";
    for (const original of originals) {
      if (original.sourceRouteIds?.length && !original.sourceRouteIds.includes(route.id)) continue;
      const rule = normalizePersonaAutomationRules([original])[0];
      if (original.action?.type !== "deliver_agent" || original.action.target !== undefined) {
        rules.push({ ...rule, ...scope, id: `${rule.id}${suffix}` });
        continue;
      }
      if (rule.action.type !== "deliver_agent") continue;
      if (rule.trigger.type === "schedule") {
        rules.push({ ...rule, ...scope, id: `${rule.id}${suffix}`, action: { ...rule.action, target: recipient(pool ? "message-processing" : "primary") } });
        continue;
      }
      const kinds = rule.trigger.routeKinds?.length ? rule.trigger.routeKinds : [...groupedKinds, ...otherKinds];
      const poolKinds = pool ? kinds.filter(kind => groupedKinds.has(kind)) : [];
      const primaryKinds = kinds.filter(kind => !poolKinds.includes(kind));
      for (const [selected, targetId] of [[poolKinds, "message-processing"], [primaryKinds, "primary"]] as const) {
        if (!selected.length) continue;
        rules.push({ ...rule, ...scope, id: `${rule.id}${suffix}${poolKinds.length && primaryKinds.length ? `-${targetId}` : ""}`,
          trigger: { ...rule.trigger, routeKinds: [...selected] }, action: { ...rule.action, target: recipient(targetId) } });
      }
    }
    if (!originals.some(rule => (!rule.sourceRouteIds?.length || rule.sourceRouteIds.includes(route.id))
      && rule.trigger.type === "message" && rule.trigger.triggerIds?.includes("memory-consolidation"))) {
      rules.push({ id: `memory-consolidation${suffix}`, name: "记忆整理请求", enabled: true, ...scope,
        trigger: { type: "message", routeKinds: ["manual_trigger"], triggerIds: ["memory-consolidation"] },
        action: { type: "deliver_agent", template: "", target: recipient(route.codexMemoryConsolidationAgentEnabled ? "memory-consolidation" : "primary") } });
    }
  }
  const { notificationRules: _oldRules, ...rest } = persona;
  return { persona: { ...rest, agentDeliveryConfigurationVersion: AGENT_DELIVERY_CONFIGURATION_VERSION, automationRules: rules },
    routes: routes.map(route => ({ ...structuredClone(route), agentRecipients: route.agentRecipients ?? defaultAgentRecipients() })), changed: true };
}
