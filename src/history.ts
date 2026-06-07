import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type GroupMessageRecord = {
  time: number;
  groupId: number;
  userId: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  routeKind?: string;
  repliedMessageId?: string;
};

export type PrivateMessageRecord = {
  time: number;
  userId: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
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

export type VoiceTranscriptEventRecord = {
  time: number;
  rawMessage: string;
  messageId?: number | string;
  senderName?: string;
  source?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceArea?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
};

export type CodexNotificationRecord = {
  id: string;
  time: number;
  kind: "private" | "group_mention" | "heartbeat" | "manual_trigger" | "voice_transcript";
  text: string;
};

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

function voiceTranscriptLogPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "voice-transcripts.jsonl");
}

export function appendVoiceTranscriptEvent(record: VoiceTranscriptEventRecord): void {
  fs.appendFileSync(voiceTranscriptLogPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendVoiceTranscriptEventToDir(record: VoiceTranscriptEventRecord, dataDir: string): void {
  fs.appendFileSync(voiceTranscriptLogPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
}

function codexNotificationPath(dataDir = config.memoryDataDir): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "codex-notifications.jsonl");
}

export function appendCodexNotification(record: CodexNotificationRecord): void {
  fs.appendFileSync(codexNotificationPath(), `${JSON.stringify(record)}\n`, "utf8");
}

export function appendCodexNotificationToDir(record: CodexNotificationRecord, dataDir: string): void {
  fs.appendFileSync(codexNotificationPath(dataDir), `${JSON.stringify(record)}\n`, "utf8");
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
