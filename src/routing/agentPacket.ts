import path from "node:path";
import { config, type NotificationRule } from "../config.js";
import { indexLines, roleKnowledgeSnapshot } from "../roleKnowledge.js";
import type { ForwardTemplateValues } from "./types.js";
import type { RouteDecision } from "./routeDecision.js";
import {
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isRolePanelRecord,
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

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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

function section(title: string, lines: string[]): string {
  const content = lines.filter((line) => line !== "").join("\n").trim();
  return content ? `[${title}]\n${content}` : "";
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
    `- 新增近期记忆：POST ${base}/memory/recent`,
    `- 更新指定近期记忆：PATCH ${base}/memory/recent/{memoryId}`,
    "- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；关键词命中召回会刷新 viewedAt"
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
  return "RabiRoute 消息提醒";
}

function templateValuesForDecision(decision: RouteDecision, roleContext: AgentRoleContext): ForwardTemplateValues {
  const record = decision.record;
  const route = decision.route;
  const sender = record.senderName || ("userId" in record ? record.userId : "RabiRoute");
  const isGroup = isGroupRecord(record);
  const isHeartbeat = isHeartbeatRecord(record);
  const isVoiceTranscript = isVoiceTranscriptRecord(record);
  const isManualTrigger = isManualTriggerRecord(record);
  const isRolePanel = isRolePanelRecord(record);
  const targetId = isGroup ? record.groupId : "userId" in record ? record.userId : isVoiceTranscript ? record.source ?? "webhook" : isManualTrigger ? record.triggerId ?? "manual_trigger" : isRolePanel ? record.roleId ?? "rolePanel" : "heartbeat";
  const targetType = isGroup ? "group" : isHeartbeat ? "heartbeat" : isManualTrigger ? "manual_trigger" : isRolePanel ? "role_panel" : isVoiceTranscript ? "voice_transcript" : "private";
  const pipeline = route.resolvedPipeline ?? config.resolvedPipeline;
  const replyApiPath = "/api/agent/replies";
  const replyApiUrl = `http://127.0.0.1:${process.env.GATEWAY_MANAGER_PORT ?? "8790"}${replyApiPath}`;
  const replyContext = {
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: route.id,
    routeProfileName: route.name,
    routeKind: decision.routeKind,
    targetType,
    messageId: record.messageId,
    groupId: isGroup ? record.groupId : undefined,
    userId: "userId" in record ? record.userId : undefined,
    targetGroupId: config.targetGroupId || undefined,
    instanceId: "instanceId" in record ? record.instanceId : undefined,
    adapterType: isRolePanel ? "rolePanel" : "adapterType" in record ? record.adapterType : undefined,
    roleId: isRolePanel ? record.roleId : undefined,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    dataDir: roleContext.dataDir,
    groupLogPath: path.join(roleContext.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(roleContext.dataDir, "private-messages.jsonl"),
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
    groupId: isGroup ? record.groupId : undefined,
    targetType,
    targetId,
    messageTarget: isGroup ? `群 ${targetId}` : isHeartbeat ? "RabiRoute 心跳" : isManualTrigger ? `手动触发 ${targetId}` : isRolePanel ? `角色面板 ${targetId}` : isVoiceTranscript ? `语音转写 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    routeText: decision.routeText,
    repliedRouteText: decision.repliedRouteText,
    messageId: record.messageId,
    botNickname: config.botNickname,
    agentRoleId: roleContext.roleId,
    routeProfileId: route.id,
    routeProfileName: route.name,
    runtimeRouteId: process.env.GATEWAY_ID,
    gatewayId: process.env.GATEWAY_ID,
    targetGroupId: config.targetGroupId,
    agentRolePath: roleContext.rolePath,
    agentRoleDir: roleContext.roleDir,
    plansDir: roleContext.roleDir ? path.join(roleContext.roleDir, "plans") : undefined,
    memoryDir: roleContext.roleDir ? path.join(roleContext.roleDir, "memory") : undefined,
    agentInterfaceDocPath: path.join(process.cwd(), "docs", "rabi-agent-interfaces.md"),
    replyApiPath,
    replyApiUrl,
    replyContextJson: JSON.stringify(replyContext),
    dataDir: roleContext.dataDir,
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
    groupLogPath: path.join(roleContext.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(roleContext.dataDir, "private-messages.jsonl"),
    heartbeatLogPath: path.join(roleContext.dataDir, "heartbeat-events.jsonl"),
    manualTriggerLogPath: path.join(roleContext.dataDir, "manual-trigger-events.jsonl"),
    rolePanelLogPath: path.join(roleContext.roleDir || roleContext.dataDir, "role-panel", "messages.jsonl"),
    voiceTranscriptLogPath: path.join(roleContext.dataDir, "voice-transcripts.jsonl"),
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    triggerId: isManualTrigger ? record.triggerId : undefined,
    triggerName: isManualTrigger ? record.triggerName : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    voiceSourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    voiceSourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    voiceSourceArea: isVoiceTranscript ? record.sourceArea : undefined,
    voiceSessionId: isVoiceTranscript ? record.sessionId : undefined,
    voiceStartedAt: isVoiceTranscript ? record.startedAt : undefined,
    voiceEndedAt: isVoiceTranscript ? record.endedAt : undefined,
    voiceDurationSeconds: isVoiceTranscript ? record.durationSeconds : undefined,
    voicePeak: isVoiceTranscript ? record.peak : undefined
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
  const knowledge = roleDir
    ? roleKnowledgeSnapshot(roleDir, String(values.message || ""), {
        includePendingConsolidation: shouldAttachMemoryConsolidation,
        consolidationTrigger: shouldAttachMemoryConsolidation ? "manual" : undefined,
        forceConsolidation: shouldAttachMemoryConsolidation
      })
    : null;
  const activePlanIndex = knowledge ? indexLines(knowledge.activePlans) : "- 暂无";
  const recentMemoryIndex = knowledge ? indexLines(knowledge.recentMemories) : "- 暂无";
  const matchedIndex = knowledge ? indexLines(knowledge.matchedItems) : "- 暂无";
  const pendingConsolidation = knowledge?.pendingConsolidation;
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
      optionalLine("触发 ID", values.triggerId),
      optionalLine("触发名称", values.triggerName)
    ]),
    section("消息", [String(values.message || record.rawMessage || "")]),
    section("角色和路径", [
      optionalLine("角色", values.agentRoleId),
      optionalLine("角色文件", values.agentRolePath || rolePath),
      optionalLine("角色目录", values.agentRoleDir || roleDir),
      optionalLine("运行数据目录", values.dataDir),
      optionalLine("计划目录", knowledge?.plansDir ?? values.plansDir),
      optionalLine("记忆目录", knowledge?.memoryDir ?? values.memoryDir)
    ]),
    section("记忆与计划", [
      optionalLine("更新记忆与计划的说明文档", knowledge?.agentInterfaceDocPath ?? values.agentInterfaceDocPath),
      ...planMemoryApiHint(values.agentRoleId),
      "",
      "进行中计划：",
      activePlanIndex,
      "",
      "近期记忆：",
      recentMemoryIndex,
      "",
      "命中召回：",
      matchedIndex
    ]),
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
    pendingConsolidation ? section("待整理记忆", pendingConsolidationLines) : "",
    userTemplateText.trim() ? section("用户模板补充", [userTemplateText.trim()]) : ""
  ];

  return appendAgentRoleReference(blocks.filter(Boolean).join("\n\n"), rolePath);
}

export function buildAgentPacket(decision: RouteDecision, rule: NotificationRule, roleContext: AgentRoleContext): AgentPacket {
  const templateValues = {
    ...templateValuesForDecision(decision, roleContext),
    ...decision.extraValues,
    routeKind: decision.routeKind
  };
  const userTemplateText = renderTemplate(rule.template, templateValues);

  return {
    rule,
    templateValues,
    message: buildAgentMessage(decision, templateValues, userTemplateText, roleContext.rolePath, roleContext.roleDir)
  };
}
