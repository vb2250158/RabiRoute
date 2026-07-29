import fs from "node:fs";
import path from "node:path";
import { config, type NotificationRule } from "../config.js";
import { resolvePipeline, type ResolvedPipeline } from "../pipelines.js";
import { rabiContextManager } from "../context/rabiContextManager.js";
import { buildRoleKnowledgeContextView } from "./roleKnowledgeContext.js";
import {
  personaSyncCapabilityHint,
  voiceIdentityReviewCapabilityHint
} from "./agentCapabilityHints.js";
import { toProjectRelativePath } from "../shared/projectPaths.js";
import { resolveSpeechRouteProfile } from "../shared/speechControlContract.js";
import { recentMessageLimitFor } from "../shared/gatewayConfigModel.js";
import {
  currentPlanStep,
  getPlan,
  planApprovalGate,
  planBlockingReason,
  planIsBlocked
} from "../roleKnowledge.js";
import {
  messageContextArchiveIndexPath,
  messageContextArchiveDir,
  messageContextCurrentPath,
  recentMessageContextText
} from "../messageContextStore.js";
import { resolvePersonaVoiceIdentities, type PersonaVoiceIdentity } from "../personaVoiceIdentities.js";
import type { ForwardTemplateValues } from "./types.js";
import type { RouteDecision } from "./routeDecision.js";
import { messageContextScopeForForward } from "./messageContextScope.js";
import {
  isGroupRecord,
  isHeartbeatRecord,
  isManualTriggerRecord,
  isPlanFeedbackRecord,
  isRolePanelRecord,
  isWeComRecord,
  isWeixinRecord,
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

function voiceprintIdsForRecord(record: RouteDecision["record"]): string[] {
  if (!isVoiceTranscriptRecord(record)) return [];
  const candidates = [
    record.voiceprintId,
    ...(record.segments ?? []).flatMap(segment => [
      segment.voiceprintId,
      segment.speakerClusterId
    ])
  ];
  return [...new Set(candidates.map(value => String(value ?? "").trim()).filter(Boolean))];
}

function formatPersonaVoiceIdentity(voiceprintId: string, identity?: PersonaVoiceIdentity): string {
  if (!identity) return `- ${voiceprintId}：当前人格尚未确认`;
  const conflictCandidates = identity.conflictCandidates?.slice(0, 5).map(candidate => {
    const branch = [
      candidate.deleted ? "已删除" : "保留",
      candidate.displayName ? `称呼=${candidate.displayName}` : "",
      candidate.relationship ? `关系=${candidate.relationship}` : "",
      candidate.isUser == null ? "isUser=未确认" : `isUser=${candidate.isUser}`
    ].filter(Boolean).join("/");
    return `${candidate.eventId}:${branch}`;
  }).join(" | ");
  const facts = [
    identity.displayName ? `称呼=${identity.displayName}` : "",
    identity.relationship ? `关系=${identity.relationship}` : "",
    identity.isUser == null ? "" : `isUser=${identity.isUser}`,
    identity.aliases.length > 0 ? `别名=${identity.aliases.join("、")}` : "",
    identity.notes ? `说明=${identity.notes}` : "",
    identity.conflicted ? `并发分支待收敛=${identity.conflictFields?.join("、") || "关系资料"}` : "",
    conflictCandidates ? `候选分支=${conflictCandidates}` : ""
  ].filter(Boolean);
  return `- ${voiceprintId}：${facts.join("；") || "已记录但未填写关系说明"}`;
}

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
  const targetType = String(values.targetType ?? "");
  const replyApiUrl = String(values.replyApiUrl ?? "");
  const replyContextJson = String(values.replyContextJson ?? "");
  const replyToSource = String(values.replyToSource ?? "").toLowerCase() === "true";
  const characterTtsDialogue = outputAdapter === "tts" && routeKind === "voice_transcript";
  let planFeedbackKind = "";
  try {
    planFeedbackKind = String((JSON.parse(replyContextJson) as { planFeedbackKind?: unknown }).planFeedbackKind || "");
  } catch {
    // The replyContext JSON is rendered below and will surface the invalid payload to the handler.
  }

  if (!replyApiUrl || !replyContextJson) {
    return [];
  }

  const isPlanFeedback = targetType === "plan_feedback";
  const isPlanGuidance = isPlanFeedback && planFeedbackKind === "guidance";
  const shouldExplainReplyApi = isPlanFeedback
    || forceMessagePipeline
    || replyToSource
    || characterTtsDialogue
    || (outputAdapter === "fennenote" && routeKind === "voice_transcript")
    || routeKind === "rabilink";
  if (!shouldExplainReplyApi) return [];

  const intro = isPlanGuidance
    ? [
        "本次是计划引导处理，面向用户的回复必须回到当前计划记录，不能只在 Codex 任务里输出正文。",
        "先读取当前计划与反馈记录，再根据引导继续推进。引导属于整个计划，不绑定某个步骤；如果范围、优先级、执行方式或后续路径变化，必须 PATCH 计划并同步调整尚未开始的步骤。引导本身不代表审批，也不自动改变计划状态。",
        "更新完成后，把处理说明 POST 到普通回复 API；RabiRoute 会将其保存为当前 planId 下、不带 stepId 的 guidance_response。"
      ]
    : isPlanFeedback
    ? [
        "本次是计划审批意见处理，面向用户的回复必须回到当前计划记录，不能只在 Codex 任务里输出正文。",
        "先按审批意见读取并 PATCH 更新对应计划或步骤；批准、否决、要求调整或取消后必须同轮更新 approvalRequest.responseStatus。isBlocked 由 Manager 根据完整且待决的审批合同自动派生，不要手写。计划说明要具体到审批人、决定、推荐与备选、reason、实际文件、完整命令、外部变更、验证、回退、排除范围、附件、请求来源和回执状态。",
        "更新完成后，把处理说明 POST 到普通回复 API；RabiRoute 会将其保存为当前 planId / stepId 的 approval_response。"
      ]
    : forceMessagePipeline
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
      text: isPlanGuidance ? "这里填写计划引导的处理说明。" : "这里填写夜雨要说的话。",
      replyContext: JSON.parse(replyContextJson)
    }, null, 2),
    "```",
    isPlanFeedback
      ? "API 调用成功后，Codex 可见最终文本只需简短说明计划已更新且回复已回写；不要重复输出计划回复正文。"
      : characterTtsDialogue
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
  if (decision.routeKind === "plan_feedback") {
    return { limit: 0, text: "" };
  }
  const scope = messageContextScopeForForward(decision.routeKind, decision.record, {
    gatewayId: process.env.GATEWAY_ID,
    routeProfileId: decision.route.id
  });
  if (!scope?.endpoint) return { limit: 0, text: "- 暂无" };
  if (decision.routeKind === "heartbeat") {
    return {
      endpoint: scope.endpoint,
      transport: scope.record.transport,
      conversationKey: scope.record.conversationKey,
      limit: 0,
      text: ""
    };
  }
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
      conversationKey: scope.record.conversationKey,
      excludedMessageIds: decision.record.messageId == null ? [] : [String(decision.record.messageId)]
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
    const parsed = getPlan(roleDir, planId);
    if (!parsed) {
      summaries.push(`- ${planId}：未找到对应计划文件。`);
      continue;
    }
    const candidates = [
      path.join(roleDir, "plans", "items", "active", `${planId}.json`),
      path.join(roleDir, "plans", "archive", `${planId}.json`),
      path.join(roleDir, "plans", "items", "archived", `${planId}.json`),
      path.join(roleDir, "plans", `${planId}.json`)
    ];
    const planPath = candidates.find((candidate) => fs.existsSync(candidate));

    try {
      const currentStep = currentPlanStep(parsed);
      const approvalGate = planApprovalGate(parsed);
      const blocked = planIsBlocked(parsed);
      const stepLines = parsed.steps.flatMap((step, index) => {
          const title = step.title.trim();
          const id = step.id.trim();
          const status = step.status;
          const isCurrent = id === currentStep?.id;
          const currentMarker = isCurrent ? " ← 当前执行" : "";
          const waitingFor = String(step.waitingFor || "").trim();
          const isBlocked = blocked && isCurrent;
          const blockedBy = String(step.blockedBy || "").trim();
          const approvalPreparing = approvalGate.state === "preparing" && id === approvalGate.stepId;
          const approvalPending = approvalGate.state === "pending" && id === approvalGate.stepId;
          return [
            `    ${index + 1}. [${status}] ${title} (${id})${currentMarker}`,
            waitingFor ? `       等待对象：${waitingFor}` : "",
            isBlocked && blockedBy ? `       阻塞原因：${blockedBy}` : "",
            !isBlocked && blockedBy ? `       待确认说明：${blockedBy}` : "",
            approvalPending
              ? "       巡检动作：当前合同已可审批，计划保持审批阻塞；继续追问审批回执，不得续投合同外实施。"
              : approvalPreparing
                ? "       巡检动作：审批合同尚未完整，计划保持进行中；继续调查、补证据并补齐合同，不能把资料缺失标成阻塞。"
                : status === "进行中" && waitingFor
                  ? "       巡检动作：主动询问、重试、改道或补证据，直到取得明确结果；不得仅记录等待。"
                  : ""
          ].filter(Boolean);
        });
      summaries.push([
        `- ${planId}`,
        optionalLine("  标题", parsed.title),
        optionalLine("  状态", parsed.status),
        optionalLine("  当前步骤 ID", parsed.currentStepId),
        optionalLine("  当前步骤", parsed.currentStep),
        optionalLine("  下一步", parsed.nextAction),
        optionalLine("  等待", parsed.waitingFor),
        blocked ? optionalLine("  阻塞原因", planBlockingReason(parsed)) : optionalLine("  待确认说明", parsed.blockedBy),
        stepLines.length > 0 ? `  全部步骤：\n${stepLines.join("\n")}` : "",
        planPath ? `  路径：${relativeWorkspacePath(planPath)}` : ""
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
  if (routeKind === "plan_feedback") return "计划反馈";
  if (routeKind === "voice_transcript") return "语音转写提醒";
  if (routeKind === "rabilink") return "RabiLink 消息";
  if (routeKind === "wearable_health_alert") return "智能手表/手环健康告警";
  if (routeKind === "wecom_message") return "企业微信群聊消息提醒";
  if (routeKind === "weixin_message") return "个人微信消息提醒";
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
    ? record.senderName || record.source || "voice_transcript"
    : record.senderName || ("userId" in record ? record.userId : "RabiRoute");
  const isGroup = isGroupRecord(record);
  const isHeartbeat = isHeartbeatRecord(record);
  const isManualTrigger = isManualTriggerRecord(record);
  const isRolePanel = isRolePanelRecord(record);
  const isPlanFeedback = isPlanFeedbackRecord(record);
  const isWeCom = isWeComRecord(record);
  const isWeixin = isWeixinRecord(record);
  const localReplyContext = (isRolePanel || isPlanFeedback) && record.replyContext && typeof record.replyContext === "object"
    ? record.replyContext
    : {};
  const localTargetType = typeof localReplyContext.targetType === "string" && localReplyContext.targetType.trim()
    ? localReplyContext.targetType.trim()
    : isPlanFeedback ? "plan_feedback" : "role_panel";
  const localRoleId = isPlanFeedback ? record.roleId : isRolePanel ? record.roleId : undefined;
  const planFeedbackTargetId = typeof localReplyContext.planId === "string" && localReplyContext.planId.trim()
    ? localReplyContext.planId.trim()
    : localRoleId ?? "plan_feedback";
  const targetId = isGroup ? record.groupId : "userId" in record ? record.userId : isVoiceTranscript ? record.source ?? "webhook" : isManualTrigger ? record.triggerId ?? "manual_trigger" : isPlanFeedback ? planFeedbackTargetId : isRolePanel ? record.roleId ?? "rolePanel" : "heartbeat";
  const wecomGroupId = isWeCom ? record.groupId ?? record.chatId ?? record.conversationId : undefined;
  const targetType = isGroup || isWeCom ? "group" : isHeartbeat ? "heartbeat" : isManualTrigger ? "manual_trigger" : isPlanFeedback || isRolePanel ? localTargetType : isVoiceTranscript ? decision.routeKind === "rabilink" ? "rabilink" : "voice_transcript" : "private";
  const pipeline = outputPipelineForDecision(decision);
  const replyApiPath = "/api/agent/replies";
  const replyApiUrl = `http://127.0.0.1:${process.env.GATEWAY_MANAGER_PORT ?? "8790"}${replyApiPath}`;
  const dataDirPath = relativeWorkspacePath(roleContext.dataDir);
  const roleDirPath = relativeWorkspacePath(roleContext.roleDir);
  const rolePath = relativeWorkspacePath(roleContext.rolePath);
  const groupLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, isWeCom ? "wecom-messages.jsonl" : "group-messages.jsonl"));
  const privateLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, isWeixin ? "weixin-messages.jsonl" : "private-messages.jsonl"));
  const heartbeatLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "heartbeat-events.jsonl"));
  const manualTriggerLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "manual-trigger-events.jsonl"));
  const rolePanelLogPath = relativeWorkspacePath(path.join(roleContext.roleDir || roleContext.dataDir, "role-panel", "messages.jsonl"));
  const voiceTranscriptLogPath = relativeWorkspacePath(path.join(roleContext.dataDir, "voice-transcripts.jsonl"));
  const voiceIdentitiesPath = relativeWorkspacePath(path.join(roleContext.roleDir || roleContext.dataDir, "voice", "voice-identities.jsonl"));
  const conversationCurrentPath = relativeWorkspacePath(messageContextCurrentPath(roleContext.dataDir));
  const conversationArchiveDir = relativeWorkspacePath(messageContextArchiveDir(roleContext.dataDir));
  const conversationArchiveIndexPath = relativeWorkspacePath(messageContextArchiveIndexPath(roleContext.dataDir));
  const recentContext = recentMessageContextForDecision(decision, roleContext);
  const voiceprintIds = isVoiceTranscript ? voiceprintIdsForRecord(record) : [];
  const personaVoiceIdentities = isVoiceTranscript && roleContext.roleDir && record.sourceHostId && voiceprintIds.length > 0
    ? resolvePersonaVoiceIdentities(roleContext.roleDir, record.sourceHostId, voiceprintIds)
    : [];
  const personaVoiceIdentitySummary = personaVoiceIdentities
    .map(item => formatPersonaVoiceIdentity(item.voiceprintId, item.identity))
    .join("\n");
  const replyContext = {
    ...localReplyContext,
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
    adapterType: isPlanFeedback ? "planFeedback" : isRolePanel ? "rolePanel" : "adapterType" in record ? record.adapterType : undefined,
    voiceprintId: isVoiceTranscript ? record.voiceprintId : undefined,
    voiceprintIds: isVoiceTranscript ? voiceprintIds : undefined,
    sessionId: isVoiceTranscript || isWeixin ? record.sessionId : undefined,
    sourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    sourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    sourceDeviceKind: isVoiceTranscript ? record.sourceDeviceKind : undefined,
    sourceStreamId: isVoiceTranscript ? record.sourceStreamId : undefined,
    sourceHostId: isVoiceTranscript ? record.sourceHostId : undefined,
    sourceHostName: isVoiceTranscript ? record.sourceHostName : undefined,
    voiceIdentitiesPath: isVoiceTranscript ? voiceIdentitiesPath : undefined,
    personaVoiceIdentities: isVoiceTranscript ? personaVoiceIdentities : undefined,
    targetDeviceIds: isVoiceTranscript && decision.routeKind === "rabilink" && record.sourceDeviceId
      ? [record.sourceDeviceId]
      : undefined,
    roleId: localRoleId,
    botUserId: "botUserId" in record ? record.botUserId : undefined,
    wecomReqId: isWeCom ? record.reqId : undefined,
    wecomConversationId: isWeCom ? record.conversationId : undefined,
    wecomChatId: isWeCom ? record.chatId : undefined,
    wecomSenderId: isWeCom ? record.senderId ?? record.userId : undefined,
    wecomMessageType: isWeCom ? record.messageType : undefined,
    weixinSessionId: isWeixin ? record.sessionId : undefined,
    weixinUserId: isWeixin ? record.userId : undefined,
    weixinMessageType: isWeixin ? record.messageType : undefined,
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
    messageTarget: isWeixin ? `个人微信会话 ${record.sessionId}` : isWeCom ? `企业微信群 ${wecomGroupId ?? "unknown"}` : isGroup ? `群 ${targetId}` : isHeartbeat ? "RabiRoute 心跳" : isManualTrigger ? `手动触发 ${targetId}` : isPlanFeedback ? `计划反馈 ${targetId}` : isRolePanel ? `角色面板 ${targetId}` : isVoiceTranscript ? decision.routeKind === "rabilink" ? `RabiLink ${targetId}` : `语音转写 ${targetId}` : `私聊 ${targetId}`,
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
    voiceIdentitiesPath: isVoiceTranscript ? voiceIdentitiesPath : undefined,
    voiceprintIds: voiceprintIds.join(", ") || undefined,
    personaVoiceIdentitySummary: personaVoiceIdentitySummary || undefined,
    conversationCurrentPath,
    conversationArchiveDir,
    conversationArchiveIndexPath,
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    triggerId: isManualTrigger ? record.triggerId : undefined,
    triggerName: isManualTrigger ? record.triggerName : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    speechPushMode: isVoiceTranscript ? route.speechPushMode : undefined,
    voiceSourceDeviceId: isVoiceTranscript ? record.sourceDeviceId : undefined,
    voiceSourceDeviceName: isVoiceTranscript ? record.sourceDeviceName : undefined,
    voiceSourceStreamId: isVoiceTranscript ? record.sourceStreamId : undefined,
    voiceSourceHostId: isVoiceTranscript ? record.sourceHostId : undefined,
    voiceSourceHostName: isVoiceTranscript ? record.sourceHostName : undefined,
    voiceprintId: isVoiceTranscript ? record.voiceprintId : undefined,
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
    wecomMessageType: isWeCom ? record.messageType : undefined,
    weixinSessionId: isWeixin ? record.sessionId : undefined,
    weixinUserId: isWeixin ? record.userId : undefined,
    weixinMessageType: isWeixin ? record.messageType : undefined
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
  const capabilityIntentText = [
    String(values.message || record.rawMessage || ""),
    userTemplateText
  ].filter(Boolean).join("\n");
  const capabilityContext = {
    managerPort: process.env.GATEWAY_MANAGER_PORT ?? "8790",
    roleId: String(values.agentRoleId || "").trim()
  };
  const personaSyncHint = hasPersona ? personaSyncCapabilityHint(capabilityIntentText, capabilityContext) : null;
  const voiceIdentityReviewHint = hasPersona
    ? voiceIdentityReviewCapabilityHint(capabilityIntentText, capabilityContext)
    : null;
  const pendingConsolidationLines = pendingConsolidation
    ? [
        `runId：${pendingConsolidation.run.id}`,
        `结果回传 API：/api/roles/${values.agentRoleId}/memory/consolidation-runs/${pendingConsolidation.run.id}/result`,
        pendingConsolidation.run.instruction,
        "",
        ...pendingConsolidation.memories.map((memory) => `- ${memory.id}：${memory.title}\n  ${memory.content}`)
      ]
    : [];
  const planAssistantLines = config.codexPlanAssistantSessions.flatMap((session) => [
    `- 槽位 ${session.index}：${session.threadName}`,
    `  threadId=${session.threadId}`,
    `  workspace=${session.workspace}`
  ]);

  const blocks = [
    section("RabiRoute 事件", [
      `事件：${eventTitleForRoute(routeKind)}`,
      `路由类型：${routeKind}`,
      optionalLine("事件时间", values.time),
      optionalLine("当前时间", values.currentTime),
      optionalLine("来源", values.messageTarget),
      optionalLine("语音处理主机", values.voiceSourceHostName || values.voiceSourceHostId),
      optionalLine("发送者", values.sender),
      optionalLine("声纹 ID", values.voiceprintId),
      optionalLine("本段声纹", values.voiceprintIds),
      optionalLine("人格声纹关系文件", values.voiceIdentitiesPath),
      optionalLine("语音推送模式", values.speechPushMode),
      optionalLine("命中人格关键词", values.speechTriggerKeyword),
      optionalLine("触发 ID", values.triggerId),
      optionalLine("触发名称", values.triggerName)
    ]),
    section("消息", [String(values.message || record.rawMessage || "")]),
    values.voiceprintIds || values.voiceprintId ? section("人格声纹关系", [
      "RabiSpeech 和主机只提供不透明声纹 ID、处理主机与判定证据，不判断这个人是谁，也不判断谁是用户。",
      "以下内容只来自当前人格自己已经写入的关系文件，不是主机推断：",
      String(values.personaVoiceIdentitySummary || "- 当前人格尚未记录这些声纹的身份关系。"),
      "需要确认或修正时调用 PUT /api/roles/:roleId/voice-identities，追加到当前人格自己的 voice/voice-identities.jsonl。"
    ]) : "",
    routeKind === "plan_feedback" ? "" : section("消息代码解析", [messageCodeParseText(record, dataDir)]),
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
    hasPersona && planAssistantLines.length > 0 ? section("计划协助会话", [
      "下列 Codex Desktop 任务是当前主会话的持久计划管理秘书槽，属于控制面，不是一次性子 Agent，也不是计划的业务执行任务。",
      "主人格使用 /api/agent/threads 的 send 动作向秘书的精确 threadId 分配计划管理队列；不得把秘书 ID 写入任何计划的 taskBinding。",
      "每个计划的 taskBinding.sessionId + workspace 必须指向独立业务任务会话。调查、实现、测试、Unity/SVN/构建/发布和外部系统操作只能在业务任务中执行。",
      "秘书负责计划/记忆维护、业务任务查重与绑定、真实状态巡检、结果消费、提醒和续投。秘书可以开临时子 Agent 做控制面盘点，但秘书及其子 Agent不得直接修改业务文件。",
      "主人格是秘书槽调度者，不是计划管理员。新反馈、业务任务完成提醒、heartbeat 巡检或秘书阶段报告到达时，先把控制面工作精确投给秘书；主人格不得亲自展开全量计划读取、任务查重、绑定迁移、状态对账、问题账本/记忆写入或批量续投。",
      "发出秘书消息不等于委派完成。主人格必须核对精确 threadId + workspace、秘书真实任务状态和阶段回执；秘书开始后等待其结果，不得并行执行同一份日志/截图读取、查重、计划 PATCH、记忆/账本写入或任务续投，也不得先自己做一遍再只把剩余部分交给秘书。",
      "秘书必须在同一轮消费结果、更新计划和记忆，并按计划自身 taskBinding 精确续投业务任务；主人格随后复核秘书摘要和关键决策。不允许只回复“已收到”、由主人格自己长时间处理，或等下一次 heartbeat。",
      "计划暂停或秘书轮转不能清空业务 taskBinding；只有业务任务确实失效并完成受控迁移时才改绑。计划完成后仍可保留 taskBinding 作为历史证据。",
      "有多个计划时并行使用秘书槽管理不同计划分片；同一 planId 同时只能有一个控制面 writer，不同计划不能被某个 active cycle 全局阻塞。共享账本只合并目标记录并原子写入。本轮结束前校验：可推进但无人管理的计划数 = 0，且可推进但空闲的业务任务数 = 0。active/in-progress 业务任务不要重复投递。",
      "只有当前步骤具有完整、可提交且 responseStatus=pending 的 approvalRequest 时，Manager 才自动派生审批阻塞；isBlocked 是兼容投影，不得手写。审批合同不完整时计划保持进行中，由秘书继续调查、补证据和补齐合同；待 QA、缺资料、执行失败、工具超时、外部产物或普通负责人等待必须通过询问、重试、改道、拆分、升级或替代路径继续推进，不能占用阻塞。",
      ...planAssistantLines
    ]) : "",
    hasPersona ? section("处理前上下文确认", requiredReadIndex) : "",
    personaSyncHint ? section("多电脑人格同步", personaSyncHint) : "",
    voiceIdentityReviewHint ? section("全天语音与声纹归类", voiceIdentityReviewHint) : "",
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
