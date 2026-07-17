import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { ResolvedForwardMessage } from "./napcatForwardMessages.js";

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
  source?: string;
  speakerId?: string;
  speakerName?: string;
  speakerKind?: string;
  speakerConfidence?: number;
  speakerDecision?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  transport?: string;
  sourceArea?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
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
  kind: "private" | "group_mention" | "heartbeat" | "manual_trigger" | "role_panel_message" | "voice_transcript" | "rabilink" | "wecom_message";
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

export function appendVoiceTranscriptEvent(record: VoiceTranscriptEventRecord): void {
  fs.appendFileSync(voiceTranscriptLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendVoiceTranscriptEventToDir(record: VoiceTranscriptEventRecord, dataDir: string): void {
  fs.appendFileSync(voiceTranscriptLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function voiceTranscriptFileNameForAdapter(adapter: string): string {
  if (adapter === "speech") return "speech-voice-transcripts.jsonl";
  if (adapter === "fennenote") return "fennenote-voice-transcripts.jsonl";
  if (adapter === "xiaoai") return "xiaoai-voice-transcripts.jsonl";
  if (adapter === "rabilink") return "rabilink-voice-transcripts.jsonl";
  return "voice-transcripts.jsonl";
}

export function appendVoiceTranscriptEventForAdapter(adapter: string, record: VoiceTranscriptEventRecord): void {
  const normalized = {
    ...record,
    adapterType: record.adapterType ?? adapter
  };
  fs.appendFileSync(voiceTranscriptLogPath(config.memoryDataDir, voiceTranscriptFileNameForAdapter(adapter)), `${JSON.stringify(normalized)}\n`, "utf8");
  if (adapter !== "webhook") {
    fs.appendFileSync(voiceTranscriptLogPath(config.memoryDataDir), `${JSON.stringify(normalized)}\n`, "utf8");
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

export function readGroupMessages(): GroupMessageRecord[] {
  if (!fs.existsSync(logPath())) {
    return [];
  }

  return fs
    .readFileSync(logPath(), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GroupMessageRecord);
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
