import type { PlanBindingSourceInstance } from "./planBindingOwner.js";

export const AGENT_HOOK_EVENTS = [
  { value: "task_completed", title: "任务完成", hookEvent: "Stop" },
  { value: "task_progress", title: "任务过程文本", hookEvent: "AssistantProgress" }
] as const;

export function agentHookEventsFor(agentType: string) {
  return AGENT_HOOK_EVENTS.filter(event => event.value === "task_completed" || agentType === "codex" || agentType === "dsh");
}
export const AGENT_HOOK_CONDITIONS = [
  { value: "project", title: "限定项目", description: "本轮工作目录必须与所选项目一致。本机 Codex 会同时核对会话所属项目。Git 项目的不同工作树可匹配同一项目，但项目内不同子目录不会自动视为相同。请填写绝对目录，也可以读取当前 Agent 端的项目候选。" },
  { value: "bound_plan", title: "必须绑定计划", description: "只有当前任务绑定了当前角色的计划时才投递。按任务 ID 核对绑定，不按任务名称猜测；未绑定计划的任务会跳过。此条件无需额外参数。" },
  { value: "include_sessions", title: "限定聊天会话", description: "只投递所选聊天会话的任务结果。可以多选，命中其中任意一个即可满足此条件；实际按会话 ID 匹配，改名不影响匹配。至少选择一个会话。" },
  { value: "exclude_sessions", title: "排除聊天会话", description: "所选聊天会话的任务结果不通过本规则投递，其他会话仍需满足本规则的其余条件。可以多选，实际按会话 ID 匹配；同一会话同时被限定和排除时，以排除为准。至少选择一个会话。" },
  { value: "exclude_heartbeat", title: "排除心跳类型的任务", description: "跳过本轮回复为完整心跳控制消息的任务结果，包括 DONT_NOTIFY 和 NOTIFY，避免通过本规则发群或播报。同一任务的普通回复不受影响；正文中引用的心跳示例不会被误判。此条件无需额外参数，只作用于当前投递规则。" }
] as const;
export const originalChatChannel = "original_chat";
export const AGENT_HOOK_DESTINATIONS = [
  { value: originalChatChannel, title: "回原聊天" },
  { value: "napcat", title: "NapCat（QQ）" },
  { value: "qqbot", title: "QQ 官方机器人" },
  { value: "weixin", title: "微信机器人" },
  { value: "wecom", title: "企业微信" },
  { value: "feishu", title: "飞书" },
  { value: "speech", title: "TTS 播报" }
] as const;

export const completionConversationFields: Readonly<Record<string, { field: string; label: string }>> = {
  qqbot: { field: "sourceMessageId", label: "原 QQ 消息 ID" },
  weixin: { field: "sessionId", label: "微信会话 ID" },
  wecom: { field: "chatId", label: "企业微信会话 ID" },
  feishu: { field: "chatId", label: "飞书会话 ID" }
};

export type AgentHookSession = { id: string; name: string };
export type AgentHookDevice = PlanBindingSourceInstance;
export type AgentHookDeviceSelection = AgentHookDevice | "local";

export function agentHookDeviceMatches(device: AgentHookDeviceSelection | undefined, source: PlanBindingSourceInstance | undefined): boolean {
  if (device === undefined) return true;
  if (device === "local") return !source;
  if (!source) return false;
  return device.instanceId === source.instanceId && (device.ownerDeviceId || "") === (source.ownerDeviceId || "")
    && (!device.agentId || device.agentId === source.agentId);
}
export type AgentHookCondition = { type: string; path?: string; sessions?: AgentHookSession[] };
export type AgentHookDestination = { channel: string; gatewayId: string; params: Record<string, string> };

export function normalizePlanMessageChannels(value: unknown): AgentHookDestination[] {
  if (!Array.isArray(value)) return [];
  return normalizeAgentCompletionDeliveries(value.map((destination, index) => ({
    id: `plan-channel-${index}`, enabled: true, event: "task_completed", conditions: [], destination
  }))).map(rule => rule.destination);
}

export function validatePlanMessageChannels(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new Error("Plan messageChannels must be a list.");
  for (const destination of normalizePlanMessageChannels(value)) {
    const errors = agentHookRuleErrors({ id: "plan-channel", enabled: true, event: "task_completed", conditions: [], destination });
    if (errors.length) throw new Error(`Plan messageChannels: ${errors.join(" ")}`);
  }
}
export type AgentCompletionDeliveryRule = {
  id: string;
  name?: string;
  enabled: boolean;
  event: string;
  events?: string[];
  sourceDevice?: AgentHookDeviceSelection;
  conditions: AgentHookCondition[];
  destination: AgentHookDestination;
};

export function agentHookRuleEvents(rule: Pick<AgentCompletionDeliveryRule, "event" | "events">): readonly string[] {
  return rule.events ?? (rule.event ? [rule.event] : []);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Old project/group rules migrate at the configuration boundary; only the new shape is written. */
export function normalizeAgentCompletionDeliveries(value: unknown): AgentCompletionDeliveryRule[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap(entry => {
    const raw = object(entry); const id = text(raw.id);
    if (!id || ids.has(id)) return [];
    ids.add(id);
    const legacy = !raw.destination && ("projectPath" in raw || "groupId" in raw);
    const destination = object(raw.destination);
    const params = object(destination.params);
    const channel = text(destination.channel);
    const fileConversions = Object.fromEntries(["markdownFilesAsImages", "imageFilesAsImages", "htmlFilesAsLinks"].filter(key => params[key] !== undefined)
      .map(key => [key, params[key] === "false" || params[key] === false ? "false" : "true"]));
    const normalizedParams: Record<string, string> = channel === "napcat"
      ? { target: text(params.target), targetId: text(params.targetId), instanceId: text(params.instanceId), ...(params.renderTables !== undefined ? { renderTables: params.renderTables === "false" || params.renderTables === false ? "false" : "true" } : {}), ...(params.renderDiagrams !== undefined ? { renderDiagrams: params.renderDiagrams === "false" || params.renderDiagrams === false ? "false" : "true" } : {}), ...(params.includeFiles !== undefined ? { includeFiles: params.includeFiles === "false" || params.includeFiles === false ? "false" : "true" } : {}) }
      : channel === "speech" ? (text(params.sessionId) ? { sessionId: text(params.sessionId) } : {})
      : Object.fromEntries(Object.entries(params).map(([key, value]) => [key, text(value)]));
    if (channel === "napcat") Object.assign(normalizedParams, fileConversions);
    if (params.content === "excerpt") normalizedParams.content = "excerpt";
    for (const key of ["includeAgentType", "includeTaskName"]) {
      if (params[key] !== undefined) normalizedParams[key] = params[key] === false || params[key] === "false" ? "false" : "true";
    }
    const conditions: AgentHookCondition[] = legacy
      ? [{ type: "project", path: text(raw.projectPath) }, ...(raw.requireBoundPlan === true ? [{ type: "bound_plan" }] : [])]
      : Array.isArray(raw.conditions) ? raw.conditions.map(item => {
        const condition = object(item);
        const sessions = Array.isArray(condition.sessions) ? [...new Map(condition.sessions.map(entry => {
          const session = object(entry);
          return [text(session.id), { id: text(session.id), name: text(session.name) }] as const;
        }).filter(([id]) => id)).values()] : [];
        return { type: text(condition.type), ...(condition.path !== undefined ? { path: text(condition.path) } : {}),
          ...(condition.sessions !== undefined ? { sessions } : {}) };
      }) : [{ type: "invalid" }];
    const name = text(raw.name);
    const events = Array.isArray(raw.events) ? [...new Set(raw.events.map(text).filter(Boolean))] : undefined;
    const event = events ? events[0] ?? "" : legacy ? "task_completed" : text(raw.event);
    const sourceDevice = normalizeAgentHookDevice(raw.sourceDevice);
    return [{ id, ...(name ? { name } : {}), enabled: raw.enabled === true, event, ...(events ? { events } : {}),
      ...(sourceDevice ? { sourceDevice } : {}), conditions,
      destination: legacy
        ? { channel: "napcat", gatewayId: text(raw.gatewayId), params: { target: "group", targetId: text(raw.groupId), instanceId: text(raw.instanceId) } }
        : { channel, gatewayId: text(destination.gatewayId), params: normalizedParams } }];
  });
}

export function normalizeAgentHookDevice(value: unknown): AgentHookDeviceSelection | undefined {
  if (value === undefined || value === "local") return value;
  const device = object(value);
  return { instanceId: text(device.instanceId), ...(device.ownerDeviceId === undefined ? {} : { ownerDeviceId: text(device.ownerDeviceId) }),
    ...(device.agentId === undefined ? {} : { agentId: text(device.agentId) }) };
}

export function agentHookConditionErrors(condition: AgentHookCondition): string[] {
  const errors: string[] = [];
  if (!AGENT_HOOK_CONDITIONS.some(item => item.value === condition.type)) errors.push("请选择支持的条件类型。");
  if (["include_sessions", "exclude_sessions"].includes(condition.type)
    && (!condition.sessions?.length || condition.sessions.some(session => !session.id?.trim()))) errors.push("会话条件至少需要选择一个聊天会话。");
  if (condition.type === "project" && !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(condition.path || "")) errors.push("项目条件需要填写绝对目录。");
  return errors;
}

export function agentHookRuleErrors(rule: AgentCompletionDeliveryRule, agentType?: string): string[] {
  const errors: string[] = [];
  const device = rule.sourceDevice === "local" ? undefined : rule.sourceDevice;
  const validDeviceId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
  if (device && (!validDeviceId.test(device.instanceId) || [device.ownerDeviceId, device.agentId].some(id => id !== undefined && !validDeviceId.test(id)))) {
    errors.push("请选择有效的触发设备。");
  }
  const events = agentHookRuleEvents(rule);
  if (!events.length || events.some(value => !AGENT_HOOK_EVENTS.some(event => event.value === value))) {
    errors.push("请选择支持的事件。");
  } else if (agentType && events.some(value => !agentHookEventsFor(agentType).some(event => event.value === value)
    || device && agentType === "codex" && value === "task_progress")) {
    errors.push("所选 Agent 不支持此规则中的触发事件。");
  }
  const seen = new Set<string>();
  for (const condition of rule.conditions) {
    errors.push(...agentHookConditionErrors(condition));
    if (seen.has(condition.type)) errors.push("同一种条件只能添加一次。");
    seen.add(condition.type);
  }
  const destination = rule.destination;
  if (destination.channel === originalChatChannel) {
    if (events.some(event => event !== "task_completed")) errors.push("回原聊天仅支持任务完成。");
    return errors;
  }
  if (!destination.gatewayId) errors.push("请选择消息路线。");
  if (!AGENT_HOOK_DESTINATIONS.some(item => item.value === destination.channel)) errors.push("请选择支持的消息端。");
  const conversation = completionConversationFields[destination.channel];
  if (conversation && !destination.params[conversation.field]?.trim()) errors.push("请填写" + conversation.label + "。");
  if (destination.channel === "qqbot" && destination.params.sourceMessageId && !/^qqbot-\S+$/.test(destination.params.sourceMessageId)) {
    errors.push("请填写聊天记录里的原 QQ 消息 ID。");
  }
  if (destination.channel === "napcat") {
    if (!destination.params.instanceId) errors.push("请选择 QQ 账号。");
    if (!["group", "private"].includes(destination.params.target)) errors.push("请选择群或个人 QQ。");
    if (!/^\d+$/.test(destination.params.targetId || "")) errors.push("请填写有效的群号或 QQ 号。");
  }
  return errors;
}
