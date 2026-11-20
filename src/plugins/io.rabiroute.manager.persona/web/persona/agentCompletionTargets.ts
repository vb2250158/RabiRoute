import { AGENT_HOOK_DESTINATIONS, agentHookRuleErrors, completionConversationFields, type AgentHookDestination } from "@shared/agentHookAutomation";
import { messageAdapterOutputEnabled, type CodexHookSettings, type GatewayDefinition, type PersonaAutomationRuleDefinition } from "@shared/gatewayConfigModel";
import { automationEndpoint } from "./automationEndpoints";
import { automationQqTarget, type AutomationQqDirectory } from "./automationRuleConversation";

export function completionTargetKey(destination: AgentHookDestination): string {
  const { gatewayId, channel, params } = destination;
  return JSON.stringify([gatewayId, channel, params.instanceId ?? "", params.target ?? "",
    params.targetId ?? params[completionConversationFields[channel]?.field ?? "sessionId"] ?? ""]);
}

export function completionTargetLabel(destination: AgentHookDestination, routes: readonly GatewayDefinition[],
  directories: readonly AutomationQqDirectory[]): string {
  const { gatewayId, channel, params } = destination;
  const platform = AGENT_HOOK_DESTINATIONS.find(item => item.value === channel)?.title ?? channel;
  const route = routes.find(route => route.id === gatewayId);
  const contact = channel === "napcat" ? directories.find(entry => entry.routeId === gatewayId && entry.instanceId === params.instanceId)
    ?.entries.find(entry => entry.kind === params.target && entry.target === params.targetId) : undefined;
  const target = contact ? `${contact.name} (${contact.target})`
    : params.targetId || params[completionConversationFields[channel]?.field ?? "sessionId"];
  const account = channel === "napcat" && route?.napcatInstances?.length && route.napcatInstances.length > 1
    ? route.napcatInstances.find(instance => instance.id === params.instanceId)?.name || params.instanceId : "";
  return [target, platform, account, route?.name || route?.configName || gatewayId].filter(Boolean).join(" · ");
}

export function completionTargetChoices(gateway: GatewayDefinition, gateways: readonly GatewayDefinition[],
  messageRules: readonly PersonaAutomationRuleDefinition[], directories: readonly AutomationQqDirectory[], hooks?: CodexHookSettings) {
  const routes = gateways.filter(route => route.enabled !== false && route.agentRoleId === gateway.agentRoleId
    && (route.agentRoleDeviceId || "") === (gateway.agentRoleDeviceId || ""));
  const targets = new Map<string, AgentHookDestination>();
  const outputEnabled = (route: GatewayDefinition, channel: string) =>
    (route.messageAdapters ?? [route.messageAdapterType ?? "napcat"]).includes(channel)
    && !route.messageAdaptersDisabled?.includes(channel) && messageAdapterOutputEnabled(route, channel);
  const add = (destination: AgentHookDestination) => {
    const route = routes.find(item => item.id === destination.gatewayId);
    if (!route || !outputEnabled(route, destination.channel)) return;
    if (destination.channel === "napcat" && !route.napcatInstances?.some(instance =>
      instance.id === destination.params.instanceId && instance.enabled !== false
      && !route.ignoredNapcatInstanceIds?.includes(instance.id))) return;
    const candidate = { id: "target", enabled: false, event: "task_completed", conditions: [], destination };
    if (agentHookRuleErrors(candidate).length) return;
    const { channel, gatewayId, params } = destination;
    const keys = channel === "napcat" ? ["instanceId", "target", "targetId"] : [completionConversationFields[channel]?.field ?? "sessionId"];
    const addressing = Object.fromEntries(keys.filter(key => params[key]).map(key => [key, params[key]]));
    targets.set(completionTargetKey(destination), { channel, gatewayId, params: addressing });
  };
  const boundRules = messageRules.filter(rule => rule.trigger.type === "message" && rule.enabled !== false);
  for (const route of routes) {
    if (outputEnabled(route, "speech")) add({ channel: "speech", gatewayId: route.id, params: {} });
    const accounts = (route.napcatInstances ?? []).filter(instance => instance.enabled !== false
      && !route.ignoredNapcatInstanceIds?.includes(instance.id));
    const addQq = (target: "group" | "private", targetId: string) => {
      if (accounts.length === 1) add({ channel: "napcat", gatewayId: route.id, params: { instanceId: accounts[0].id, target, targetId } });
    };
    if (route.targetGroupId) addQq("group", route.targetGroupId);
    for (const rule of boundRules) {
      if (rule.trigger.type !== "message" || (rule.sourceRouteIds?.length && !rule.sourceRouteIds.includes(route.id))) continue;
      const channel = automationEndpoint(rule);
      if (channel === "napcat") {
        const target = automationQqTarget(rule);
        if (target) addQq(target.kind, target.id);
      }
      // These ingress adapters use the same chat ID for group filtering and sending.
      if ((channel === "wecom" || channel === "feishu") && rule.trigger.targetGroupId?.trim()) {
        add({ channel, gatewayId: route.id, params: { chatId: rule.trigger.targetGroupId.trim() } });
      }
    }
  }
  for (const scope of [hooks, ...Object.values(hooks?.byAgent ?? {})]) {
    for (const rule of scope?.completionDeliveries ?? []) add(rule.destination);
  }
  return [...targets].map(([value, destination]) => ({ value, destination, title: completionTargetLabel(destination, routes, directories) }))
    .sort((left, right) => left.title.localeCompare(right.title));
}
