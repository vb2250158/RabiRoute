export const MESSAGE_ADAPTERS = [
  { id: "napcat", label: "QQ" },
  { id: "fennenote", label: "语音" },
  { id: "rabilink", label: "RabiLink" },
  { id: "webhook", label: "Webhook" },
  { id: "heartbeat", label: "定时" },
  { id: "xiaoai", label: "小爱" },
  { id: "wecom", label: "企微" },
  { id: "remoteAgent", label: "远端" }
];

export const MESSAGE_PAYLOAD_KINDS = [
  { id: "text", label: "文本" },
  { id: "image", label: "图片" },
  { id: "voice", label: "语音" },
  { id: "file", label: "文件" }
];

export const PIPELINE_INPUT_ADAPTERS = [
  ...MESSAGE_ADAPTERS,
  { id: "rolePanel", label: "角色面板" }
];

export const PIPELINE_OUTPUT_ADAPTERS = [
  { id: "qq", label: "QQ" },
  { id: "codex", label: "Codex" },
  { id: "file", label: "文件" },
  { id: "console", label: "控制台" },
  { id: "tts", label: "TTS" },
  { id: "webhook", label: "Webhook" },
  { id: "fennenote", label: "语音" },
  { id: "wecom", label: "企微" },
  { id: "none", label: "无" }
];

export const PROMPT_OUTPUT_MODES = [
  { id: "qq_text", label: "QQ 文本" },
  { id: "voice_short", label: "短语音" },
  { id: "markdown", label: "Markdown" },
  { id: "json", label: "JSON" },
  { id: "plain_text", label: "纯文本" }
];

export const CONFIG_PANELS = [
  { id: "route", label: "路由" },
  { id: "runtime", label: "运行" },
  { id: "message", label: "消息" },
  { id: "policy", label: "策略" },
  { id: "napcat", label: "NapCat" },
  { id: "agent", label: "Agent" },
  { id: "persona", label: "人格" },
  { id: "pipeline", label: "管道" },
  { id: "profiles", label: "Profile" },
  { id: "variables", label: "变量" },
  { id: "rules", label: "规则" },
  { id: "schedule", label: "计划" },
  { id: "templates", label: "模板" },
  { id: "integrations", label: "集成" },
  { id: "ports", label: "端口" },
  { id: "relay", label: "Relay" },
  { id: "tools", label: "工具" },
  { id: "advanced", label: "高级" },
  { id: "json", label: "JSON" }
];

export const NOTIFICATION_ROUTE_KINDS = [
  { id: "private", label: "私聊" },
  { id: "direct_at", label: "@我" },
  { id: "direct_reply", label: "直接回复" },
  { id: "indirect_reply", label: "间接回复" },
  { id: "voice_transcript", label: "语音" },
  { id: "rabilink", label: "RabiLink" },
  { id: "wecom_message", label: "企微" },
  { id: "heartbeat", label: "心跳" },
  { id: "manual_trigger", label: "手动" },
  { id: "role_panel_message", label: "面板" }
];

export const NOTIFICATION_SCHEDULE_TYPES = [
  { id: "interval", label: "间隔" },
  { id: "daily_time", label: "每日" },
  { id: "once_at", label: "一次" }
];

export const NOTIFICATION_TEMPLATE_FIELDS = [
  { key: "groupNotificationTemplate", label: "群消息" },
  { key: "groupAtNotificationTemplate", label: "群 @" },
  { key: "groupDirectReplyNotificationTemplate", label: "群直接回复" },
  { key: "groupIndirectReplyNotificationTemplate", label: "群间接回复" },
  { key: "groupReplyNotificationTemplate", label: "群回复旧版" },
  { key: "groupNicknameNotificationTemplate", label: "群昵称旧版" },
  { key: "privateNotificationTemplate", label: "私聊" },
  { key: "heartbeatNotificationTemplate", label: "心跳" },
  { key: "voiceTranscriptNotificationTemplate", label: "语音转写" }
];

export const GATEWAY_SCALAR_FIELDS = [
  { key: "id", label: "Route ID", type: "string" },
  { key: "name", label: "显示名称", type: "string" },
  { key: "configName", label: "配置目录名", type: "string" },
  { key: "routeName", label: "Route 名称", type: "string" },
  { key: "enabled", label: "是否启用", type: "boolean" },
  { key: "messageAdapterType", label: "旧版消息端", type: "string" },
  { key: "messageInputsDisabled", label: "禁用消息输入", type: "boolean" },
  { key: "gatewayPort", label: "Gateway 端口", type: "number" },
  { key: "webhookPort", label: "Webhook 端口", type: "number" },
  { key: "webhookPath", label: "Webhook 路径", type: "string" },
  { key: "fenneNoteWebhookPort", label: "FenneNote 端口", type: "number" },
  { key: "fenneNoteWebhookPath", label: "FenneNote 路径", type: "string" },
  { key: "xiaoaiWebhookPort", label: "小爱端口", type: "number" },
  { key: "xiaoaiWebhookPath", label: "小爱路径", type: "string" },
  { key: "rabiLinkWebhookPort", label: "RabiLink 端口", type: "number" },
  { key: "rabiLinkWebhookPath", label: "RabiLink 路径", type: "string" },
  { key: "rabiLinkWebhookHost", label: "RabiLink 监听地址", type: "string" },
  { key: "rabiLinkRelayEnabled", label: "旧版 Relay 启用", type: "boolean" },
  { key: "rabiLinkRelayUrl", label: "旧版 Relay URL", type: "string" },
  { key: "rabiLinkRelayToken", label: "旧版 Relay Token", type: "string" },
  { key: "rabiLinkRelayDeviceId", label: "旧版 Relay 设备", type: "string" },
  { key: "rabiLinkRelayClaimWaitMs", label: "旧版领取等待", type: "number" },
  { key: "rabiLinkRelayReplyIdleTimeoutMs", label: "旧版回复空闲", type: "number" },
  { key: "wecomBotId", label: "企微 Bot ID", type: "string" },
  { key: "wecomBotSecret", label: "企微 Secret", type: "string" },
  { key: "wecomWsUrl", label: "企微 WebSocket", type: "string" },
  { key: "heartbeatIntervalSeconds", label: "心跳间隔秒", type: "number" },
  { key: "heartbeatMessage", label: "心跳消息", type: "string" },
  { key: "heartbeatSkipWhenAgentBusy", label: "Agent 忙碌时跳过心跳", type: "boolean" },
  { key: "remoteAgentDefaultDeviceId", label: "远端 Agent 设备", type: "string" },
  { key: "remoteAgentDefaultCwd", label: "远端 Agent 目录", type: "string" },
  { key: "remoteAgentDefaultThreadName", label: "远端 Agent 会话", type: "string" },
  { key: "napcatHttpUrl", label: "NapCat HTTP", type: "string" },
  { key: "napcatWebuiUrl", label: "NapCat WebUI", type: "string" },
  { key: "napcatAccessToken", label: "NapCat Access Token", type: "string" },
  { key: "napcatWebuiToken", label: "NapCat WebUI Token", type: "string" },
  { key: "targetGroupId", label: "目标群", type: "string" },
  { key: "pipelinePreset", label: "Pipeline Preset", type: "string" },
  { key: "agentModel", label: "Agent 模型", type: "string" },
  { key: "codexThreadId", label: "Codex 会话 ID", type: "string" },
  { key: "codexThreadName", label: "Codex 会话", type: "string" },
  { key: "codexCwd", label: "Codex 目录", type: "string" },
  { key: "copilotThreadName", label: "Copilot 会话", type: "string" },
  { key: "copilotCwd", label: "Copilot 目录", type: "string" },
  { key: "copilotCliBin", label: "Copilot CLI", type: "string" },
  { key: "marvisAppId", label: "Marvis App ID", type: "string" },
  { key: "astrbotUrl", label: "AstrBot URL", type: "string" },
  { key: "astrbotUsername", label: "AstrBot 用户", type: "string" },
  { key: "astrbotPassword", label: "AstrBot 密码", type: "string" },
  { key: "astrbotProjectId", label: "AstrBot 项目", type: "string" },
  { key: "astrbotSessionId", label: "AstrBot 会话", type: "string" },
  { key: "rolesDir", label: "角色目录覆盖", type: "string" },
  { key: "routesDir", label: "路由目录覆盖", type: "string" },
  { key: "agentRoleId", label: "人格 ID", type: "string" },
  { key: "agentRoleFile", label: "人格文件", type: "string" },
  { key: "dataDir", label: "数据目录", type: "string" },
  { key: "groupNotificationTemplate", label: "群消息模板", type: "string" },
  { key: "groupAtNotificationTemplate", label: "群 @ 模板", type: "string" },
  { key: "groupDirectReplyNotificationTemplate", label: "群直接回复模板", type: "string" },
  { key: "groupIndirectReplyNotificationTemplate", label: "群间接回复模板", type: "string" },
  { key: "groupReplyNotificationTemplate", label: "群回复模板", type: "string" },
  { key: "groupNicknameNotificationTemplate", label: "群昵称模板", type: "string" },
  { key: "privateNotificationTemplate", label: "私聊模板", type: "string" },
  { key: "heartbeatNotificationTemplate", label: "心跳模板", type: "string" },
  { key: "voiceTranscriptNotificationTemplate", label: "语音转写模板", type: "string" },
  { key: "recentMessageLimit", label: "最近消息数量", type: "number" },
  { key: "speechPushMode", label: "Route 语音投递模式", type: "string" }
];

export const GATEWAY_JSON_FIELDS = [
  { key: "messageAdapters", label: "消息端列表" },
  { key: "messageAdaptersDisabled", label: "停用消息端" },
  { key: "messageAdapterPolicies", label: "消息端策略" },
  { key: "napcatInstances", label: "NapCat 实例" },
  { key: "ignoredNapcatInstanceIds", label: "忽略 NapCat 实例" },
  { key: "pipeline", label: "Pipeline 定义" },
  { key: "routeVariables", label: "路由变量" },
  { key: "agentAdapters", label: "Agent 列表" },
  { key: "codexHooks", label: "Codex Hook 设置" },
  { key: "routeProfiles", label: "Route Profiles" },
  { key: "recentMessageLimits", label: "人格各消息端上下文额度" },
  { key: "speechTriggerKeywords", label: "人格语音触发关键词" },
  { key: "notificationRules", label: "通知规则" },
  { key: "roleNotificationRules", label: "角色通知规则" },
  { key: "roleRouteNames", label: "角色 Route 名" }
];

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

export function configNameFor(gateway) {
  return String(gateway?.configName || gateway?.id || gateway?.name || "").trim();
}

export function routeLabel(gateway) {
  return String(gateway?.routeName || gateway?.name || configNameFor(gateway) || "未命名 Route");
}

export function extractGateways(payload) {
  return cloneJson(payload?.data?.config?.gateways || payload?.gateways || []);
}

export function extractRuntimeRows(payload) {
  const rows = payload?.data?.manager;
  return Array.isArray(rows) ? rows : [];
}

export function saveBodyForGateways(gateways) {
  return { gateways: cloneJson(gateways || []) };
}

export function defaultHeartbeatMessage() {
  return "RabiRoute heartbeat";
}

export function nextGatewayNumber(gateways) {
  const used = new Set((gateways || []).map((gateway) => configNameFor(gateway)));
  let next = (gateways || []).length + 1;
  while (used.has(`config-${next}`)) next += 1;
  return next;
}

export function createDefaultGateway(next) {
  const configName = `config-${next}`;
  return {
    id: configName,
    configName,
    name: `路由配置 ${next}`,
    enabled: true,
    messageAdapterType: "napcat",
    messageAdapters: ["napcat"],
    messageAdapterPolicies: {
      napcat: {
        inputEnabled: true,
        outputEnabled: true,
        supportedOutputs: ["text", "image", "voice", "file"]
      }
    },
    gatewayPort: 8789 + next,
    napcatHttpUrl: "http://127.0.0.1:3000",
    heartbeatIntervalSeconds: 900,
    heartbeatMessage: defaultHeartbeatMessage(),
    heartbeatSkipWhenAgentBusy: false,
    routeVariables: {},
    agentModel: "",
    codexThreadName: `路由配置 ${next}`,
    codexCwd: "",
    copilotThreadName: `路由配置 ${next}`,
    agentRoleId: "",
    agentRoleFile: "persona.md",
    agentAdapters: ["codex"],
    notificationRules: []
  };
}

export function appendDefaultGateway(gateways) {
  const next = cloneJson(gateways || []);
  const gateway = createDefaultGateway(nextGatewayNumber(next));
  next.push(gateway);
  return { gateways: next, index: next.length - 1, gateway };
}

export function duplicateSelectedGateway(gateways, index) {
  const current = selectedGateway(gateways, index);
  if (!current) return appendDefaultGateway(gateways);
  const next = cloneJson(gateways || []);
  const number = nextGatewayNumber(next);
  const configName = `config-${number}`;
  const gateway = {
    ...cloneJson(current),
    id: configName,
    configName,
    name: `${routeLabel(current)} 副本`,
    routeName: current.routeName ? `${current.routeName} 副本` : undefined,
    enabled: false,
    gatewayPort: 8789 + number,
    webhookPort: undefined,
    fenneNoteWebhookPort: undefined,
    xiaoaiWebhookPort: undefined,
    rabiLinkWebhookPort: undefined,
    codexThreadName: current.codexThreadName ? `${current.codexThreadName} 副本` : `路由配置 ${number}`,
    copilotThreadName: current.copilotThreadName ? `${current.copilotThreadName} 副本` : `路由配置 ${number}`
  };
  next.splice(Math.min(Math.max(index + 1, 0), next.length), 0, gateway);
  return { gateways: next, index: next.indexOf(gateway), gateway };
}

export function removeSelectedGateway(gateways, index) {
  const current = selectedGateway(gateways, index);
  const next = cloneJson(gateways || []);
  if (!current || next.length === 0) {
    return { gateways: next, index: 0, removed: null };
  }
  const removedIndex = Math.max(0, Math.min(index, next.length - 1));
  const removed = next.splice(removedIndex, 1)[0] || null;
  const nextIndex = next.length === 0 ? 0 : Math.min(removedIndex, next.length - 1);
  return { gateways: next, index: nextIndex, removed };
}

export function moveSelectedGateway(gateways, index, delta) {
  const next = cloneJson(gateways || []);
  if (next.length === 0) return { gateways: next, index: 0, moved: null };
  const from = Math.max(0, Math.min(index, next.length - 1));
  const to = Math.max(0, Math.min(from + delta, next.length - 1));
  if (from === to) return { gateways: next, index: from, moved: next[from] || null };
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { gateways: next, index: to, moved };
}

export function selectedGateway(gateways, index) {
  if (!Array.isArray(gateways) || gateways.length === 0) return null;
  return gateways[Math.max(0, Math.min(index, gateways.length - 1))] || null;
}

export function findGatewayIndex(gateways, routeId) {
  const target = String(routeId || "").trim();
  if (!target) return 0;
  const index = (gateways || []).findIndex((gateway) => {
    return gateway.id === target || gateway.configName === target || gateway.name === target;
  });
  return Math.max(0, index);
}

export function messageAdaptersFor(gateway) {
  if (Array.isArray(gateway?.messageAdapters) && gateway.messageAdapters.length > 0) {
    return [...new Set(gateway.messageAdapters.map(String).filter(Boolean))];
  }
  const legacy = String(gateway?.messageAdapterType || "").trim();
  return legacy && legacy !== "disabled" ? [legacy] : [];
}

export function payloadKindListFor(value) {
  const allowed = new Set(MESSAGE_PAYLOAD_KINDS.map((item) => item.id));
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[,\s，、]+/);
  const kinds = [...new Set(source.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))];
  return kinds.length ? kinds : MESSAGE_PAYLOAD_KINDS.map((item) => item.id);
}

export function messageAdapterPolicyFor(gateway, adapterId) {
  const id = String(adapterId || "").trim();
  const rawPolicies = gateway?.messageAdapterPolicies && typeof gateway.messageAdapterPolicies === "object" && !Array.isArray(gateway.messageAdapterPolicies)
    ? gateway.messageAdapterPolicies
    : {};
  const raw = rawPolicies[id] && typeof rawPolicies[id] === "object" && !Array.isArray(rawPolicies[id])
    ? rawPolicies[id]
    : {};
  const disabled = Array.isArray(gateway?.messageAdaptersDisabled)
    ? gateway.messageAdaptersDisabled.map(String).includes(id)
    : false;
  return {
    inputEnabled: raw.inputEnabled ?? !disabled,
    outputEnabled: raw.outputEnabled ?? true,
    supportedOutputs: payloadKindListFor(raw.supportedOutputs)
  };
}

export function messageAdapterPolicyRowsFor(gateway) {
  return messageAdaptersFor(gateway).map((adapterId) => {
    const adapter = MESSAGE_ADAPTERS.find((item) => item.id === adapterId) || { id: adapterId, label: adapterId };
    const policy = messageAdapterPolicyFor(gateway, adapterId);
    return {
      id: adapterId,
      label: adapter.label,
      inputEnabled: policy.inputEnabled,
      outputEnabled: policy.outputEnabled,
      supportedOutputs: policy.supportedOutputs,
      supportedOutputsText: policy.supportedOutputs.join(", ")
    };
  });
}

export function setMessageAdapterPolicy(gateways, index, adapterId, patch) {
  const id = String(adapterId || "").trim();
  if (!id || id === "disabled") throw new Error("请选择一个消息端策略。");
  return updateSelectedGateway(gateways, index, (gateway) => {
    const adapters = messageAdaptersFor(gateway);
    if (!adapters.includes(id)) throw new Error(`消息端 ${id} 尚未添加。`);
    const current = messageAdapterPolicyFor(gateway, id);
    const nextPolicy = { ...current, ...patch };
    nextPolicy.supportedOutputs = payloadKindListFor(nextPolicy.supportedOutputs);
    gateway.messageAdapterPolicies = gateway.messageAdapterPolicies && typeof gateway.messageAdapterPolicies === "object" && !Array.isArray(gateway.messageAdapterPolicies)
      ? { ...gateway.messageAdapterPolicies }
      : {};
    gateway.messageAdapterPolicies[id] = nextPolicy;
    const disabled = new Set(Array.isArray(gateway.messageAdaptersDisabled) ? gateway.messageAdaptersDisabled.map(String) : []);
    if (nextPolicy.inputEnabled) disabled.delete(id);
    else disabled.add(id);
    gateway.messageAdaptersDisabled = [...disabled].filter((item) => adapters.includes(item));
    return gateway;
  });
}

export function toggleMessageAdapterPayload(gateways, index, adapterId, payloadKind) {
  const gateway = selectedGateway(gateways, index);
  const current = messageAdapterPolicyFor(gateway, adapterId);
  const outputs = new Set(current.supportedOutputs);
  if (outputs.has(payloadKind)) outputs.delete(payloadKind);
  else outputs.add(payloadKind);
  return setMessageAdapterPolicy(gateways, index, adapterId, {
    supportedOutputs: [...outputs]
  });
}

export function agentAdaptersFor(gateway) {
  if (Array.isArray(gateway?.agentAdapters) && gateway.agentAdapters.length > 0) {
    return [...new Set(gateway.agentAdapters.map(normalizeAgentAdapter).filter(Boolean))];
  }
  return ["codex"];
}

export function normalizeAgentAdapter(value) {
  if (value === "codex" || value === "copilotCli" || value === "marvis" || value === "astrbot") return value;
  return "";
}

export function patchSelectedGateway(gateways, index, patch) {
  const next = cloneJson(gateways || []);
  if (!next[index]) return next;
  next[index] = { ...next[index], ...patch };
  return next;
}

export function updateSelectedGateway(gateways, index, updater) {
  const next = cloneJson(gateways || []);
  if (!next[index]) return next;
  next[index] = updater(next[index]) || next[index];
  return next;
}

export function setMessageAdapter(gateways, index, adapterId, enabled) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const adapters = new Set(messageAdaptersFor(gateway));
    if (enabled) adapters.add(adapterId);
    else adapters.delete(adapterId);
    const next = [...adapters];
    gateway.messageAdapters = next.length ? next : ["heartbeat"];
    gateway.messageAdapterType = gateway.messageAdapters[0];
    return gateway;
  });
}

export function setAgentAdapter(gateways, index, adapterId) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    gateway.agentAdapters = [adapterId || "codex"];
    return gateway;
  });
}

function optionIdSet(options) {
  return new Set(options.map((item) => item.id));
}

function optionalOptionValue(value, options, label) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (!optionIdSet(options).has(text)) throw new Error(`${label} 不支持：${text}`);
  return text;
}

function optionalTextValue(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

export function pipelineConfigFor(gateway) {
  const raw = gateway?.pipeline && typeof gateway.pipeline === "object" && !Array.isArray(gateway.pipeline)
    ? gateway.pipeline
    : {};
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    inputAdapter: typeof raw.inputAdapter === "string" ? raw.inputAdapter : "",
    outputAdapter: typeof raw.outputAdapter === "string" ? raw.outputAdapter : "",
    outputPipeline: typeof raw.outputPipeline === "string" ? raw.outputPipeline : "",
    promptOutputMode: typeof raw.promptOutputMode === "string" ? raw.promptOutputMode : "",
    ttsProvider: typeof raw.ttsProvider === "string" ? raw.ttsProvider : "",
    ttsVoice: typeof raw.ttsVoice === "string" ? raw.ttsVoice : "",
    ttsWorkerUrl: typeof raw.ttsWorkerUrl === "string" ? raw.ttsWorkerUrl : "",
    ttsPlay: raw.ttsPlay === true,
    preventFeedbackLoop: raw.preventFeedbackLoop === true,
    replyToSource: raw.replyToSource === true
  };
}

export function pipelineSummaryFor(gateway) {
  const pipeline = gateway?.pipeline && typeof gateway.pipeline === "object" && !Array.isArray(gateway.pipeline)
    ? gateway.pipeline
    : null;
  if (!pipeline) return "未配置 pipeline 覆盖";
  const config = pipelineConfigFor(gateway);
  const output = config.outputAdapter || "-";
  const mode = config.promptOutputMode || "-";
  const tts = config.ttsProvider || "无 TTS";
  return `${config.id || config.name || "pipeline"} · ${output} · ${mode} · ${tts}`;
}

export function setPipelineConfig(gateways, index, patch) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const source = {
      ...(gateway.pipeline && typeof gateway.pipeline === "object" && !Array.isArray(gateway.pipeline) ? gateway.pipeline : {}),
      ...(patch || {})
    };
    const next = {
      id: optionalTextValue(source.id),
      name: optionalTextValue(source.name),
      inputAdapter: optionalOptionValue(source.inputAdapter, PIPELINE_INPUT_ADAPTERS, "输入适配端"),
      outputAdapter: optionalOptionValue(source.outputAdapter, PIPELINE_OUTPUT_ADAPTERS, "输出适配端"),
      outputPipeline: optionalTextValue(source.outputPipeline),
      promptOutputMode: optionalOptionValue(source.promptOutputMode, PROMPT_OUTPUT_MODES, "提示词输出模式"),
      ttsProvider: optionalTextValue(source.ttsProvider),
      ttsVoice: optionalTextValue(source.ttsVoice),
      ttsWorkerUrl: optionalTextValue(source.ttsWorkerUrl),
      ttsPlay: typeof source.ttsPlay === "boolean" ? source.ttsPlay : undefined,
      preventFeedbackLoop: typeof source.preventFeedbackLoop === "boolean" ? source.preventFeedbackLoop : undefined,
      replyToSource: typeof source.replyToSource === "boolean" ? source.replyToSource : undefined
    };
    const compact = {};
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) compact[key] = value;
    }
    if (Object.keys(compact).length === 0) delete gateway.pipeline;
    else gateway.pipeline = compact;
    return gateway;
  });
}

export function clearPipelineConfig(gateways, index) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    delete gateway.pipeline;
    return gateway;
  });
}

function normalizeConfigId(value, fallback, label) {
  const text = String(value ?? "").trim() || fallback;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`${label} 只能包含字母、数字、下划线和短横线。`);
  return text;
}

function parseOptionalPositiveNumber(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue <= 0) throw new Error(`${label} 必须是正数。`);
  return Math.floor(numberValue);
}

function objectValueFor(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? cloneJson(value) : cloneJson(fallback);
}

export function normalizeRouteProfile(profile, index = 0, gateway = {}) {
  const raw = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  const fallbackId = normalizeConfigId(gateway.configName || gateway.id || `route-${index + 1}`, `route-${index + 1}`, "Profile ID");
  const id = normalizeConfigId(raw.id, index === 0 ? fallbackId : `profile-${index + 1}`, "Profile ID");
  const roleId = String(raw.agentRoleId ?? gateway.agentRoleId ?? "").trim();
  const rules = Array.isArray(raw.notificationRules) && raw.notificationRules.length
    ? raw.notificationRules.map((rule, ruleIndex) => normalizeNotificationRule(rule, ruleIndex))
    : notificationRuleRowsFor(gateway);
  return {
    id,
    name: String(raw.name || gateway.routeName || gateway.name || id).trim(),
    enabled: raw.enabled !== false,
    recentMessageLimit: parseOptionalPositiveNumber(raw.recentMessageLimit ?? gateway.recentMessageLimit, "最近消息数量"),
    pipelinePreset: String(raw.pipelinePreset ?? gateway.pipelinePreset ?? "").trim(),
    pipeline: raw.pipeline && typeof raw.pipeline === "object" && !Array.isArray(raw.pipeline)
      ? pipelineConfigFor({ pipeline: raw.pipeline })
      : undefined,
    agentRoleId: roleId,
    agentRoleFile: String(raw.agentRoleFile ?? gateway.agentRoleFile ?? "persona.md").trim(),
    rolesDir: String(raw.rolesDir ?? gateway.rolesDir ?? "").trim(),
    dataDir: String(raw.dataDir ?? gateway.dataDir ?? "").trim(),
    routeVariables: objectValueFor(raw.routeVariables, gateway.routeVariables || {}),
    notificationRules: rules
  };
}

export function routeProfileRowsFor(gateway) {
  if (!gateway) return [];
  const profiles = Array.isArray(gateway.routeProfiles) ? gateway.routeProfiles : [];
  if (profiles.length > 0) {
    return profiles.map((profile, index) => normalizeRouteProfile(profile, index, gateway));
  }
  return [normalizeRouteProfile({
    id: gateway.id || gateway.configName || "default",
    name: routeLabel(gateway),
    enabled: gateway.enabled !== false,
    recentMessageLimit: gateway.recentMessageLimit,
    pipelinePreset: gateway.pipelinePreset,
    pipeline: gateway.pipeline,
    agentRoleId: gateway.agentRoleId,
    agentRoleFile: gateway.agentRoleFile,
    rolesDir: gateway.rolesDir,
    dataDir: gateway.dataDir,
    routeVariables: gateway.routeVariables,
    notificationRules: notificationRuleRowsFor(gateway)
  }, 0, gateway)];
}

export function routeProfileSummaryFor(profile, index, total) {
  if (!profile) return "未配置 Profile";
  const role = profile.agentRoleId || "无角色";
  const preset = profile.pipelinePreset || "默认管道";
  const rules = Array.isArray(profile.notificationRules) ? profile.notificationRules.length : 0;
  return `${index + 1}/${total} ${profile.enabled === false ? "停用" : "启用"} · ${role} · ${preset} · ${rules} 规则`;
}

export function nextRouteProfileNumber(gateway) {
  const used = new Set(routeProfileRowsFor(gateway).map((profile) => profile.id));
  let next = routeProfileRowsFor(gateway).length + 1;
  while (used.has(`profile-${next}`)) next += 1;
  return next;
}

function defaultProfileRules(gateway) {
  const rules = notificationRuleRowsFor(gateway);
  if (rules.length) return rules;
  return [{
    id: `profile-rule-${Date.now().toString(36)}`,
    name: "Profile 默认规则",
    enabled: true,
    routeKinds: ["private", "direct_at"],
    targetGroupId: "",
    allowedSpeakerNames: [],
    regex: "",
    template: ""
  }];
}

export function createDefaultRouteProfile(gateway) {
  const next = nextRouteProfileNumber(gateway);
  return normalizeRouteProfile({
    id: next === 1 ? (gateway?.id || gateway?.configName || "default") : `profile-${next}`,
    name: next === 1 ? routeLabel(gateway) : `Profile ${next}`,
    enabled: true,
    recentMessageLimit: gateway?.recentMessageLimit,
    pipelinePreset: gateway?.pipelinePreset || "",
    pipeline: gateway?.pipeline,
    agentRoleId: gateway?.agentRoleId || "",
    agentRoleFile: gateway?.agentRoleFile || "persona.md",
    rolesDir: gateway?.rolesDir || "",
    dataDir: gateway?.dataDir || "",
    routeVariables: gateway?.routeVariables || {},
    notificationRules: defaultProfileRules(gateway)
  }, next - 1, gateway);
}

function syncRouteProfileLegacyMaps(gateway) {
  const profiles = routeProfileRowsFor(gateway);
  gateway.routeProfiles = profiles;
  const roleNotificationRules = {};
  const roleRouteNames = {};
  for (const profile of profiles) {
    const key = String(profile.agentRoleId || profile.id || "").trim();
    if (!key) continue;
    roleRouteNames[key] = profile.name || profile.id;
    roleNotificationRules[key] = profile.notificationRules || [];
  }
  gateway.roleRouteNames = roleRouteNames;
  gateway.roleNotificationRules = roleNotificationRules;
  return gateway;
}

export function addRouteProfile(gateways, index) {
  const gateway = selectedGateway(gateways, index);
  const profile = createDefaultRouteProfile(gateway);
  const next = updateSelectedGateway(gateways, index, (item) => {
    const profiles = routeProfileRowsFor(item);
    profiles.push(profile);
    item.routeProfiles = profiles;
    return syncRouteProfileLegacyMaps(item);
  });
  const rows = routeProfileRowsFor(selectedGateway(next, index));
  return { gateways: next, index: Math.max(0, rows.findIndex((item) => item.id === profile.id)), profile };
}

export function setRouteProfile(gateways, index, profileIndex, patch) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const profiles = routeProfileRowsFor(gateway);
    if (!profiles[profileIndex]) throw new Error("当前没有可应用的 Route Profile。");
    const routeVariables = typeof patch.routeVariables === "string"
      ? parseJsonValue({ label: "Profile 变量" }, patch.routeVariables)
      : patch.routeVariables;
    const pipeline = typeof patch.pipeline === "string"
      ? parseJsonValue({ label: "Profile Pipeline" }, patch.pipeline)
      : patch.pipeline;
    const notificationRules = Array.isArray(patch.notificationRules) ? patch.notificationRules : profiles[profileIndex].notificationRules;
    const normalized = normalizeRouteProfile({
      ...profiles[profileIndex],
      ...patch,
      pipeline,
      routeVariables,
      notificationRules
    }, profileIndex, gateway);
    if (profiles.some((item, itemIndex) => itemIndex !== profileIndex && item.id === normalized.id)) {
      throw new Error(`Route Profile ID 已存在：${normalized.id}`);
    }
    profiles[profileIndex] = normalized;
    gateway.routeProfiles = profiles;
    return syncRouteProfileLegacyMaps(gateway);
  });
}

export function notificationTemplateField(index) {
  if (!NOTIFICATION_TEMPLATE_FIELDS.length) return null;
  return NOTIFICATION_TEMPLATE_FIELDS[Math.max(0, Math.min(index, NOTIFICATION_TEMPLATE_FIELDS.length - 1))] || null;
}

export function notificationTemplateValueFor(gateway, templateIndex) {
  const field = notificationTemplateField(templateIndex);
  if (!field || !gateway) return "";
  return typeof gateway[field.key] === "string" ? gateway[field.key] : "";
}

export function notificationTemplateSummaryFor(gateway, templateIndex) {
  const field = notificationTemplateField(templateIndex);
  if (!field) return "未选择模板";
  const value = notificationTemplateValueFor(gateway, templateIndex);
  return `${field.label} · ${value.trim() ? `${value.length} 字` : "默认"}`;
}

export function setNotificationTemplate(gateways, index, templateIndex, rawValue) {
  const field = notificationTemplateField(templateIndex);
  if (!field) throw new Error("当前没有可应用的通知模板。");
  return updateSelectedGateway(gateways, index, (gateway) => {
    const value = String(rawValue ?? "");
    if (value.trim()) gateway[field.key] = value;
    else delete gateway[field.key];
    return gateway;
  });
}

export function clearNotificationTemplate(gateways, index, templateIndex) {
  return setNotificationTemplate(gateways, index, templateIndex, "");
}

export function removeRouteProfile(gateways, index, profileIndex) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const profiles = routeProfileRowsFor(gateway);
    if (!profiles[profileIndex]) return gateway;
    profiles.splice(profileIndex, 1);
    gateway.routeProfiles = profiles;
    return syncRouteProfileLegacyMaps(gateway);
  });
}

function parseOptionalPort(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 必须是 1-65535 的整数。`);
  return port;
}

function validateOptionalUrl(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    new URL(text);
    return text.replace(/\/$/, "");
  } catch {
    throw new Error(`${label} 必须是有效 URL。`);
  }
}

function normalizeNapcatId(value, fallback) {
  const text = String(value ?? "").trim();
  const id = text || fallback;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("NapCat 实例 ID 只能包含字母、数字、下划线和短横线。");
  return id;
}

export function normalizeNapcatInstance(instance, index = 0, gateway = {}) {
  const raw = instance && typeof instance === "object" && !Array.isArray(instance) ? instance : {};
  return {
    id: normalizeNapcatId(raw.id, index === 0 ? "default" : `napcat-${index + 1}`),
    name: String(raw.name || raw.id || (index === 0 ? "默认 NapCat" : `NapCat ${index + 1}`)).trim(),
    enabled: raw.enabled !== false,
    gatewayPort: parseOptionalPort(raw.gatewayPort ?? gateway.gatewayPort ?? 8789, "NapCat WS 端口") ?? 8789,
    httpUrl: validateOptionalUrl(raw.httpUrl || gateway.napcatHttpUrl || "http://127.0.0.1:3000", "NapCat HTTP"),
    webuiUrl: validateOptionalUrl(raw.webuiUrl || gateway.napcatWebuiUrl || "http://127.0.0.1:6099/webui", "NapCat WebUI"),
    accessToken: String(raw.accessToken ?? gateway.napcatAccessToken ?? ""),
    webuiToken: String(raw.webuiToken ?? gateway.napcatWebuiToken ?? ""),
    launchCommand: String(raw.launchCommand ?? ""),
    workingDir: String(raw.workingDir ?? ""),
    botUserId: raw.botUserId == null ? "" : String(raw.botUserId),
    botNickname: String(raw.botNickname ?? ""),
    connected: raw.connected === true,
    remoteAddress: String(raw.remoteAddress ?? ""),
    lastConnectedAt: String(raw.lastConnectedAt ?? ""),
    lastDisconnectedAt: String(raw.lastDisconnectedAt ?? ""),
    loginInfoError: String(raw.loginInfoError ?? "")
  };
}

export function napcatInstanceRowsFor(gateway) {
  const instances = Array.isArray(gateway?.napcatInstances) ? gateway.napcatInstances : [];
  if (instances.length === 0 && gateway) {
    return [normalizeNapcatInstance({}, 0, gateway)];
  }
  return instances.map((instance, index) => normalizeNapcatInstance(instance, index, gateway));
}

export function selectedNapcatInstance(gateway, napcatIndex) {
  const rows = napcatInstanceRowsFor(gateway);
  if (!rows.length) return null;
  return rows[Math.max(0, Math.min(napcatIndex, rows.length - 1))] || null;
}

export function nextNapcatInstanceNumber(gateway) {
  const used = new Set(napcatInstanceRowsFor(gateway).map((instance) => instance.id));
  let next = napcatInstanceRowsFor(gateway).length + 1;
  while (used.has(`napcat-${next}`)) next += 1;
  return next;
}

function localUrlWithPort(baseUrl, fallbackPort, offset) {
  let parsed;
  try {
    parsed = new URL(baseUrl || `http://127.0.0.1:${fallbackPort}`);
  } catch {
    parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
  }
  const port = Number(parsed.port || fallbackPort) + offset;
  parsed.port = String(Math.max(1, Math.min(65535, port)));
  return parsed.toString().replace(/\/$/, "");
}

export function createDefaultNapcatInstance(gateway) {
  const next = nextNapcatInstanceNumber(gateway);
  return normalizeNapcatInstance({
    id: next === 1 ? "default" : `napcat-${next}`,
    name: next === 1 ? "默认 NapCat" : `NapCat ${next}`,
    enabled: true,
    gatewayPort: Number(gateway?.gatewayPort || 8789) + Math.max(0, next - 1),
    httpUrl: localUrlWithPort(gateway?.napcatHttpUrl, 3000, Math.max(0, next - 1)),
    webuiUrl: localUrlWithPort(gateway?.napcatWebuiUrl, 6099, Math.max(0, next - 1)),
    accessToken: gateway?.napcatAccessToken || "",
    webuiToken: gateway?.napcatWebuiToken || ""
  }, next - 1, gateway);
}

function syncPrimaryNapcatFields(gateway) {
  const rows = napcatInstanceRowsFor(gateway);
  gateway.napcatInstances = rows;
  const primary = rows.find((instance) => instance.enabled !== false) || rows[0];
  if (!primary) return gateway;
  gateway.gatewayPort = primary.gatewayPort;
  gateway.napcatHttpUrl = primary.httpUrl;
  gateway.napcatWebuiUrl = primary.webuiUrl;
  gateway.napcatAccessToken = primary.accessToken;
  gateway.napcatWebuiToken = primary.webuiToken;
  return gateway;
}

export function addNapcatInstance(gateways, index) {
  const gateway = selectedGateway(gateways, index);
  const instance = createDefaultNapcatInstance(gateway);
  const next = updateSelectedGateway(gateways, index, (item) => {
    const rows = napcatInstanceRowsFor(item);
    rows.push(instance);
    item.napcatInstances = rows;
    return syncPrimaryNapcatFields(item);
  });
  const rows = napcatInstanceRowsFor(selectedGateway(next, index));
  return { gateways: next, index: Math.max(0, rows.findIndex((item) => item.id === instance.id)), instance };
}

export function setNapcatInstance(gateways, index, napcatIndex, patch) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rows = napcatInstanceRowsFor(gateway);
    if (!rows[napcatIndex]) throw new Error("当前没有可应用的 NapCat 实例。");
    const normalized = normalizeNapcatInstance({ ...rows[napcatIndex], ...patch }, napcatIndex, gateway);
    if (rows.some((item, itemIndex) => itemIndex !== napcatIndex && item.id === normalized.id)) {
      throw new Error(`NapCat 实例 ID 已存在：${normalized.id}`);
    }
    rows[napcatIndex] = normalized;
    gateway.napcatInstances = rows;
    return syncPrimaryNapcatFields(gateway);
  });
}

export function removeNapcatInstance(gateways, index, napcatIndex) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rows = napcatInstanceRowsFor(gateway);
    if (!rows[napcatIndex]) return gateway;
    rows.splice(napcatIndex, 1);
    gateway.napcatInstances = rows;
    return rows.length ? syncPrimaryNapcatFields(gateway) : gateway;
  });
}

export function routeVariableRowsFor(gateway) {
  const variables = gateway?.routeVariables && typeof gateway.routeVariables === "object" && !Array.isArray(gateway.routeVariables)
    ? gateway.routeVariables
    : {};
  return Object.keys(variables).sort().map((key) => ({ key, value: String(variables[key] ?? "") }));
}

export function routeKindListFor(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[,\s，、]+/);
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

export function normalizeNotificationRule(rule, index = 0) {
  const raw = rule && typeof rule === "object" && !Array.isArray(rule) ? rule : {};
  const fallbackId = `rule-${index + 1}`;
  const id = String(raw.id || "").trim() || fallbackId;
  const schedules = Array.isArray(raw.schedules)
    ? raw.schedules.map((schedule, scheduleIndex) => normalizeNotificationSchedule(schedule, scheduleIndex))
    : undefined;
  return {
    id,
    name: String(raw.name || raw.id || `规则 ${index + 1}`).trim(),
    enabled: raw.enabled !== false,
    routeKinds: routeKindListFor(raw.routeKinds),
    targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId : "",
    allowedSpeakerNames: Array.isArray(raw.allowedSpeakerNames)
      ? routeKindListFor(raw.allowedSpeakerNames)
      : [],
    regex: typeof raw.regex === "string" ? raw.regex : "",
    schedules,
    template: typeof raw.template === "string" ? raw.template : ""
  };
}

export function normalizeScheduleType(value) {
  return value === "daily_time" || value === "once_at" || value === "interval" ? value : "interval";
}

export function normalizePositiveNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}

export function normalizeNotificationSchedule(schedule, index = 0) {
  const raw = schedule && typeof schedule === "object" && !Array.isArray(schedule) ? schedule : {};
  const type = normalizeScheduleType(raw.type);
  const result = {
    id: String(raw.id || "").trim() || `schedule-${index + 1}`,
    name: typeof raw.name === "string" ? raw.name : `计划 ${index + 1}`,
    enabled: raw.enabled !== false,
    type
  };
  if (type === "interval") {
    result.intervalSeconds = normalizePositiveNumber(raw.intervalSeconds, 900);
    if (typeof raw.windowStartTime === "string" && raw.windowStartTime.trim()) result.windowStartTime = raw.windowStartTime.trim();
    if (typeof raw.windowEndTime === "string" && raw.windowEndTime.trim()) result.windowEndTime = raw.windowEndTime.trim();
  } else if (type === "daily_time") {
    if (typeof raw.timeOfDay === "string" && raw.timeOfDay.trim()) result.timeOfDay = raw.timeOfDay.trim();
  } else if (type === "once_at") {
    if (typeof raw.onceAt === "string" && raw.onceAt.trim()) result.onceAt = raw.onceAt.trim();
  }
  return result;
}

export function notificationRuleRowsFor(gateway) {
  const rules = Array.isArray(gateway?.notificationRules) ? gateway.notificationRules : [];
  return rules.map((rule, index) => normalizeNotificationRule(rule, index));
}

export function selectedNotificationRule(gateway, ruleIndex) {
  const rows = notificationRuleRowsFor(gateway);
  if (!rows.length) return null;
  return rows[Math.max(0, Math.min(ruleIndex, rows.length - 1))] || null;
}

export function notificationScheduleRowsFor(gateway, ruleIndex) {
  const rule = selectedNotificationRule(gateway, ruleIndex);
  return Array.isArray(rule?.schedules)
    ? rule.schedules.map((schedule, index) => normalizeNotificationSchedule(schedule, index))
    : [];
}

export function nextNotificationRuleNumber(gateway) {
  const used = new Set(notificationRuleRowsFor(gateway).map((rule) => rule.name));
  let next = notificationRuleRowsFor(gateway).length + 1;
  while (used.has(`规则 ${next}`)) next += 1;
  return next;
}

export function createDefaultNotificationRule(gateway) {
  const next = nextNotificationRuleNumber(gateway);
  return {
    id: `rule-aiui-${Date.now().toString(36)}-${next}`,
    name: `规则 ${next}`,
    enabled: true,
    routeKinds: [],
    targetGroupId: "",
    allowedSpeakerNames: [],
    regex: "",
    template: ""
  };
}

export function nextNotificationScheduleNumber(gateway, ruleIndex) {
  const used = new Set(notificationScheduleRowsFor(gateway, ruleIndex).map((schedule) => schedule.name));
  let next = notificationScheduleRowsFor(gateway, ruleIndex).length + 1;
  while (used.has(`计划 ${next}`)) next += 1;
  return next;
}

export function createDefaultNotificationSchedule(gateway, ruleIndex) {
  const next = nextNotificationScheduleNumber(gateway, ruleIndex);
  return {
    id: `schedule-aiui-${Date.now().toString(36)}-${next}`,
    name: `计划 ${next}`,
    enabled: true,
    type: "interval",
    intervalSeconds: normalizePositiveNumber(gateway?.heartbeatIntervalSeconds, 900)
  };
}

export function addNotificationRule(gateways, index) {
  const gateway = selectedGateway(gateways, index);
  const rule = createDefaultNotificationRule(gateway);
  const next = updateSelectedGateway(gateways, index, (item) => {
    const rules = notificationRuleRowsFor(item);
    rules.push(rule);
    item.notificationRules = rules;
    return item;
  });
  const rows = notificationRuleRowsFor(selectedGateway(next, index));
  return { gateways: next, index: Math.max(0, rows.findIndex((item) => item.id === rule.id)), rule };
}

export function setNotificationRule(gateways, index, ruleIndex, patch) {
  const normalizedPatch = { ...patch };
  if ("routeKinds" in normalizedPatch) normalizedPatch.routeKinds = routeKindListFor(normalizedPatch.routeKinds);
  if ("allowedSpeakerNames" in normalizedPatch) normalizedPatch.allowedSpeakerNames = routeKindListFor(normalizedPatch.allowedSpeakerNames);
  if ("regex" in normalizedPatch) {
    const regex = String(normalizedPatch.regex || "");
    if (regex && !/\{[A-Za-z0-9_]+\}/.test(regex)) {
      try {
        new RegExp(regex);
      } catch (error) {
        throw new Error(`规则正则无效：${error.message || error}`);
      }
    }
    normalizedPatch.regex = regex;
  }
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rules = notificationRuleRowsFor(gateway);
    if (!rules[ruleIndex]) throw new Error("当前没有可应用的通知规则。");
    rules[ruleIndex] = normalizeNotificationRule({ ...rules[ruleIndex], ...normalizedPatch }, ruleIndex);
    gateway.notificationRules = rules;
    return gateway;
  });
}

export function removeNotificationRule(gateways, index, ruleIndex) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rules = notificationRuleRowsFor(gateway);
    if (!rules[ruleIndex]) return gateway;
    rules.splice(ruleIndex, 1);
    gateway.notificationRules = rules;
    return gateway;
  });
}

export function addNotificationSchedule(gateways, index, ruleIndex) {
  const gateway = selectedGateway(gateways, index);
  const schedule = createDefaultNotificationSchedule(gateway, ruleIndex);
  const next = updateSelectedGateway(gateways, index, (item) => {
    const rules = notificationRuleRowsFor(item);
    if (!rules[ruleIndex]) throw new Error("请先选择通知规则。");
    const schedules = notificationScheduleRowsFor(item, ruleIndex);
    schedules.push(schedule);
    rules[ruleIndex].schedules = schedules;
    item.notificationRules = rules;
    return item;
  });
  const rows = notificationScheduleRowsFor(selectedGateway(next, index), ruleIndex);
  return { gateways: next, index: Math.max(0, rows.findIndex((item) => item.id === schedule.id)), schedule };
}

export function setNotificationSchedule(gateways, index, ruleIndex, scheduleIndex, patch) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rules = notificationRuleRowsFor(gateway);
    if (!rules[ruleIndex]) throw new Error("请先选择通知规则。");
    const schedules = notificationScheduleRowsFor(gateway, ruleIndex);
    if (!schedules[scheduleIndex]) throw new Error("当前没有可应用的通知计划。");
    schedules[scheduleIndex] = normalizeNotificationSchedule({ ...schedules[scheduleIndex], ...patch }, scheduleIndex);
    rules[ruleIndex].schedules = schedules;
    gateway.notificationRules = rules;
    return gateway;
  });
}

export function removeNotificationSchedule(gateways, index, ruleIndex, scheduleIndex) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const rules = notificationRuleRowsFor(gateway);
    if (!rules[ruleIndex]) return gateway;
    const schedules = notificationScheduleRowsFor(gateway, ruleIndex);
    if (!schedules[scheduleIndex]) return gateway;
    schedules.splice(scheduleIndex, 1);
    rules[ruleIndex].schedules = schedules;
    gateway.notificationRules = rules;
    return gateway;
  });
}

export function nextRouteVariableKey(gateway) {
  const used = new Set(routeVariableRowsFor(gateway).map((row) => row.key));
  let next = 1;
  while (used.has(`Variable${next}`)) next += 1;
  return `Variable${next}`;
}

export function setRouteVariable(gateways, index, oldKey, key, value) {
  const nextKey = String(key || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nextKey)) {
    throw new Error("变量名必须以字母或下划线开头，只能包含字母、数字和下划线。");
  }
  return updateSelectedGateway(gateways, index, (gateway) => {
    const variables = gateway.routeVariables && typeof gateway.routeVariables === "object" && !Array.isArray(gateway.routeVariables)
      ? { ...gateway.routeVariables }
      : {};
    const previousKey = String(oldKey || "").trim();
    if (previousKey && previousKey !== nextKey) delete variables[previousKey];
    variables[nextKey] = String(value ?? "");
    gateway.routeVariables = variables;
    return gateway;
  });
}

export function addRouteVariable(gateways, index) {
  const gateway = selectedGateway(gateways, index);
  const key = nextRouteVariableKey(gateway);
  const next = setRouteVariable(gateways, index, "", key, "");
  const rows = routeVariableRowsFor(selectedGateway(next, index));
  return { gateways: next, index: Math.max(0, rows.findIndex((row) => row.key === key)), key };
}

export function removeRouteVariable(gateways, index, key) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const variables = gateway.routeVariables && typeof gateway.routeVariables === "object" && !Array.isArray(gateway.routeVariables)
      ? { ...gateway.routeVariables }
      : {};
    delete variables[String(key || "").trim()];
    gateway.routeVariables = variables;
    return gateway;
  });
}

export function fieldValueFor(gateway, field) {
  if (!gateway || !field) return "";
  const value = gateway[field.key];
  if (field.type === "boolean") return value === true ? "true" : value === false ? "false" : "";
  return value == null ? "" : String(value);
}

export function jsonValueFor(gateway, field) {
  if (!gateway || !field) return "";
  const value = gateway[field.key];
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function parseFieldValue(field, rawValue) {
  const text = String(rawValue ?? "").trim();
  if (field.type === "number") {
    if (!text) return undefined;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${field.label} 必须是数字。`);
    return value;
  }
  if (field.type === "boolean") {
    if (!text) return undefined;
    if (/^(true|1|yes|on|启用|是)$/i.test(text)) return true;
    if (/^(false|0|no|off|禁用|否)$/i.test(text)) return false;
    throw new Error(`${field.label} 必须是 true/false。`);
  }
  return String(rawValue ?? "");
}

export function parseJsonValue(field, rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${field.label} 不是有效 JSON：${error.message || error}`);
  }
}

export function setScalarField(gateways, index, field, rawValue) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const parsed = parseFieldValue(field, rawValue);
    if (parsed === undefined) delete gateway[field.key];
    else gateway[field.key] = parsed;
    return gateway;
  });
}

export function setJsonField(gateways, index, field, rawValue) {
  return updateSelectedGateway(gateways, index, (gateway) => {
    const parsed = parseJsonValue(field, rawValue);
    if (parsed === undefined) delete gateway[field.key];
    else gateway[field.key] = parsed;
    return gateway;
  });
}

export function truncateText(value, maxLength = 96) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function fieldSummary(field, value) {
  if (!field) return "未选择字段";
  const display = truncateText(value);
  return `${field.label} = ${display || "空"}`;
}

export function configSummary(gateways, index, runtimeRows = []) {
  const gateway = selectedGateway(gateways, index);
  if (!gateway) {
    return {
      gatewayLabel: "未读取 WebGUI 配置",
      gatewayMeta: "连接 PC 后读取",
      messageAdapterText: "-",
      agentAdapterText: "-",
      runtimeText: "-",
      dirtyText: "未加载"
    };
  }
  const runtime = runtimeRows.find((row) => row.id === gateway.id) || {};
  const messages = messageAdaptersFor(gateway)
    .map((id) => MESSAGE_ADAPTERS.find((item) => item.id === id)?.label || id)
    .join(" + ");
  return {
    gatewayLabel: routeLabel(gateway),
    gatewayMeta: `${gateway.enabled === false ? "禁用" : "启用"} · ${configNameFor(gateway)}`,
    messageAdapterText: gateway.messageInputsDisabled ? `已禁用 · ${messages || "-"}` : (messages || "-"),
    agentAdapterText: agentAdaptersFor(gateway).join(" + ") || "-",
    runtimeText: runtime.running ? "运行中" : gateway.enabled === false ? "禁用中" : "未运行",
    dirtyText: "已加载"
  };
}
