import type { PersonaAutomationRuleDefinition } from "../types";

// Shared by the rule list and editor so every category has the same meaning.
export const automationEndpoints = [
  { value: "napcat", title: "QQ (NapCat / OneBot)", icon: "mdi-qqchat", routeKinds: ["direct_at", "direct_reply", "indirect_reply", "group_message", "private"] },
  { value: "weixin", title: "个人微信 / Weixin", icon: "mdi-wechat", routeKinds: ["weixin_message"] },
  { value: "wecom", title: "企业微信 / WeCom", icon: "mdi-account-group", routeKinds: ["wecom_message"] },
  { value: "feishu", title: "飞书 / Feishu", icon: "mdi-message-text-outline", routeKinds: ["feishu_message"] },
  { value: "xiaomiHome", title: "米家 / Xiaomi Home", icon: "mdi-home-automation", routeKinds: ["xiaomi_home_event"] },
  { value: "speech", title: "语音服务", icon: "mdi-microphone", routeKinds: ["voice_transcript"] },
  { value: "rolePanel", title: "角色面板 / 桌面入口", icon: "mdi-desktop-classic", routeKinds: ["role_panel_message", "manual_trigger"] },
  { value: "wearable", title: "智能手表/手环", icon: "mdi-watch", routeKinds: ["wearable_health_alert"] },
  { value: "rabilink", title: "RabiLink", icon: "mdi-link-variant", routeKinds: ["rabilink"] },
  { value: "schedule", title: "定时任务", icon: "mdi-calendar-clock-outline", routeKinds: ["heartbeat"] },
  { value: "webhook", title: "通用 Webhook / 其他", icon: "mdi-webhook", routeKinds: [] as string[] }
];

export function automationEndpoint(rule: PersonaAutomationRuleDefinition): string {
  if (rule.trigger.type === "schedule") return "schedule";
  const kinds = rule.trigger.routeKinds ?? [];
  const endpointType = "endpointType" in rule.trigger ? rule.trigger.endpointType : undefined;
  // Persisted rules keep their filters; only the retired display category is mapped.
  const currentEndpointType = endpointType === "fennenote" ? "speech" : endpointType;
  const explicit = automationEndpoints.find(option => option.value === currentEndpointType);
  // Empty kinds match all messages, including legacy rules without an endpoint.
  if (explicit && explicit.value !== "schedule"
    && (explicit.routeKinds.length === 0 || kinds.some(kind => explicit.routeKinds.includes(kind)))) return explicit.value;
  return automationEndpoints.find(option => option.value !== "schedule"
    && option.routeKinds.some(kind => kinds.includes(kind)))?.value ?? "webhook";
}
