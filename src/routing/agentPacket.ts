import fs from "node:fs";
import path from "node:path";
import { config, type NotificationRule } from "../config.js";
import { resolvePipeline, type ResolvedPipeline } from "../pipelines.js";
import { rabiContextManager } from "../context/rabiContextManager.js";
import { buildRoleKnowledgeContextView } from "./roleKnowledgeContext.js";
import { toProjectRelativePath } from "../shared/projectPaths.js";
import { resolveSpeechRouteProfile } from "../shared/speechControlContract.js";
import { recentMessageLimitFor } from "../shared/gatewayConfigModel.js";
import {
  messageContextArchiveIndexPath,
  messageContextArchiveDir,
  messageContextCurrentPath,
  recentMessageContextText
} from "../messageContextStore.js";
import type { ForwardTemplateValues } from "./types.js";
import type { RouteDecision } from "./routeDecision.js";
import { messageContextScopeForForward } from "./messageContextScope.js";
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

type MessageCodeRecord = {
  time: number;
  rawMessage: string;
  messageId?: string | number;
  userId?: string | number;
  senderName?: string;
  botUserId?: string;
  botNickname?: string;
  source?: "history" | "outbox" | "current";
};

type MessageCodeParseResult = {
  lines: string[];
  atNames: Map<string, string>;
};

const MESSAGE_CODE_PREVIEW_LIMIT = 200;
const MESSAGE_CODE_MAX_REPLY_DEPTH = 10;

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
  const characterTtsDialogue = outputAdapter === "tts" && routeKind === "voice_transcript";

  if (!replyApiUrl || !replyContextJson) {
    return [];
  }

  const shouldExplainReplyApi = forceMessagePipeline
    || replyToSource
    || characterTtsDialogue
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
      : characterTtsDialogue
      ? [
          "本次由语音消息端触发，进入 character-tts-dialogue 回复状态；不能只在 Codex 线程里写最终文本。",
          "请生成同义的屏幕文本与适合朗读的语音文本，并保持当前 Rabi 人格；普通情况下两者使用同一句短而自然的回复。",
          "把要播出的语音文本 POST 到普通回复 API；RabiRoute 会冻结当前 Route 的人格、声线、模型和 sessionId，并交给 RabiSpeech 主机级 FIFO 播放队列。不要绕过 Outbox 直连 worker，也不要重复调用 TTS。"
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
    characterTtsDialogue
      ? "API 调用成功后，把同一人格回复作为可见最终文本；不能只显示“已投递”之类的状态。如果决定不回应，请说明保持安静的原因且不要调用 API。"
      : "API 调用成功后，可见最终回复只需同步已投递的简短结果；如果决定不对消息来源回复，请说明保持安静或不回传的原因。"
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

function truncateMessageCodePreview(text: string): string {
  const normalized = messageText(text);
  if (normalized.length <= MESSAGE_CODE_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, MESSAGE_CODE_PREVIEW_LIMIT)}……(更多信息调用接口查看)`;
}

function stripCqCodes(text: string): string {
  return messageText(text.replace(/\[CQ:[^\]]+\]/g, " "));
}

function cqCode(type: string, fields: Record<string, string>): string {
  const params = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `[CQ:${type}${params ? `,${params}` : ""}]`;
}

function cqParam(rawParams: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|,)${key}=([^,\\]]+)`);
  return rawParams.match(pattern)?.[1];
}

function parseReplyIds(text: string): string[] {
  return [...text.matchAll(/\[CQ:reply,([^\]]+)\]/g)]
    .map((match) => cqParam(match[1], "id"))
    .filter((value): value is string => Boolean(value));
}

function parseAtCodes(text: string): Array<{ qq: string; code: string }> {
  return [...text.matchAll(/\[CQ:at,([^\]]+)\]/g)]
    .map((match) => {
      const qq = cqParam(match[1], "qq");
      return qq ? { qq, code: cqCode("at", { qq }) } : null;
    })
    .filter((value): value is { qq: string; code: string } => Boolean(value));
}

function readMessageCodeRecords(dataDir: string): MessageCodeRecord[] {
  if (!dataDir) return [];

  const historyDirs = [...new Set([dataDir, config.memoryDataDir].filter(Boolean).map((item) => path.resolve(item)))];
  const groupMessages = historyDirs.flatMap((historyDir) => parseJsonlFile<Record<string, unknown>>(path.join(historyDir, "group-messages.jsonl")))
    .map((item) => ({
      time: Number(item.time) || 0,
      rawMessage: String(item.rawMessage ?? ""),
      messageId: item.messageId as string | number | undefined,
      userId: item.userId as string | number | undefined,
      senderName: messageText(item.senderName),
      botUserId: item.botUserId == null ? undefined : String(item.botUserId),
      botNickname: messageText(item.botNickname),
      source: "history" as const
    }));
  const privateMessages = historyDirs.flatMap((historyDir) => parseJsonlFile<Record<string, unknown>>(path.join(historyDir, "private-messages.jsonl")))
    .map((item) => ({
      time: Number(item.time) || 0,
      rawMessage: String(item.rawMessage ?? ""),
      messageId: item.messageId as string | number | undefined,
      userId: item.userId as string | number | undefined,
      senderName: messageText(item.senderName),
      botUserId: item.botUserId == null ? undefined : String(item.botUserId),
      botNickname: messageText(item.botNickname),
      source: "history" as const
    }));
  const outboxMessages = parseJsonlFile<Record<string, unknown>>(path.join(dataDir, "outbox-adapter.log.jsonl"))
    .flatMap((item) => {
      if (item.event !== "reply_sent" && item.event !== "group_file_caption_sent") return [];
      const data = item.data && typeof item.data === "object" ? item.data as Record<string, unknown> : {};
      if (data.targetType !== "group" && data.targetType !== "private") return [];
      const sentMessageId = data.sentMessageId;
      const rawMessage = String(item.message ?? "");
      if (sentMessageId == null || !rawMessage) return [];
      return [{
        time: Number(item.time) || 0,
        rawMessage,
        messageId: sentMessageId as string | number,
        source: "outbox" as const
      }];
    });

  return [...groupMessages, ...privateMessages, ...outboxMessages]
    .filter((item) => item.rawMessage || item.messageId != null)
    .sort((left, right) => left.time - right.time);
}

function messageRecordForForwardRecord(record: RouteDecision["record"]): MessageCodeRecord {
  return {
    time: record.time,
    rawMessage: record.rawMessage,
    messageId: record.messageId,
    userId: "userId" in record ? record.userId : undefined,
    senderName: record.senderName,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    botNickname: "botNickname" in record ? record.botNickname : undefined,
    source: "current"
  };
}

function messageRecordIndex(records: MessageCodeRecord[]): Map<string, MessageCodeRecord> {
  const index = new Map<string, MessageCodeRecord>();
  const priority = { outbox: 0, history: 1, current: 2 } as const;
  for (const record of records) {
    if (record.messageId == null) continue;
    const id = String(record.messageId);
    const existing = index.get(id);
    if (!existing || priority[record.source ?? "history"] >= priority[existing.source ?? "history"]) {
      index.set(id, record);
    }
  }
  return index;
}

function atNameIndex(records: MessageCodeRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    if (record.userId != null && record.senderName) {
      index.set(String(record.userId), record.senderName);
    }
    if (record.botUserId && record.botNickname) {
      index.set(record.botUserId, record.botNickname);
    }
  }
  return index;
}

function collectAtCodes(text: string, atNames: Map<string, string>, knownNames: Map<string, string>): void {
  for (const item of parseAtCodes(text)) {
    if (!atNames.has(item.qq)) {
      atNames.set(item.qq, knownNames.get(item.qq) || item.qq);
    }
  }
}

function appendReplyCodeLines(
  rawMessage: string,
  recordsById: Map<string, MessageCodeRecord>,
  knownAtNames: Map<string, string>,
  result: MessageCodeParseResult,
  visited: Set<string>,
  depth: number
): void {
  if (depth >= MESSAGE_CODE_MAX_REPLY_DEPTH) return;

  for (const replyId of parseReplyIds(rawMessage)) {
    const indent = "  ".repeat(depth);
    const code = cqCode("reply", { id: replyId });
    if (visited.has(replyId)) {
      result.lines.push(`${indent}${code} : 引用消息 ${replyId} 已在上方展开，停止循环引用。`);
      continue;
    }

    const replied = recordsById.get(replyId);
    if (!replied) {
      result.lines.push(`${indent}${code} : 引用消息 ${replyId} 暂时无法解析。`);
      continue;
    }

    visited.add(replyId);
    collectAtCodes(replied.rawMessage, result.atNames, knownAtNames);
    result.lines.push(`${indent}${code} : ${truncateMessageCodePreview(stripCqCodes(replied.rawMessage))}`);
    appendReplyCodeLines(replied.rawMessage, recordsById, knownAtNames, result, visited, depth + 1);
  }
}

function messageCodeParseText(record: RouteDecision["record"], dataDir: string): string {
  const currentRecord = messageRecordForForwardRecord(record);
  const records = [...readMessageCodeRecords(dataDir), currentRecord];
  const recordsById = messageRecordIndex(records);
  const knownAtNames = atNameIndex(records);
  const result: MessageCodeParseResult = {
    lines: [],
    atNames: new Map()
  };

  collectAtCodes(record.rawMessage, result.atNames, knownAtNames);
  appendReplyCodeLines(
    record.rawMessage,
    recordsById,
    knownAtNames,
    result,
    new Set(currentRecord.messageId == null ? [] : [String(currentRecord.messageId)]),
    0
  );

  for (const [qq, name] of result.atNames) {
    result.lines.push(`${cqCode("at", { qq })} : ${name}`);
  }

  return result.lines.join("\n");
}

function recentMessageContextForDecision(decision: RouteDecision, roleContext: AgentRoleContext): {
  endpoint?: string;
  transport?: string;
  conversationKey?: string;
  limit: number;
  text: string;
} {
  const scope = messageContextScopeForForward(decision.routeKind, decision.record, {
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: decision.route.id
  });
  if (!scope?.endpoint) return { limit: 0, text: "- 暂无" };
  const limit = decision.route.recentMessageLimits
    ? recentMessageLimitFor(decision.route.recentMessageLimits, scope.endpoint)
    : Math.max(0, Math.min(200, Math.floor(Number(decision.route.recentMessageLimit) || 0)));
  return {
    endpoint: scope.endpoint,
    transport: scope.record.transport,
    conversationKey: scope.record.conversationKey,
    limit,
    text: recentMessageContextText([roleContext.dataDir], {
      limit,
      adapter: scope.endpoint,
      conversationKey: scope.record.conversationKey
    })
  };
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
      const stepLines = Array.isArray(parsed.steps)
        ? parsed.steps.flatMap((rawStep, index) => {
          if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return [];
          const step = rawStep as Record<string, unknown>;
          const title = String(step.title || step.name || step.label || "").trim();
          if (!title) return [];
          const id = String(step.id || step.stepId || `step-${index + 1}`).trim();
          const status = String(step.status || (step.completed === true ? "已完成" : step.current === true ? "进行中" : "未开始"));
          const currentMarker = id === String(parsed.currentStepId || "") ? " ← 当前执行" : "";
          const blockedBy = String(step.blockedBy || "").trim();
          return [
            `    ${index + 1}. [${status}] ${title} (${id})${currentMarker}`,
            blockedBy ? `       阻塞原因：${blockedBy}` : ""
          ].filter(Boolean);
        })
        : [];
      summaries.push([
        `- ${planId}`,
        optionalLine("  标题", parsed.title),
        optionalLine("  状态", parsed.status),
        optionalLine("  当前步骤 ID", parsed.currentStepId),
        optionalLine("  当前步骤", parsed.currentStep),
        optionalLine("  下一步", parsed.nextAction),
        optionalLine("  等待", parsed.waitingFor),
        optionalLine("  阻塞原因", parsed.blockedBy),
        stepLines.length > 0 ? `  全部步骤：\n${stepLines.join("\n")}` : "",
        `  路径：${relativeWorkspacePath(planPath)}`
      ].filter(Boolean).join("\n"));
    } catch (error) {
      summaries.push(`- ${planId}：读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summaries;
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
  if (routeKind === "wearable_health_alert") return "智能手表/手环健康告警";
  if (routeKind === "wecom_message") return "企业微信群聊消息提醒";
  return "RabiRoute 消息提醒";
}

function outputPipelineForDecision(decision: RouteDecision): ResolvedPipeline {
  const record = decision.record;
  const pipeline = decision.route.resolvedPipeline ?? config.resolvedPipeline;
  if (
    decision.routeKind === "voice_transcript" &&
    isVoiceTranscriptRecord(record) &&
    (record.adapterType === "speech" || record.source === "rabispeech")
  ) {
    const speechProfile = resolveSpeechRouteProfile(
      decision.routeVariables,
      pipeline.ttsVoice || decision.route.agentRoleId || "default"
    );
    return resolvePipeline("voice_chat", {
      inputAdapter: "speech",
      ttsProvider: pipeline.ttsProvider || undefined,
      ttsVoice: speechProfile.voice,
      ttsPlay: speechProfile.autoPlay,
      preventFeedbackLoop: true,
      replyToSource: false
    });
  }
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
  const conversationCurrentPath = relativeWorkspacePath(messageContextCurrentPath(roleContext.dataDir));
  const conversationArchiveDir = relativeWorkspacePath(messageContextArchiveDir(roleContext.dataDir));
  const conversationArchiveIndexPath = relativeWorkspacePath(messageContextArchiveIndexPath(roleContext.dataDir));
  const recentContext = recentMessageContextForDecision(decision, roleContext);
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
    logicalAdapter: recentContext.endpoint,
    transport: recentContext.transport,
    conversationKey: recentContext.conversationKey,
    adapterType: isRolePanel ? "rolePanel" : "adapterType" in record ? record.adapterType : undefined,
    speakerId: isVoiceTranscript ? record.speakerId : undefined,
    speakerName: isVoiceTranscript ? record.speakerName : undefined,
    speakerKind: isVoiceTranscript ? record.speakerKind : undefined,
    speakerConfidence: isVoiceTranscript ? record.speakerConfidence : undefined,
    speakerDecision: isVoiceTranscript ? record.speakerDecision : undefined,
    sessionId: isVoiceTranscript ? record.sessionId : undefined,
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
    characterTtsDialogue: isVoiceTranscript
      && (record.adapterType === "speech" || record.source === "rabispeech")
      && pipeline.outputAdapter === "tts",
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
    recentMessageLimit: recentContext.limit,
    recentMessageEndpoint: recentContext.endpoint,
    recentConversationKey: recentContext.conversationKey,
    recentMessages: recentContext.text,
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
    conversationCurrentPath,
    conversationArchiveDir,
    conversationArchiveIndexPath,
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    triggerId: isManualTrigger ? record.triggerId : undefined,
    triggerName: isManualTrigger ? record.triggerName : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    voiceSpeakerId: isVoiceTranscript ? record.speakerId : undefined,
    voiceSpeakerName: isVoiceTranscript ? record.speakerName : undefined,
    voiceSpeakerKind: isVoiceTranscript ? record.speakerKind : undefined,
    voiceSpeakerConfidence: isVoiceTranscript ? record.speakerConfidence : undefined,
    voiceSpeakerDecision: isVoiceTranscript ? record.speakerDecision : undefined,
    speechPushMode: isVoiceTranscript ? route.speechPushMode : undefined,
    voiceSourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    voiceSourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    voiceSourceArea: isVoiceTranscript ? record.sourceArea : undefined,
    voiceSessionId: isVoiceTranscript ? record.sessionId : undefined,
    voiceStartedAt: isVoiceTranscript ? record.startedAt : undefined,
    voiceEndedAt: isVoiceTranscript ? record.endedAt : undefined,
    voiceDurationSeconds: isVoiceTranscript ? record.durationSeconds : undefined,
    voicePeak: isVoiceTranscript ? record.peak : undefined,
    configurationRequested: isVoiceTranscript && record.configurationRequested ? "true" : undefined,
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
  roleDir: string,
  dataDir: string
): string {
  const record = decision.record;
  const routeKind = decision.routeKind;
  const shouldAttachMemoryConsolidation = routeKind === "manual_trigger" && String(values.triggerId || "") === "memory-consolidation";
  const hasPersona = Boolean(String(values.agentRoleId || "").trim() && roleDir);
  const referencedPlanSummaries = routeKind === "manual_trigger"
    ? readReferencedPlanSummaries(roleDir, userTemplateText)
    : [];
  const contextResolution = hasPersona
    ? rabiContextManager.resolve({
        kind: "message_delivery",
        source: "rabi_delivery",
        roleId: String(values.agentRoleId || ""),
        roleDir,
        signalText: String(values.message || ""),
        includePendingConsolidation: shouldAttachMemoryConsolidation,
        consolidationTrigger: shouldAttachMemoryConsolidation ? "manual" : undefined,
        forceConsolidation: shouldAttachMemoryConsolidation
      })
    : null;
  const knowledge = contextResolution?.knowledge ?? null;
  const knowledgeView = knowledge ? buildRoleKnowledgeContextView(values.agentRoleId, knowledge) : null;
  const activePlanIndex = knowledgeView?.activePlanIndex ?? "- 暂无";
  const activeSkillIndex = knowledgeView?.activeSkillIndex ?? "- 暂无";
  const recentMemoryIndex = knowledgeView?.recentMemoryIndex ?? "- 暂无";
  const matchedIndex = knowledgeView?.matchedIndex ?? "- 暂无";
  const matchedSkillIndex = knowledgeView?.matchedSkillIndex ?? "- 暂无";
  const requiredReadIndex = knowledgeView?.requiredReadLines ?? [];
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
      optionalLine("语音推送模式", values.speechPushMode),
      optionalLine("命中人格关键词", values.speechTriggerKeyword),
      optionalLine("触发 ID", values.triggerId),
      optionalLine("触发名称", values.triggerName)
    ]),
    section("消息", [String(values.message || record.rawMessage || "")]),
    section("消息代码解析", [messageCodeParseText(record, dataDir)]),
    String(values.configurationRequested || "") === "true" ? section("移动端配置助手", [
      "这是用户从 Rabi 移动设备消息端明确发起的自然语言配置请求。",
      "先读取当前真实配置；写入、删除、停止、覆盖或外部动作必须经过现有动作安全门和审批。",
      "只允许调用 Rabi PC 已公开的远程 WebGUI/路由配置接口；不要索取、复述或猜测 token、密码等凭据。",
      "只有接口返回成功并复核读回结果后才能声称配置完成；不明确时先向用户追问。"
    ]) : "",
    recentMessageLimit > 0 ? section("最近消息", [
      optionalLine("当前消息端", values.recentMessageEndpoint),
      optionalLine("当前会话", values.recentConversationKey),
      `当前消息端、当前会话最近 ${recentMessageLimit} 条双向消息：`,
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
      ...(knowledgeView?.apiHintLines ?? []),
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
      optionalLine("语音转写日志", values.voiceTranscriptLogPath),
      optionalLine("当前双向会话", values.conversationCurrentPath),
      optionalLine("历史会话归档", values.conversationArchiveDir),
      optionalLine("会话归档索引", values.conversationArchiveIndexPath)
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
    message: buildAgentMessage(decision, templateValues, userTemplateText, rolePath, roleDir, roleContext.dataDir)
  };
}
