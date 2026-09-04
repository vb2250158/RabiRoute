import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { measureSyncPerformanceOperation } from "./performance/performanceInstrumentation.js";
import { withFileLockSync } from "./shared/filePersistence.js";
import { PERFORMANCE_OPERATIONS } from "./shared/performanceOperations.js";
import type { ResolvedForwardMessage } from "./napcatForwardMessages.js";
import type { SpeechTranscriptSegment } from "./shared/speechControlContract.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";

export type MessageAttachmentRecord = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  name: string;
  mimeType?: string;
  size?: number;
  path?: string;
  status: "ready" | "unavailable";
  error?: string;
  sourceMessageId?: string;
};

export type GroupMessageRecord = {
  time: number;
  groupId: number;
  userId: number;
  rawMessage: string;
  originalRawMessage?: string;
  forwardedMessages?: ResolvedForwardMessage[];
  messageId?: number | string;
  senderName?: string;
  routeKind?: string;
  repliedMessageId?: string;
  instanceId?: string;
  adapterType?: string;
  botUserId?: string;
  botNickname?: string;
  isSelf?: boolean;
  lookupSource?: "onebot_get_msg";
  attachments?: MessageAttachmentRecord[];
  segments?: unknown[];
};

export type PrivateMessageRecord = {
  time: number;
  userId: number;
  rawMessage: string;
  originalRawMessage?: string;
  forwardedMessages?: ResolvedForwardMessage[];
  messageId?: number | string;
  senderName?: string;
  instanceId?: string;
  adapterType?: string;
  botUserId?: string;
  botNickname?: string;
  isSelf?: boolean;
  lookupSource?: "onebot_get_msg";
  attachments?: MessageAttachmentRecord[];
  segments?: unknown[];
};

export type HeartbeatEventRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  intervalSeconds?: number;
};

export type ManualTriggerRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  triggerId?: string;
  triggerName?: string;
  triggerSource?: "manual" | "auto";
  intervalSeconds?: number;
};

export type RolePanelMessageRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  roleId?: string;
  gatewayId?: string;
  routeProfileId?: string;
  attachments?: unknown[];
  replyContext?: Record<string, unknown>;
  adapterType?: "rolePanel";
};

export type PlanFeedbackMessageRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  roleId?: string;
  gatewayId?: string;
  routeProfileId?: string;
  attachments?: unknown[];
  replyContext?: Record<string, unknown>;
  adapterType: "planFeedback";
};

export type VoiceTranscriptEventRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  adapterType?: string;
  /** Stable non-secret identity of the configured message endpoint, when supplied by a generic adapter. */
  identityNamespace?: string;
  /** Stable sender/account ID inside identityNamespace for non-voice generic messages. */
  senderStableId?: string;
  /** Set only by an authenticated adapter after it derives the sender account itself. */
  senderIdentityTrusted?: boolean;
  /** Set only by the host that performed voiceprint processing; remote payloads cannot grant this flag. */
  voiceIdentityTrusted?: boolean;
  gatewayId?: string;
  instanceId?: string;
  source?: string;
  channelType?: string;
  messageAdapterType?: "speech" | "rabilink";
  speakerId?: string;
  speakerName?: string;
  speakerKind?: string;
  speakerConfidence?: number;
  speakerDecision?: string;
  voiceprintId?: string;
  speakerVerified?: boolean;
  provider?: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  audioFormat?: string;
  channels?: number;
  ingestedAt?: string;
  segments?: SpeechTranscriptSegment[];
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  sourceStreamId?: string;
  sourceHostId?: string;
  sourceHostName?: string;
  transport?: string;
  sourceArea?: string;
  sessionId?: string;
  /** Explicit mobile message-endpoint target; absent keeps rule-based fan-out. */
  routeProfileId?: string;
  configurationRequested?: boolean;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
  rms?: number;
};

export type WeComMessageRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  adapterType: "wecom";
  reqId?: string;
  conversationId?: string;
  chatId?: string;
  groupId?: string;
  userId?: string;
  senderId?: string;
  /** Stable non-secret identity of the configured message endpoint, when available. */
  identityNamespace?: string;
  messageType?: string;
  repliedMessageId?: string;
  isSelf?: boolean;
  segments?: unknown[];
  raw?: unknown;
};

export type WeixinMessageRecord = {
  time: number;
  rawMessage: string;
  messageId: number | string;
  senderName?: string;
  adapterType: "weixin";
  sessionId: string;
  userId: string;
  /** Stable non-secret identity of the configured message endpoint, when available. */
  identityNamespace?: string;
  messageType: string;
  repliedMessageId?: string;
  quotedText?: string;
  attachments?: Array<{ path: string; name: string; mimeType: string; size: number }>;
  segments?: unknown[];
};

/** A Feishu chat event. Kept separate from generic webhooks and WeCom records. */
export type FeishuMessageRecord = {
  time: number;
  rawMessage: string;
  messageId: string;
  /** Feishu v2 event id. This is the durable callback idempotency key. */
  eventId: string;
  senderName?: string;
  adapterType: "feishu";
  chatId: string;
  groupId: string;
  userId: string;
  /** Stable non-secret identity of the configured message endpoint, when available. */
  identityNamespace?: string;
  messageType: string;
  raw?: unknown;
};

export type AgentPacketRecord = {
  id: string;
  time: number;
  kind: "private" | "group_mention" | "heartbeat" | "manual_trigger" | "role_panel_message" | "plan_feedback" | "voice_transcript" | "rabilink" | "wearable_health_alert" | "wecom_message" | "weixin_message" | "feishu_message" | "xiaomi_home_event";
  text: string;
};

export type AdapterLogRecord = {
  time: number;
  adapter: string;
  event: string;
  level?: "info" | "warning" | "error";
  instanceId?: string;
  message?: string;
  data?: unknown;
};

function appendHistoryRecord(filePath: string, record: unknown): void {
  const fileName = path.basename(filePath);
  const fields = record && typeof record === "object" && !Array.isArray(record)
    ? record as Record<string, unknown>
    : {};
  const recordId = String(fields.id ?? fields.eventId ?? fields.messageId ?? fields.recordId ?? fields.deliveryId ?? fields.time ?? "record").trim();
  try {
    measureSyncPerformanceOperation(PERFORMANCE_OPERATIONS.runtimeHistoryAppend, () => {
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: fileName.includes("adapter.log") ? "adapter" : "conversation",
      event: "runtime_history_append_failed",
      owner: "runtime-history",
      action: "append",
      target: { type: "history-record", id: recordId || "record" },
      dataSource: { kind: "ledger", id: `route-data/${fileName}` },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: fileName.includes("adapter.log") ? "adapter" : "conversation",
    event: "runtime_history_appended",
    owner: "runtime-history",
    action: "append",
    target: { type: "history-record", id: recordId || "record" },
    dataSource: { kind: "ledger", id: `route-data/${fileName}` },
    outcome: "committed",
    after: { revision: recordId || String(fields.time ?? "appended") }
  });
}

function adapterLogPath(adapter: string, dataDir = config.dataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, `${adapter}-adapter.log.jsonl`);
}

export function appendAdapterLog(adapter: string, record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>): void {
  const normalized: AdapterLogRecord = {
    time: Math.floor(Date.now() / 1000),
    level: "info",
    ...record,
    adapter
  };
  appendHistoryRecord(adapterLogPath(adapter), normalized);
}

export function appendAdapterLogToDir(adapter: string, record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>, dataDir: string): void {
  const normalized: AdapterLogRecord = {
    time: Math.floor(Date.now() / 1000),
    level: "info",
    ...record,
    adapter
  };
  appendHistoryRecord(adapterLogPath(adapter, dataDir), normalized);
}

function logPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "group-messages.jsonl");
}

export function appendGroupMessage(record: GroupMessageRecord): void {
  appendHistoryRecord(logPath(), record);
}

export function appendGroupMessageToDir(record: GroupMessageRecord, dataDir: string): void {
  appendHistoryRecord(logPath(dataDir), record);
}

function privateLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "private-messages.jsonl");
}

export function appendPrivateMessage(record: PrivateMessageRecord): void {
  appendHistoryRecord(privateLogPath(), record);
}

export function appendPrivateMessageToDir(record: PrivateMessageRecord, dataDir: string): void {
  appendHistoryRecord(privateLogPath(dataDir), record);
}

function heartbeatLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "heartbeat-events.jsonl");
}

export function appendHeartbeatEvent(record: HeartbeatEventRecord): void {
  appendHistoryRecord(heartbeatLogPath(), record);
}

export function appendHeartbeatEventToDir(record: HeartbeatEventRecord, dataDir: string): void {
  appendHistoryRecord(heartbeatLogPath(dataDir), record);
}

function manualTriggerLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "manual-trigger-events.jsonl");
}

export function appendManualTriggerEvent(record: ManualTriggerRecord): void {
  appendHistoryRecord(manualTriggerLogPath(), record);
}

export function appendManualTriggerEventToDir(record: ManualTriggerRecord, dataDir: string): void {
  appendHistoryRecord(manualTriggerLogPath(dataDir), record);
}

function voiceTranscriptLogPath(dataDir = config.memoryDataDir, fileName = "voice-transcripts.jsonl"): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, fileName);
}

function voiceTranscriptIdentity(record: VoiceTranscriptEventRecord): string {
  const messageId = String(record.messageId ?? "").trim();
  if (!messageId) return "";
  return `${String(record.adapterType ?? "voice").trim().toLowerCase()}|${messageId}`;
}

function appendVoiceTranscriptOnce(filePath: string, record: VoiceTranscriptEventRecord): boolean {
  const identity = voiceTranscriptIdentity(record);
  const lockPath = `${filePath}.lock`;
  return withFileLockSync(lockPath, () => {
    if (identity && fs.existsSync(filePath)) {
      const duplicate = measureSyncPerformanceOperation(
        PERFORMANCE_OPERATIONS.runtimeHistoryDuplicateScan,
        () => fs.readFileSync(filePath, "utf8").split(/\r?\n/).some(line => {
          if (!line.trim()) return false;
          try {
            return voiceTranscriptIdentity(JSON.parse(line) as VoiceTranscriptEventRecord) === identity;
          } catch {
            return false;
          }
        })
      );
      if (duplicate) return false;
    }
    appendHistoryRecord(filePath, record);
    return true;
  });
}

export function appendVoiceTranscriptEvent(record: VoiceTranscriptEventRecord): void {
  appendVoiceTranscriptOnce(voiceTranscriptLogPath(), record);
}

export function appendVoiceTranscriptEventToDir(record: VoiceTranscriptEventRecord, dataDir: string): void {
  appendVoiceTranscriptOnce(voiceTranscriptLogPath(dataDir), record);
}

function voiceTranscriptFileNameForAdapter(adapter: string): string {
  if (adapter === "speech") return "speech-voice-transcripts.jsonl";
  if (adapter === "fennenote") return "fennenote-voice-transcripts.jsonl";
  if (adapter === "xiaoai") return "xiaoai-voice-transcripts.jsonl";
  if (adapter === "rabilink") return "rabilink-voice-transcripts.jsonl";
  return "voice-transcripts.jsonl";
}

export function appendVoiceTranscriptEventForAdapter(adapter: string, record: VoiceTranscriptEventRecord): void {
  appendVoiceTranscriptEventForAdapterToDir(adapter, record, config.memoryDataDir);
}

export function appendVoiceTranscriptEventForAdapterToDir(
  adapter: string,
  record: VoiceTranscriptEventRecord,
  dataDir: string
): void {
  const normalized = {
    ...record,
    adapterType: record.adapterType ?? adapter
  };
  appendVoiceTranscriptOnce(voiceTranscriptLogPath(dataDir, voiceTranscriptFileNameForAdapter(adapter)), normalized);
  if (adapter !== "webhook") {
    appendVoiceTranscriptOnce(voiceTranscriptLogPath(dataDir), normalized);
  }
}

function wecomLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "wecom-messages.jsonl");
}

export function appendWeComMessage(record: WeComMessageRecord): void {
  appendHistoryRecord(wecomLogPath(), record);
}

export function appendWeComMessageToDir(record: WeComMessageRecord, dataDir: string): void {
  appendHistoryRecord(wecomLogPath(dataDir), record);
}

function feishuLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "feishu-messages.jsonl");
}

function feishuEventIdentity(record: Pick<FeishuMessageRecord, "eventId" | "messageId">): string {
  return String(record.eventId || record.messageId || "").trim();
}

function appendFeishuMessageOnce(filePath: string, record: FeishuMessageRecord): boolean {
  const identity = feishuEventIdentity(record);
  const lockPath = `${filePath}.lock`;
  return withFileLockSync(lockPath, () => {
    if (identity && fs.existsSync(filePath)) {
      const duplicate = measureSyncPerformanceOperation(
        PERFORMANCE_OPERATIONS.runtimeHistoryDuplicateScan,
        () => fs.readFileSync(filePath, "utf8").split(/\r?\n/).some((line) => {
          if (!line.trim()) return false;
          try {
            return feishuEventIdentity(JSON.parse(line) as FeishuMessageRecord) === identity;
          } catch {
            return false;
          }
        })
      );
      if (duplicate) return false;
    }
    appendHistoryRecord(filePath, record);
    return true;
  });
}

export function appendFeishuMessage(record: FeishuMessageRecord): boolean {
  return appendFeishuMessageOnce(feishuLogPath(), record);
}

export function appendFeishuMessageToDir(record: FeishuMessageRecord, dataDir: string): boolean {
  return appendFeishuMessageOnce(feishuLogPath(dataDir), record);
}

function weixinLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "weixin-messages.jsonl");
}

export function appendWeixinMessage(record: WeixinMessageRecord): void {
  appendHistoryRecord(weixinLogPath(), record);
}

export function appendWeixinMessageToDir(record: WeixinMessageRecord, dataDir: string): void {
  appendHistoryRecord(weixinLogPath(dataDir), record);
}

function agentPacketPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "agent-packets.jsonl");
}

export function appendAgentPacket(record: AgentPacketRecord): void {
  appendHistoryRecord(agentPacketPath(), record);
}

export function appendAgentPacketToDir(record: AgentPacketRecord, dataDir: string): void {
  appendHistoryRecord(agentPacketPath(dataDir), record);
}

export function readGroupMessages(dataDir = config.memoryDataDir): GroupMessageRecord[] {
  if (!fs.existsSync(logPath(dataDir))) {
    return [];
  }

  return fs
    .readFileSync(logPath(dataDir), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GroupMessageRecord);
}

export function readPrivateMessages(dataDir = config.memoryDataDir): PrivateMessageRecord[] {
  if (!fs.existsSync(privateLogPath(dataDir))) {
    return [];
  }

  return fs
    .readFileSync(privateLogPath(dataDir), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PrivateMessageRecord);
}

export function searchMessages(keyword: string, limit = 10): GroupMessageRecord[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return readGroupMessages()
    .filter((message) => message.rawMessage.toLowerCase().includes(normalized))
    .slice(-limit)
    .reverse();
}

export function todayMessages(groupId: number): GroupMessageRecord[] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return readGroupMessages().filter((message) => {
    return message.groupId === groupId && message.time * 1000 >= start;
  });
}
