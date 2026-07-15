import fs from "node:fs";
import path from "node:path";
import { config, type NotificationRule } from "../config.js";
import { resolvePipeline, type ResolvedPipeline } from "../pipelines.js";
import { indexLines, roleKnowledgeSnapshot } from "../roleKnowledge.js";
import { toProjectRelativePath } from "../shared/projectPaths.js";
import type { ForwardTemplateValues } from "./types.js";
import type { RouteDecision } from "./routeDecision.js";
import {
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isRolePanelRecord,
  isWeComRecord,
  isVoiceTranscriptRecord
} from "./routeDecision.js";

export type AgentRoleContext = {
  roleId: string;
  roleDir: string;
  rolePath: string;
  dataDir: string;
};

export type AgentPacket = {
  rule: NotificationRule;
  templateValues: ForwardTemplateValues;
  message: string;
};

type RecentMessageItem = {
  time: number;
  source: string;
  sender?: string;
  target?: string;
  text: string;
  messageId?: string | number;
};

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function relativeWorkspacePath(filePath: string | undefined): string | undefined {
  return toProjectRelativePath(filePath, process.cwd());
}

function currentTimeValues(now = new Date()): ForwardTemplateValues {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = pad2(now.getHours());
  const minute = pad2(now.getMinutes());
  const second = pad2(now.getSeconds());
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  return {
    now: now.toLocaleString("zh-CN", { hour12: false }),
    currentTime: now.toLocaleString("zh-CN", { hour12: false }),
    currentDate: `${year}-${month}-${day}`,
    currentClock: `${hour}:${minute}:${second}`,
    currentIsoTime: now.toISOString(),
    currentTimestamp: Math.floor(now.getTime() / 1000),
    currentYear: year,
    currentMonth: month,
    currentDay: day,
    currentWeekday: weekdays[now.getDay()],
    currentHour: hour,
    currentMinute: minute,
    currentSecond: second
  };
}
function renderTemplate(template: string, values: ForwardTemplateValues): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value == null ? match : String(value);
  });
}

function appendAgentRoleReference(message: string, rolePath: string): string {
  if (!rolePath) {
    return message;
  }

  return `${message.trimEnd()}\n\n请遵循角色文件：${rolePath} 进行回复。`;
}

function optionalLine(label: string, value: unknown): string {
  return value == null || value === "" ? "" : `${label}：${value}`;
}

function replyDeliveryLines(values: ForwardTemplateValues, forceMessagePipeline = false): string[] {
  const outputAdapter = String(values.outputAdapter ?? "");
  const routeKind = String(values.routeKind ?? "");
  const replyApiUrl = String(values.replyApiUrl ?? "");
  const replyContextJson = String(values.replyContextJson ?? "");
  const replyToSource = String(values.replyToSource ?? "").toLowerCase() === "true";

  if (!replyApiUrl || !replyContextJson) {
    return [];
  }

  const shouldExplainReplyApi = forceMessagePipeline
    || replyToSource
    || (outputAdapter === "fennenote" && routeKind === "voice_transcript")
    || routeKind === "rabilink";
  if (!shouldExplainReplyApi) return [];

  const intro = forceMessagePipeline
    ? [
        "当前路由未绑定人格。凡是要对消息来源说出的自然语言回复，都必须先 POST 到普通回复 API，由 RabiRoute 投递到对应消息管道；不能只在 Codex 线程里写最终文本。",
        "不要扮演角色，也不要把当前 Codex 可见最终文本当成已经发回消息端。"
      ]
    : routeKind === "rabilink"
      ? [
          "本次来自 RabiLink Relay，不能只在 Codex 线程里写最终文本。",
          "如果判断需要回应，请把要写回 Rokid/灵珠侧的短句 POST 到普通回复 API；RabiRoute 会把它放入 RabiLink 下行消息队列。"
        ]
      : outputAdapter === "fennenote" && routeKind === "voice_transcript"
      ? [
          "本次是语音对话回复，不能只在 Codex 线程里写最终文本。",
          "如果判断需要回应，请把要播出的短句 POST 到普通回复 API；RabiRoute 会转给 FenneNote/OumuQ 播放，并写入转写预览。"
        ]
      : [
          "如果判断需要回应消息来源，请把回复 POST 到普通回复 API；RabiRoute 会按当前管道投递。"
        ];

  return [
    ...intro,
    "请求体必须包含 text 和 replyContext，其中 replyContext 使用上方“当前回复上下文”的 JSON 原样传入。",
    "示例：",
    "```json",
    JSON.stringify({
      text: "这里填写夜雨要说的话。",
      replyContext: JSON.parse(replyContextJson)
    }, null, 2),
    "```",
    "API 调用成功后，可见最终回复只需同步已投递的简短结果；如果决定不对消息来源回复，请说明保持安静或不回传的原因。"
  ];
}

function directMessageModeLines(values: ForwardTemplateValues): string[] {
  return [
    "当前路由没有绑定任何人格，这是无人格直通模式。",
    "不要扮演角色，不读取或更新角色计划、记忆、技能，也不要提示需要配置人格。",
    optionalLine("消息来源", values.messageTarget),
    optionalLine("发送者", values.sender),
    optionalLine("输入适配器", values.inputAdapter),
    optionalLine("输出适配器", values.outputAdapter),
    "只根据本次消息、日志路径和路由变量处理任务。",
    "需要对消息来源说出的每一句话，都通过“回传”里的普通回复 API 投递到 RabiRoute；RabiRoute 会按 replyContext 送回对应消息管道。"
  ];
}

function section(title: string, lines: string[]): string {
  const content = lines.filter((line) => line !== "").join("\n").trim();
  return content ? `[${title}]\n${content}` : "";
}

function parseJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function messageText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function recentMessageItems(dataDir: string, limit: number): RecentMessageItem[] {
  if (!dataDir || limit <= 0) {
    return [];
  }

  const groupMessages = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "group-messages.jsonl"))
    .map((item) => ({
      time: Number(item.time) || 0,
      source: "群聊",
      sender: messageText(item.senderName || item.userId),
      target: item.groupId == null ? undefined : `群 ${item.groupId}`,
      text: messageText(item.rawMessage),
      messageId: item.messageId as string | number | undefined
    }));
  const privateMessages = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "private-messages.jsonl"))
    .map((item) => ({
      time: Number(item.time) || 0,
      source: "私聊",
      sender: messageText(item.senderName || item.userId),
      target: item.userId == null ? undefined : `用户 ${item.userId}`,
      text: messageText(item.rawMessage),
      messageId: item.messageId as string | number | undefined
    }));
  const wecomMessages = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "wecom-messages.jsonl"))
    .map((item) => ({
      time: Number(item.time) || 0,
      source: "企业微信",
      sender: messageText(item.senderName || item.senderId || item.userId),
      target: messageText(item.groupId || item.chatId || item.conversationId),
      text: messageText(item.rawMessage),
      messageId: item.messageId as string | number | undefined
    }));
  const voiceTranscripts = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "voice-transcripts.jsonl"))
    .map((item) => ({
      time: Number(item.time) || 0,
      source: "语音转写",
      sender: messageText(item.speakerName || item.senderName || item.source),
      target: messageText(item.sourceDeviceName || item.sourceDeviceId || item.source),
      text: messageText(item.rawMessage),
      messageId: item.messageId as string | number | undefined
    }));

  return [...groupMessages, ...privateMessages, ...wecomMessages, ...voiceTranscripts]
    .filter((item) => item.text)
    .sort((left, right) => left.time - right.time)
    .slice(-limit);
}

function recentMessagesText(dataDir: string, limit: number): string {
  const items = recentMessageItems(dataDir, limit);
  if (items.length === 0) {
    return "- 暂无";
  }

  return items.map((item) => {
    const parts = [
      item.time ? formatTime(item.time) : "",
      item.source,
      item.target,
      item.sender ? `发送者：${item.sender}` : "",
      item.messageId != null ? `messageId=${item.messageId}` : ""
    ].filter(Boolean);
    return `- ${parts.join(" | ")}\n  ${item.text}`;
  }).join("\n");
}

function extractPlanIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bplan-[a-zA-Z0-9_-]+\b/g)].map((match) => match[0]))];
}

function readReferencedPlanSummaries(roleDir: string, text: string): string[] {
  if (!roleDir) {
    return [];
  }

  const summaries: string[] = [];
  for (const planId of extractPlanIds(text)) {
    const candidates = [
      path.join(roleDir, "plans", "items", "active", `${planId}.json`),
      path.join(roleDir, "plans", "items", "archived", `${planId}.json`),
      path.join(roleDir, "plans", `${planId}.json`)
    ];
    const planPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!planPath) {
      summaries.push(`- ${planId}：未找到对应计划文件。`);
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
      summaries.push([
        `- ${planId}`,
        optionalLine("  标题", parsed.title),
        optionalLine("  状态", parsed.status),
        optionalLine("  当前步骤", parsed.currentStep),
        optionalLine("  下一步", parsed.nextAction),
        optionalLine("  等待", parsed.waitingFor),
        `  路径：${relativeWorkspacePath(planPath)}`
      ].filter(Boolean).join("\n"));
    } catch (error) {
      summaries.push(`- ${planId}：读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summaries;
}

function roleApiBase(roleId: unknown): string {
  const id = String(roleId || ":roleId");
  return `/api/roles/${id === ":roleId" ? id : encodeURIComponent(id)}`;
}

function planMemoryApiHint(roleId: unknown): string[] {
  const base = roleApiBase(roleId);
  return [
    "可用 API 提示：",
    `- 查看/更新计划：GET ${base}/plans、GET ${base}/plans/{planId}、POST ${base}/plans、PATCH ${base}/plans/{planId}`,
    `- 查看记忆：GET ${base}/memory、GET ${base}/memory/recent、GET ${base}/memory/recent/{memoryId}、GET ${base}/memory/consolidated、GET ${base}/memory/consolidated/{memoryId}`,
    `- 查看角色技能：GET ${base}/skills、GET ${base}/skills/{skillId}`,
    `- 新增近期记忆：POST ${base}/memory/recent`,
    `- 更新指定近期记忆：PATCH ${base}/memory/recent/{memoryId}`,
    "- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；相关记忆进入处理前确认队列时会刷新 viewedAt"
  ];
}

function remoteAgentApiHint(values: ForwardTemplateValues): string[] {
  const managerPort = process.env.GATEWAY_MANAGER_PORT ?? "8790";
  const baseUrl = `http://127.0.0.1:${managerPort}`;
  const gatewayId = String(values.gatewayId || values.runtimeRouteId || "");
  const replyContext = String(values.replyContextJson || "{}");
  const defaultDeviceId = String(values.remoteAgentDefaultDeviceId || config.remoteAgentDefaultDeviceId || "").trim();
  const defaultCwd = String(values.remoteAgentDefaultCwd || config.remoteAgentDefaultCwd || "").trim();
  const defaultThreadName = String(values.remoteAgentDefaultThreadName || config.remoteAgentDefaultThreadName || "").trim();
  return [
    "远端 Agent 设备 API：",
    `- 查看在线远端 Agent 设备：GET ${baseUrl}/api/remote-agent/devices`,
    `- 投递远端任务：POST ${baseUrl}/api/remote-agent/tasks`,
    defaultDeviceId ? `- 当前路由默认远端设备 deviceId：${defaultDeviceId}` : "",
    defaultCwd ? `- 当前路由默认远端 cwd：${defaultCwd}` : "",
    defaultThreadName ? `- 当前路由默认远端线程：${defaultThreadName}` : "",
    "投递请求示例：",
    JSON.stringify({
      originGatewayId: gatewayId,
      deviceId: defaultDeviceId || "<从 devices 里选择；如果当前路由已设置默认设备，也可省略>",
      taskKind: "build-desktop",
      cwd: defaultCwd || "<远端工作目录，可省略使用设备默认值>",
      threadName: defaultThreadName || "<远端 Agent 线程名，可省略使用设备默认值>",
      message: "请在远端执行任务，完成后按提示回传结果。",
      filePaths: ["<可选：本机要随任务传给远端的文件路径>"],
      originReplyContext: "__replyContextJson__"
    }, null, 2).replace("\"__replyContextJson__\"", replyContext),
    "- 可选文件传输：请求体可传 filePaths、files 或 attachments；manager 会把文件内容随任务发给远端 bridge。",
    "- 远端回传文件：远端回调可以传 artifactPath、logPath 或 files，bridge 会把文件内容带回本机并保存到 data/remote-agent-files/<taskId>/。",
    "远端结果会回传到本机 RabiRoute，并投递回当前本机人格线程；远端 Agent 不应直接回复 QQ。"
  ];
}

function requiredReadTypeLabel(type: string): string {
  if (type === "plan") return "计划";
  if (type === "recent_memory") return "近期记忆";
  if (type === "consolidated_memory") return "沉淀记忆";
  if (type === "role_skill") return "角色技能";
  return type;
}

function skillIndexLines(roleId: unknown, items: Array<{ id: string; title: string; summary: string }>): string {
  if (items.length === 0) return "- 暂无";
  const base = roleApiBase(roleId);
  return items.map((item) => `- ${item.id}：${item.title} - ${item.summary}（GET ${base}/skills/${encodeURIComponent(item.id)}）`).join("\n");
}

function requiredReadLines(items: Array<{ id: string; title: string; type: string; endpoint: string; score: number }>): string[] {
  if (items.length === 0) {
    return [
      "本次没有高相关必读项。仍需先扫一遍上方可见的进行中计划、近期记忆和命中召回索引；如发现与当前处理有关的条目，请先按 ID 查询内容再行动。"
    ];
  }
  return [
    "以下条目与当前消息高相关。回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按 GET 路径读取每一项内容；不要只凭标题行动。",
    "如果任一必读项无法读取或内容不足以确认，请说明上下文无法确认，或先向用户追问。",
    "",
    ...items.map((item) => `- ${item.id}：${item.title}（${requiredReadTypeLabel(item.type)}，score=${item.score}） GET ${item.endpoint}`)
  ];
}

function eventTitleForRoute(routeKind: RouteDecision["routeKind"]): string {
  if (routeKind === "private") return "QQ 私聊消息提醒";
  if (routeKind === "group_message") return "QQ 群聊消息提醒";
  if (routeKind === "direct_at") return "QQ 群聊直接提醒";
  if (routeKind === "direct_reply") return "QQ 直接回复提醒";
  if (routeKind === "indirect_reply") return "QQ 回复链提醒";
  if (routeKind === "heartbeat") return "定时心跳提醒";
  if (routeKind === "manual_trigger") return "手动触发提醒";
  if (routeKind === "role_panel_message") return "角色面板消息";
  if (routeKind === "voice_transcript") return "语音转写提醒";
  if (routeKind === "rabilink") return "RabiLink 消息";
  if (routeKind === "wecom_message") return "企业微信群聊消息提醒";
  return "RabiRoute 消息提醒";
}

function outputPipelineForDecision(decision: RouteDecision): ResolvedPipeline {
  const record = decision.record;
  const pipeline = decision.route.resolvedPipeline ?? config.resolvedPipeline;
  if (
    decision.routeKind === "voice_transcript" &&
    isVoiceTranscriptRecord(record) &&
    (record.adapterType === "fennenote" || record.source === "fennenote")
  ) {
    return resolvePipeline("voice_chat", {
      inputAdapter: "fennenote",
      ttsVoice: pipeline.ttsVoice,
      ttsWorkerUrl: pipeline.outputAdapter === "fennenote" && pipeline.ttsWorkerUrl ? pipeline.ttsWorkerUrl : undefined
    });
  }
  return pipeline;
}

function templateValuesForDecision(decision: RouteDecision, roleContext: AgentRoleContext): ForwardTemplateValues {
  const record = decision.record;
  const route = decision.route;
  const isVoiceTranscript = isVoiceTranscriptRecord(record);
  const sender = isVoiceTranscript
    ? record.speakerName || record.senderName || record.source || "voice_transcript"
    : record.senderName || ("userId" in record ? record.userId : "RabiRoute");
  const isGroup = isGroupRecord(record);
  const isHeartbeat = isHeartbeatRecord(record);
  const isManualTrigger = isManualTriggerRecord(record);
  const isRolePanel = isRolePanelRecord(record);
  const isWeCom = isWeComRecord(record);
  const targetId = isGroup ? record.groupId : "userId" in record ? record.userId : isVoiceTranscript ? record.source ?? "webhook" : isManualTrigger ? record.triggerId ?? "manual_trigger" : isRolePanel ? record.roleId ?? "rolePanel" : "heartbeat";
  const wecomGroupId = isWeCom ? record.groupId ?? record.chatId ?? record.conversationId : undefined;
  const targetType = isGroup || isWeCom ? "group" : isHeartbeat ? "heartbeat" : isManualTrigger ? "manual_trigger" : isRolePanel ? "role_panel" : isVoiceTranscript ? decision.routeKind === "rabilink" ? "rabilink" : "voice_transcript" : "private";
  const pipeline = outputPipelineForDecision(decision);
  const replyApiPath = "/api/agent/replies";
  const replyApiUrl = `http://127.0.0.1:${process.env.GATEWAY_MANAGER_PORT ?? "8790"}${replyApiPath}`;
  const dataDirPath = relativeWorkspacePath(roleContext.dataDir);
  const roleDirPath = relativeWorkspacePath(roleContext.roleDir);
  const rolePath = relativeWorkspacePath(roleContext.rolePath);
  const groupLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, isWeCom ? "wecom-messages.jsonl" : "group-messages.jsonl"));
  const privateLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "private-messages.jsonl"));
  const heartbeatLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "heartbeat-events.jsonl"));
  const manualTriggerLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "manual-trigger-events.jsonl"));
  const rolePanelLogPath = relativeWorkspacePath(path.join(roleContext.roleDir || roleContext.dataDir, "role-panel", "messages.jsonl"));
  const voiceTranscriptLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "voice-transcripts.jsonl"));
  const replyContext = {
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: route.id,
    routeProfileName: route.name,
    routeKind: decision.routeKind,
    targetType,
    messageId: record.messageId,
    groupId: isGroup ? record.groupId : wecomGroupId,
    userId: "userId" in record ? record.userId : undefined,
    targetGroupId: config.targetGroupId || undefined,
    instanceId: "instanceId" in record ? record.instanceId : undefined,
    adapterType: isRolePanel ? "rolePanel" : "adapterType" in record ? record.adapterType : undefined,
    speakerId: isVoiceTranscript ? record.speakerId : undefined,
    speakerName: isVoiceTranscript ? record.speakerName : undefined,
    speakerKind: isVoiceTranscript ? record.speakerKind : undefined,
    speakerConfidence: isVoiceTranscript ? record.speakerConfidence : undefined,
    speakerDecision: isVoiceTranscript ? record.speakerDecision : undefined,
    roleId: isRolePanel ? record.roleId : undefined,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    wecomReqId: isWeCom ? record.reqId : undefined,
    wecomConversationId: isWeCom ? record.conversationId : undefined,
    wecomChatId: isWeCom ? record.chatId : undefined,
    wecomSenderId: isWeCom ? record.senderId ?? record.userId : undefined,
    wecomMessageType: isWeCom ? record.messageType : undefined,
    dataDir: dataDirPath,
    groupLogPath,
    privateLogPath,
    replyApiUrl,
    outputAdapter: pipeline.outputAdapter,
    outputPipeline: pipeline.outputPipeline,
    replyToSource: pipeline.replyToSource
  };
  return {
    ...decision.routeVariables,
    ...currentTimeValues(),
    time: formatTime(record.time),
    sender,
    senderName: record.senderName,
    userId: "userId" in record ? record.userId : undefined,
    groupId: isGroup ? record.groupId : wecomGroupId,
    targetType,
    targetId: isWeCom ? wecomGroupId : targetId,
    messageTarget: isWeCom ? `企业微信群 ${wecomGroupId ?? "unknown"}` : isGroup ? `群 ${targetId}` : isHeartbeat ? "RabiRoute 心跳" : isManualTrigger ? `手动触发 ${targetId}` : isRolePanel ? `角色面板 ${targetId}` : isVoiceTranscript ? decision.routeKind === "rabilink" ? `RabiLink ${targetId}` : `语音转写 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    routeText: decision.routeText,
    repliedRouteText: decision.repliedRouteText,
    messageId: record.messageId,
    botNickname: config.botNickname,
    agentRoleId: roleContext.roleId,
    recentMessageLimit: route.recentMessageLimit,
    recentMessages: recentMessagesText(roleContext.dataDir, route.recentMessageLimit),
    routeProfileId: route.id,
    routeProfileName: route.name,
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    targetGroupId: config.targetGroupId,
    agentRolePath: rolePath,
    remoteAgentDefaultDeviceId: config.remoteAgentDefaultDeviceId,
    remoteAgentDefaultCwd: config.remoteAgentDefaultCwd,
    remoteAgentDefaultThreadName: config.remoteAgentDefaultThreadName,
    agentRoleDir: roleDirPath,
    plansDir: relativeWorkspacePath(roleContext.roleDir ? path.join(roleContext.roleDir, "plans") : undefined),
    memoryDir: relativeWorkspacePath(roleContext.roleDir ? path.join(roleContext.roleDir, "memory") : undefined),
    agentInterfaceDocPath: relativeWorkspacePath(path.join(process.cwd(), "docs", "rabi-agent-interfaces.md")),
    replyApiPath,
    replyApiUrl,
    replyContextJson: JSON.stringify(replyContext),
    dataDir: dataDirPath,
    pipelinePreset: pipeline.id,
    channelPreset: pipeline.id,
    inputAdapter: pipeline.inputAdapter,
    outputAdapter: pipeline.outputAdapter,
    outputPipeline: pipeline.outputPipeline,
    promptOutputMode: pipeline.promptOutputMode,
    ttsProvider: pipeline.ttsProvider,
    ttsVoice: pipeline.ttsVoice,
    ttsWorkerUrl: pipeline.ttsWorkerUrl,
    ttsPlay: String(pipeline.ttsPlay),
    preventFeedbackLoop: String(pipeline.preventFeedbackLoop),
    replyToSource: String(pipeline.replyToSource),
    groupLogPath,
    privateLogPath,
    heartbeatLogPath,
    manualTriggerLogPath,
    rolePanelLogPath,
    voiceTranscriptLogPath,
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    triggerId: isManualTrigger ? record.triggerId : undefined,
    triggerName: isManualTrigger ? record.triggerName : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    voiceSpeakerId: isVoiceTranscript ? record.speakerId : undefined,
    voiceSpeakerName: isVoiceTranscript ? record.speakerName : undefined,
    voiceSpeakerKind: isVoiceTranscript ? record.speakerKind : undefined,
    voiceSpeakerConfidence: isVoiceTranscript ? record.speakerConfidence : undefined,
    voiceSpeakerDecision: isVoiceTranscript ? record.speakerDecision : undefined,
    voiceSourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    voiceSourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    voiceSourceArea: isVoiceTranscript ? record.sourceArea : undefined,
    voiceSessionId: isVoiceTranscript ? record.sessionId : undefined,
    voiceStartedAt: isVoiceTranscript ? record.startedAt : undefined,
    voiceEndedAt: isVoiceTranscript ? record.endedAt : undefined,
    voiceDurationSeconds: isVoiceTranscript ? record.durationSeconds : undefined,
    voicePeak: isVoiceTranscript ? record.peak : undefined,
    wecomReqId: isWeCom ? record.reqId : undefined,
    wecomConversationId: isWeCom ? record.conversationId : undefined,
    wecomChatId: isWeCom ? record.chatId : undefined,
    wecomSenderId: isWeCom ? record.senderId ?? record.userId : undefined,
    wecomMessageType: isWeCom ? record.messageType : undefined
  };
}

function buildAgentMessage(
  decision: RouteDecision,
  values: ForwardTemplateValues,
  userTemplateText: string,
  rolePath: string,
  roleDir: string
): string {
  const record = decision.record;
  const routeKind = decision.routeKind;
  const shouldAttachMemoryConsolidation = routeKind === "manual_trigger" && String(values.triggerId || "") === "memory-consolidation";
  const hasPersona = Boolean(String(values.agentRoleId || "").trim() && roleDir);
  const referencedPlanSummaries = routeKind === "manual_trigger"
    ? readReferencedPlanSummaries(roleDir, userTemplateText)
    : [];
  const knowledge = hasPersona
    ? roleKnowledgeSnapshot(roleDir, String(values.message || ""), {
        roleId: String(values.agentRoleId || ""),
        includePendingConsolidation: shouldAttachMemoryConsolidation,
        consolidationTrigger: shouldAttachMemoryConsolidation ? "manual" : undefined,
        forceConsolidation: shouldAttachMemoryConsolidation
      })
    : null;
  const activePlanIndex = knowledge ? indexLines(knowledge.activePlans) : "- 暂无";
  const activeSkillIndex = knowledge ? skillIndexLines(values.agentRoleId, knowledge.activeSkills) : "- 暂无";
  const recentMemoryIndex = knowledge ? indexLines(knowledge.recentMemories) : "- 暂无";
  const matchedIndex = knowledge ? indexLines(knowledge.matchedItems) : "- 暂无";
  const matchedSkillIndex = knowledge ? skillIndexLines(values.agentRoleId, knowledge.matchedSkills) : "- 暂无";
  const requiredReadIndex = knowledge ? requiredReadLines(knowledge.requiredReadItems) : [];
  const pendingConsolidation = knowledge?.pendingConsolidation;
  const knowledgePlansDir = relativeWorkspacePath(knowledge?.plansDir);
  const knowledgeMemoryDir = relativeWorkspacePath(knowledge?.memoryDir);
  const knowledgeAgentInterfaceDocPath = relativeWorkspacePath(knowledge?.agentInterfaceDocPath);
  const recentMessageLimit = Number(values.recentMessageLimit ?? 0);
  const pendingConsolidationLines = pendingConsolidation
    ? [
        `runId：${pendingConsolidation.run.id}`,
        `结果回传 API：/api/roles/${values.agentRoleId}/memory/consolidation-runs/${pendingConsolidation.run.id}/result`,
        pendingConsolidation.run.instruction,
        "",
        ...pendingConsolidation.memories.map((memory) => `- ${memory.id}：${memory.title}\n  ${memory.content}`)
      ]
    : [];

  const blocks = [
    section("RabiRoute 事件", [
      `事件：${eventTitleForRoute(routeKind)}`,
      `路由类型：${routeKind}`,
      optionalLine("事件时间", values.time),
      optionalLine("当前时间", values.currentTime),
      optionalLine("来源", values.messageTarget),
      optionalLine("发送者", values.sender),
      optionalLine("说话人", values.voiceSpeakerName),
      optionalLine("说话人置信度", values.voiceSpeakerConfidence),
      optionalLine("说话人判定", values.voiceSpeakerDecision),
      optionalLine("触发 ID", values.triggerId),
      optionalLine("触发名称", values.triggerName)
    ]),
    section("消息", [String(values.message || record.rawMessage || "")]),
    recentMessageLimit > 0 ? section("最近消息", [
      `最近 ${recentMessageLimit} 条：`,
      String(values.recentMessages || "- 暂无")
    ]) : "",
    hasPersona ? section("角色和路径", [
      optionalLine("角色", values.agentRoleId),
      optionalLine("角色文件", values.agentRolePath || rolePath),
      optionalLine("角色目录", values.agentRoleDir || roleDir),
      optionalLine("运行数据目录", values.dataDir),
      optionalLine("计划目录", knowledgePlansDir ?? values.plansDir),
      optionalLine("记忆目录", knowledgeMemoryDir ?? values.memoryDir)
    ]) : section("无人格直通模式", directMessageModeLines(values)),
    hasPersona ? section("记忆与计划", [
      optionalLine("更新记忆与计划的说明文档", knowledgeAgentInterfaceDocPath ?? values.agentInterfaceDocPath),
      ...planMemoryApiHint(values.agentRoleId),
      "",
      "可用技能：",
      activeSkillIndex,
      "",
      "进行中计划：",
      activePlanIndex,
      "",
      "近期记忆：",
      recentMemoryIndex,
      "",
      "命中技能：",
      matchedSkillIndex,
      "",
      "命中召回：",
      matchedIndex
    ]) : "",
    hasPersona ? section("处理前上下文确认", requiredReadIndex) : "",
    section("日志", [
      optionalLine("群聊日志", values.groupLogPath),
      optionalLine("私聊日志", values.privateLogPath),
      optionalLine("心跳日志", values.heartbeatLogPath),
      optionalLine("手动触发日志", values.manualTriggerLogPath),
      optionalLine("角色面板记录", values.rolePanelLogPath),
      optionalLine("语音转写日志", values.voiceTranscriptLogPath)
    ]),
    section("回传", [
      optionalLine("普通回复 API", values.replyApiUrl),
      optionalLine("当前回复上下文", values.replyContextJson)
    ]),
    section("回复回传要求", replyDeliveryLines(values, !hasPersona)),
    config.messageAdapterTypes.includes("remoteAgent")
      ? section("远端 Agent 设备", remoteAgentApiHint(values))
      : "",
    pendingConsolidation ? section("待整理记忆", pendingConsolidationLines) : "",
    referencedPlanSummaries.length > 0 ? section("指定计划内容", referencedPlanSummaries) : "",
    routeKind === "manual_trigger" || routeKind === "heartbeat" ? section("事件执行要求", [
      routeKind === "manual_trigger"
        ? "这是一条人工点击的手动触发，不要只把消息写入线程后结束。"
        : "这是一条定时心跳触发，不要只把消息写入线程后结束。",
      "请在当前 Codex 会话中按事件和模板执行，并输出可见结果。",
      "如果没有需要继续处理的新事项，也请明确说明已检查范围、当前无新事项和下一步。",
      "如果因为规则限制不能执行，请明确说明不能执行的具体限制和下一步。"
    ]) : "",
    userTemplateText.trim() ? section("用户模板补充", [userTemplateText.trim()]) : ""
  ];

  return appendAgentRoleReference(blocks.filter(Boolean).join("\n\n"), hasPersona ? rolePath : "");
}

export function buildAgentPacket(decision: RouteDecision, rule: NotificationRule, roleContext: AgentRoleContext): AgentPacket {
  const templateValues = {
    ...templateValuesForDecision(decision, roleContext),
    ...decision.extraValues,
    routeKind: decision.routeKind
  };
  const userTemplateText = renderTemplate(rule.template, templateValues);
  const rolePath = relativeWorkspacePath(roleContext.rolePath) || "";
  const roleDir = relativeWorkspacePath(roleContext.roleDir) || "";

  return {
    rule,
    templateValues,
    message: buildAgentMessage(decision, templateValues, userTemplateText, rolePath, roleDir)
  };
}
