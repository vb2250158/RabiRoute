import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { withFileLockSync } from "./shared/filePersistence.js";
import type { ResolvedForwardMessage } from "./napcatForwardMessages.js";
import type { SpeechTranscriptSegment } from "./shared/speechControlContract.js";

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
  adapterType?: "rolePanel";
};

export type VoiceTranscriptEventRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  adapterType?: string;
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
  messageType?: string;
  repliedMessageId?: string;
  isSelf?: boolean;
  segments?: unknown[];
  raw?: unknown;
};

export type AgentPacketRecord = {
  id: string;
  time: number;
  kind: "private" | "group_mention" | "heartbeat" | "manual_trigger" | "role_panel_message" | "voice_transcript" | "rabilink" | "wearable_health_alert" | "wecom_message";
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
  fs.appendFileSync(adapterLogPath(adapter), `${JSON.stringify(normalized)}\n`, "utf8");
}

export function appendAdapterLogToDir(adapter: string, record: Omit<AdapterLogRecord, "adapter" | "time"> & Partial<AdapterLogRecord>, dataDir: string): void {
  const normalized: AdapterLogRecord = {
    time: Math.floor(Date.now() / 1000),
    level: "info",
    ...record,
    adapter
  };
  fs.appendFileSync(adapterLogPath(adapter, dataDir), `${JSON.stringify(normalized)}\n`, "utf8");
}

function logPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "group-messages.jsonl");
}

export function appendGroupMessage(record: GroupMessageRecord): void {
  fs.appendFileSync(logPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendGroupMessageToDir(record: GroupMessageRecord, dataDir: string): void {
  fs.appendFileSync(logPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function privateLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "private-messages.jsonl");
}

export function appendPrivateMessage(record: PrivateMessageRecord): void {
  fs.appendFileSync(privateLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendPrivateMessageToDir(record: PrivateMessageRecord, dataDir: string): void {
  fs.appendFileSync(privateLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function heartbeatLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "heartbeat-events.jsonl");
}

export function appendHeartbeatEvent(record: HeartbeatEventRecord): void {
  fs.appendFileSync(heartbeatLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendHeartbeatEventToDir(record: HeartbeatEventRecord, dataDir: string): void {
  fs.appendFileSync(heartbeatLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function manualTriggerLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "manual-trigger-events.jsonl");
}

export function appendManualTriggerEvent(record: ManualTriggerRecord): void {
  fs.appendFileSync(manualTriggerLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendManualTriggerEventToDir(record: ManualTriggerRecord, dataDir: string): void {
  fs.appendFileSync(manualTriggerLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
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
      const duplicate = fs.readFileSync(filePath, "utf8").split(/\r?\n/).some(line => {
        if (!line.trim()) return false;
        try {
          return voiceTranscriptIdentity(JSON.parse(line) as VoiceTranscriptEventRecord) === identity;
        } catch {
          return false;
        }
      });
      if (duplicate) return false;
    }
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
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
  fs.appendFileSync(wecomLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendWeComMessageToDir(record: WeComMessageRecord, dataDir: string): void {
  fs.appendFileSync(wecomLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function agentPacketPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "agent-packets.jsonl");
}

export function appendAgentPacket(record: AgentPacketRecord): void {
  fs.appendFileSync(agentPacketPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendAgentPacketToDir(record: AgentPacketRecord, dataDir: string): void {
  fs.appendFileSync(agentPacketPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
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
