import type { AgentAdapterType, GatewayDefinition, MessageAdapterType, NotificationRule, RuntimeStatus } from "../types";

export const routeKindLabels: Record<string, string> = {
  direct_at: "群聊-直接 @",
  direct_reply: "群聊-直接回复",
  indirect_reply: "群聊-间接回复",
  group_message: "群聊-普通消息",
  private: "私聊",
  heartbeat: "定时触发",
  manual_trigger: "手动触发",
  voice_transcript: "语音转写"
};

export const templateVars = [
  { name: "routeKind", description: "当前命中的路由类型，例如 direct_at、private、group_message、heartbeat、manual_trigger、voice_transcript。" },
  { name: "RobotQQId", description: "机器人 QQ 号，来自当前消息事件 self_id。" },
  { name: "SenderQQId", description: "发送者 QQ 号。" },
  { name: "GroupId", description: "群号；私聊时为空。" },
  { name: "ReplyMessageId", description: "被回复消息 ID；非回复消息时为空。" },
  { name: "time", description: "消息时间，已格式化为本地时间。" },
  { name: "now", description: "模板渲染时的当前本地时间，等同 currentTime。" },
  { name: "currentTime", description: "模板渲染时的当前本地时间。" },
  { name: "currentDate", description: "当前日期，格式 YYYY-MM-DD。" },
  { name: "currentClock", description: "当前时分秒，格式 HH:mm:ss。" },
  { name: "currentIsoTime", description: "当前 ISO 时间字符串。" },
  { name: "currentTimestamp", description: "当前 Unix 时间戳，单位秒。" },
  { name: "currentYear", description: "当前年份。" },
  { name: "currentMonth", description: "当前月份，补零为两位。" },
  { name: "currentDay", description: "当前日期中的日，补零为两位。" },
  { name: "currentWeekday", description: "当前星期，例如 星期四。" },
  { name: "currentHour", description: "当前小时，补零为两位。" },
  { name: "currentMinute", description: "当前分钟，补零为两位。" },
  { name: "currentSecond", description: "当前秒数，补零为两位。" },
  { name: "messageTarget", description: "目标会话描述，例如群号或私聊对象。" },
  { name: "groupId", description: "群消息的群号；私聊时不填充。" },
  { name: "userId", description: "发送者 QQ 号。" },
  { name: "sender", description: "发送者显示名，优先使用群名片或昵称。" },
  { name: "message", description: "原始消息文本，包含 CQ 码。" },
  { name: "routeText", description: "用于路由匹配的消息文本，@ 和回复 CQ 码会转成更易匹配的文本。" },
  { name: "repliedRouteText", description: "被回复消息对应的路由匹配文本。" },
  { name: "repliedMessage", description: "被回复消息的原始文本。" },
  { name: "routeProfileId", description: "当前命中的 route profile ID。" },
  { name: "routeProfileName", description: "当前命中的 route profile 名称。" },
  { name: "pipelinePreset", description: "当前 pipeline preset / channel preset ID，例如 qq_chat、voice_chat、webhook_task。" },
  { name: "channelPreset", description: "pipelinePreset 的别名，供使用 channel 命名的模板使用。" },
  { name: "inputAdapter", description: "pipeline 默认输入适配端。" },
  { name: "outputAdapter", description: "pipeline 默认输出适配端，例如 qq、tts、file、codex。" },
  { name: "outputPipeline", description: "输出管道 ID，例如 qq、oumuq、file。" },
  { name: "promptOutputMode", description: "提示词输出模式，例如 qq_text、voice_short、markdown、json。" },
  { name: "ttsProvider", description: "TTS provider，语音模式通常为 oumuq。" },
  { name: "ttsVoice", description: "TTS 声线 / character_id。" },
  { name: "ttsWorkerUrl", description: "TTS worker 地址，只作为路由决策上下文。" },
  { name: "ttsPlay", description: "是否建议 worker 播放，true / false。" },
  { name: "preventFeedbackLoop", description: "是否开启防回流策略，true / false。" },
  { name: "replyToSource", description: "是否默认回到原来消息端，true / false。" },
  { name: "agentRoleId", description: "当前选择的路由人格 ID。" },
  { name: "agentRolePath", description: "当前路由人格文件路径。" },
  { name: "agentRoleDir", description: "当前路由人格配置目录。" },
  { name: "groupLogPath", description: "群聊消息 JSONL 记录路径。" },
  { name: "privateLogPath", description: "私聊消息 JSONL 记录路径。" },
  { name: "heartbeatLogPath", description: "定时触发事件 JSONL 记录路径。" },
  { name: "manualTriggerLogPath", description: "手动触发事件 JSONL 记录路径。" },
  { name: "heartbeatIntervalSeconds", description: "定时触发间隔，单位秒。" },
  { name: "triggerId", description: "手动触发 ID。" },
  { name: "triggerName", description: "手动触发显示名称。" },
  { name: "voiceTranscriptLogPath", description: "语音转写 JSONL 记录路径。" },
  { name: "voiceSource", description: "Webhook 来源。" },
  { name: "voiceDurationSeconds", description: "语音片段时长，单位秒。" },
  { name: "voicePeak", description: "语音片段峰值音量。" }
];

export function normalizeTemplateText(value: unknown): string {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

export function groupTemplate(title: string): string {
  return [
    `QQ 消息更新提醒：${title}。`,
    "时间：{time}",
    "目标：{messageTarget}",
    "群号：{groupId}",
    "发送者：{sender}",
    "消息：{message}",
    "",
    "请在需要时读取 {groupLogPath} 查看上下文。"
  ].join("\n");
}

export function defaultGroupAtTemplate(): string {
  return groupTemplate("群聊里有人 @ 了机器人");
}

export function defaultGroupDirectReplyTemplate(): string {
  return groupTemplate("群聊里有人直接回复机器人");
}

export function defaultGroupIndirectReplyTemplate(): string {
  return [
    "QQ 消息更新提醒：群聊里有人回复了一条提到机器人的消息。",
    "时间：{time}",
    "目标：{messageTarget}",
    "群号：{groupId}",
    "发送者：{sender}",
    "被回复消息：{repliedMessage}",
    "消息：{message}",
    "",
    "请在需要时读取 {groupLogPath} 查看上下文。"
  ].join("\n");
}

export function defaultPrivateTemplate(): string {
  return [
    "QQ 消息更新提醒：收到一条私聊消息。",
    "时间：{time}",
    "目标：{messageTarget}",
    "发送者：{sender}",
    "QQ：{userId}",
    "消息：{message}",
    "",
    "请在需要时读取 {privateLogPath} 查看上下文。"
  ].join("\n");
}

export function defaultHeartbeatMessage(): string {
  return "定时心跳巡检：请检查最近消息和角色相关上下文。";
}

export function defaultHeartbeatTemplate(): string {
  return [
    "定时触发提醒：到了心跳路由时间。",
    "时间：{time}",
    "来源：{messageTarget}",
    "间隔：{heartbeatIntervalSeconds} 秒",
    "消息：{message}",
    "",
    "请读取 {dataDir} 下的消息日志和角色相关上下文，按当前人格判断是否需要回应、记录、追问或保持安静。"
  ].join("\n");
}

export function defaultVoiceTranscriptTemplate(): string {
  return [
    "语音转写更新提醒：FenneNote 捕获到一段来自电脑旁用户的语音输入。",
    "时间：{time}",
    "来源：{messageTarget}",
    "转写：{message}",
    "时长：{voiceDurationSeconds} 秒",
    "峰值：{voicePeak}",
    "",
    "默认在当前 Codex 会话里承接语音输入，并在需要时生成适合 TTS 的短回复。若转写文本明确要求发送到 QQ/NapCat，且目标、内容和授权足够清楚，请按现有外发流程处理；缺少信息时只追问最小缺口，不要因为来源是 voice_transcript 就一律拒绝发送。需要上下文时再读取 {voiceTranscriptLogPath}。"
  ].join("\n");
}

export function normalizeRule(rule: Partial<NotificationRule> | undefined, index: number): NotificationRule {
  return {
    id: rule?.id || `rule-${index + 1}`,
    name: rule?.name || rule?.id || `规则 ${index + 1}`,
    enabled: rule?.enabled !== false,
    routeKinds: Array.isArray(rule?.routeKinds) ? rule.routeKinds : [],
    targetGroupId: rule?.targetGroupId || "",
    regex: rule?.regex || "",
    template: normalizeTemplateText(rule?.template || defaultGroupAtTemplate())
  };
}

export function cloneRules(rules: NotificationRule[] | undefined): NotificationRule[] {
  return JSON.parse(JSON.stringify(Array.isArray(rules) ? rules : [])).map((rule: NotificationRule, index: number) => normalizeRule(rule, index));
}

export function gatewayAdapterTypes(gateway: GatewayDefinition): MessageAdapterType[] {
  const adapters = Array.isArray(gateway.messageAdapters) && gateway.messageAdapters.length > 0
    ? gateway.messageAdapters
    : [gateway.messageAdapterType || "napcat"];
  const disabled = new Set(gateway.messageAdaptersDisabled ?? []);
  const next = [...new Set(adapters)]
    .filter((type): type is MessageAdapterType => Boolean(type) && type !== "disabled" && !disabled.has(type));
  return next.length > 0 ? next : [];
}

export function isAdapterDisabled(gateway: GatewayDefinition, type: MessageAdapterType): boolean {
  return gateway.messageAdaptersDisabled?.includes(type) === true;
}

export function toggleAdapterDisabled(gateway: GatewayDefinition, type: MessageAdapterType): void {
  const disabled = gateway.messageAdaptersDisabled ?? [];
  if (disabled.includes(type)) {
    gateway.messageAdaptersDisabled = disabled.filter(t => t !== type);
  } else {
    gateway.messageAdaptersDisabled = [...disabled, type];
  }
}

export function isMessageInputsDisabled(gateway: GatewayDefinition): boolean {
  return gateway.messageInputsDisabled === true || gateway.messageAdapters?.includes("disabled") === true;
}

export function setGatewayAdapters(gateway: GatewayDefinition, adapters: MessageAdapterType[]): void {
  const next = [...new Set(adapters.filter(Boolean))].filter(type => type !== "disabled");
  gateway.messageAdapters = next.length > 0 ? next : ["napcat"];
  gateway.messageAdapterType = gateway.messageAdapters[0];
  // clean up disabled list for removed adapters
  if (gateway.messageAdaptersDisabled) {
    gateway.messageAdaptersDisabled = gateway.messageAdaptersDisabled.filter(t => gateway.messageAdapters!.includes(t));
  }
}

export function adapterLabel(type: string): string {
  if (type === "napcat") return "NapCat / OneBot";
  if (type === "heartbeat") return "定时触发";
  if (type === "webhook") return "Webhook";
  if (type === "disabled") return "已禁用";
  return type;
}

export function applyAdapterDefaults(gateway: GatewayDefinition): void {
  const adapters = gatewayAdapterTypes(gateway);
  if (adapters.includes("napcat")) {
    gateway.gatewayPort = Number(gateway.gatewayPort || 8790);
    gateway.napcatHttpUrl = gateway.napcatHttpUrl || "http://127.0.0.1:3000";
  }
  if (adapters.includes("heartbeat")) {
    gateway.heartbeatIntervalSeconds = Number(gateway.heartbeatIntervalSeconds || 900);
    gateway.heartbeatMessage = gateway.heartbeatMessage || defaultHeartbeatMessage();
  }
  if (adapters.includes("webhook")) {
    gateway.webhookPort = Number(gateway.webhookPort || gateway.gatewayPort || 8790);
    gateway.webhookPath = gateway.webhookPath || "/webhook";
  }
}

export function configNameFor(gateway: GatewayDefinition): string {
  if (gateway.configName) return gateway.configName;
  const parts = String(gateway.id || "").split("__");
  return parts.length > 1 ? parts.slice(1).join("__") : gateway.id || "default";
}

export function adapterConfigPathFor(gateway: GatewayDefinition): string {
  return `./data/route/${configNameFor(gateway)}/adapterConfig.json`;
}

export function routeDataDirFor(gateway: GatewayDefinition): string {
  return `./data/route`;
}

export function ensureRouteVariables(gateway: GatewayDefinition): Record<string, string> {
  if (!gateway.routeVariables || typeof gateway.routeVariables !== "object" || Array.isArray(gateway.routeVariables)) {
    gateway.routeVariables = {};
  }
  return gateway.routeVariables;
}

export function activeRoleKey(gateway: GatewayDefinition): string {
  return gateway.agentRoleId || gateway.id || "";
}

export function ensureActiveRoleRules(gateway: GatewayDefinition): NotificationRule[] {
  if (!Array.isArray(gateway.notificationRules)) gateway.notificationRules = [];
  return gateway.notificationRules;
}

export function saveActiveRoleRules(_gateway: GatewayDefinition): void {
  // Rules are shared per persona; no per-gateway cache needed
}

export function notificationRulesForGateway(gateway: GatewayDefinition): NotificationRule[] {
  if (!Array.isArray(gateway.notificationRules)) gateway.notificationRules = [];
  return gateway.notificationRules;
}

export function routeKindDefinitionsForGateway(_gateway?: GatewayDefinition) {
  return [
    {
      adapter: "napcat",
      title: "NapCat / OneBot",
      note: "QQ 实时消息；可先配置规则，再回到消息适配器启用入口。",
      groups: [
        { title: "群聊事件", routeKinds: ["direct_at", "direct_reply", "indirect_reply", "group_message"] },
        { title: "私聊事件", routeKinds: ["private"] }
      ]
    },
    {
      adapter: "heartbeat",
      title: "定时触发",
      note: "内部定时事件；勾选后仅在规则启用且入口产生 heartbeat 时投递。",
      groups: [{ title: "定时事件", routeKinds: ["heartbeat"] }]
    },
    {
      adapter: "manual",
      title: "手动触发",
      note: "托盘或本地 API 主动触发；不依赖消息 adapter。",
      groups: [{ title: "手动事件", routeKinds: ["manual_trigger"] }]
    },
    {
      adapter: "webhook",
      title: "Webhook",
      note: "外部系统事件；可用于语音转写、自动化或后续扩展。",
      groups: [{ title: "语音 / 外部事件", routeKinds: ["voice_transcript"] }]
    }
  ];
}

export function isGroupRouteKind(routeKind: string): boolean {
  return ["direct_at", "direct_reply", "indirect_reply", "group_message"].includes(routeKind);
}

export function ruleHasGroupRoute(rule: NotificationRule): boolean {
  return (Array.isArray(rule.routeKinds) ? rule.routeKinds : []).some(isGroupRouteKind);
}

export function routeKindSummary(rule: NotificationRule): string {
  const kinds = Array.isArray(rule.routeKinds) ? rule.routeKinds : [];
  return kinds.length ? kinds.map(kind => routeKindLabels[kind] || kind).join(" / ") : "未选择路由类型";
}

export function ruleTemplateSnippet(rule: NotificationRule): string {
  return normalizeTemplateText(rule.template || "").replace(/\s+/g, " ").trim().slice(0, 120) || "暂无模板正文";
}

export function explainAgentError(error: unknown): string {
  const text = String(error || "");
  if (!text) return "";
  if (text.includes("no-client-found")) {
    return "Codex Desktop IPC 没有找到可用客户端。请确认 Codex Desktop 正在运行，并且目标线程可被当前 Desktop 会话接收。";
  }
  if (text.includes("thread not found")) {
    return "Codex 线程 ID 已失效。请在 RibiWebGUI 中重新绑定或让 manager 重新发现目标线程。";
  }
  return text;
}

function requiresCodexBinding(agentAdapters: AgentAdapterType[] | undefined): boolean {
  const adapters = Array.isArray(agentAdapters) && agentAdapters.length ? agentAdapters : ["codexDesktop"];
  return adapters.some(adapter => adapter === "codexDesktop" || adapter === "codexApp" || adapter === "copilotCli" || adapter === "astrbot");
}

export function adapterConnectionReasons(gateway: GatewayDefinition, runtime: RuntimeStatus, adapterTypes: MessageAdapterType[]): string[] {
  const gatewayStatus = runtime.gatewayStatus || {};
  const adapterState = gatewayStatus.messageAdapter || {};
  const napcatState = gatewayStatus.napcat || {};
  const heartbeatState = gatewayStatus.heartbeat || {};
  const expectedRuntimeAdapters: MessageAdapterType[] = isMessageInputsDisabled(gateway) ? ["disabled"] : adapterTypes;
  const runtimeAdapterTypes = isMessageInputsDisabled(gateway)
    ? [adapterState.type || "disabled"]
    : Array.isArray(runtime.messageAdapters) && runtime.messageAdapters.length > 0
      ? runtime.messageAdapters
      : [runtime.messageAdapterType || adapterState.type || "napcat"];
  const adapterPendingRestart = expectedRuntimeAdapters.join(",") !== runtimeAdapterTypes.join(",");
  const reasons: string[] = [];
  if (!runtime.running) reasons.push("Gateway 进程未运行。");
  if (adapterPendingRestart) {
    reasons.push(`配置已变更但尚未重启：当前运行 ${runtimeAdapterTypes.map(adapterLabel).join(" + ")}，保存并重启后切换到 ${expectedRuntimeAdapters.map(adapterLabel).join(" + ")}。`);
  }
  if (isMessageInputsDisabled(gateway)) {
    return reasons;
  }
  if (adapterTypes.includes("napcat")) {
    const wsUrl = `ws://127.0.0.1:${gateway.gatewayPort || runtime.gatewayPort || "-"}`;
    const httpUrl = gateway.napcatHttpUrl || runtime.napcatHttpUrl || "-";
    if (!napcatState.connected) {
      reasons.push(napcatState.lastDisconnectedAt
        ? `NapCat WebSocket 当前未连接；最后断开时间：${napcatState.lastDisconnectedAt}。请检查 NapCat WebSocket Client 是否启用并连接到 ${wsUrl}。`
        : `NapCat WebSocket 尚未连接。请在 NapCat OneBot 网络配置中启用 WebSocket Client，并连接到 ${wsUrl}。`);
    }
    if (napcatState.loginInfoError) {
      reasons.push(`NapCat HTTP 不可用或登录资料读取失败：${napcatState.loginInfoError}。当前 HTTP 地址：${httpUrl}。`);
    }
  }
  if (adapterTypes.includes("heartbeat") && heartbeatState.enabled === false) reasons.push("定时触发消息端未启用。");
  return reasons;
}

export function adapterErrorsFor(type: MessageAdapterType, gateway: GatewayDefinition, runtime: RuntimeStatus): string[] {
  const gatewayStatus = runtime.gatewayStatus || {};
  const napcatState = gatewayStatus.napcat || {};
  const heartbeatState = gatewayStatus.heartbeat || {};
  const reasons: string[] = [];
  if (!runtime.running) {
    reasons.push("Gateway 进程未运行。");
    return reasons;
  }
  if (type === "napcat") {
    const wsUrl = `ws://127.0.0.1:${gateway.gatewayPort || runtime.gatewayPort || "-"}`;
    const httpUrl = gateway.napcatHttpUrl || runtime.napcatHttpUrl || "-";
    if (!napcatState.connected) {
      reasons.push(napcatState.lastDisconnectedAt
        ? `WebSocket 当前未连接；最后断开：${napcatState.lastDisconnectedAt}。请检查 NapCat WebSocket Client 是否连接到 ${wsUrl}。`
        : `WebSocket 尚未连接。请在 NapCat 网络配置中启用 WebSocket Client，连接到 ${wsUrl}。`);
    }
    if (napcatState.loginInfoError) {
      reasons.push(`HTTP 不可用或登录资料读取失败：${napcatState.loginInfoError}。地址：${httpUrl}`);
    }
  }
  if (type === "heartbeat" && heartbeatState.enabled === false) {
    reasons.push("定时触发消息端未启用。");
  }
  return reasons;
}

export function agentConnectionReasons(gateway: GatewayDefinition, runtime: RuntimeStatus): string[] {
  const agentState = runtime.codexState || {};
  const agentError = agentState.lastNotificationError || "";
  const reasons: string[] = [];
  if (!agentState.monitorThreadId) {
    reasons.push(agentState.message || `尚未绑定 Agent 会话。请确认 Codex Desktop 中存在名为“${gateway.codexThreadName || gateway.name || gateway.id}”的线程。`);
  }
  if (agentError) reasons.push(explainAgentError(agentError));
  return reasons;
}

export function createDefaultGateway(next: number): GatewayDefinition {
  const roleId = "Rabi";
  const configName = `config-${next}`;
  return {
    id: `${roleId}__${configName}`,
    configName,
    name: `路由配置 ${next}`,
    enabled: true,
    messageAdapterType: "napcat",
    messageAdapters: ["napcat"],
    gatewayPort: 8789 + next,
    napcatHttpUrl: "http://127.0.0.1:3000",
    heartbeatIntervalSeconds: 900,
    heartbeatMessage: defaultHeartbeatMessage(),
    routeVariables: {},
    codexThreadName: `路由配置 ${next}`,
    codexCwd: "",
    agentRoleId: roleId,
    agentRoleFile: "persona.md",
    agentAdapters: ["codexDesktop"],
    notificationRules: []
  };
}

export function isQuickSetupNeeded(gateways: GatewayDefinition[]): boolean {
  if (gateways.length === 0) return true;
  return gateways.some((gateway) => {
    const adapters = gatewayAdapterTypes(gateway);
    const missingMessageConfig = adapters.includes("napcat") && (!gateway.gatewayPort || !gateway.napcatHttpUrl);
    const missingAgentBinding = requiresCodexBinding(gateway.agentAdapters) && (!gateway.codexThreadName || !gateway.codexCwd);
    return !gateway.agentRoleId || missingAgentBinding || missingMessageConfig;
  });
}
