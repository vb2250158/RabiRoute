import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import {
  DEFAULT_TASK_COMPLETION_ANNOUNCEMENT_SETTINGS,
  normalizeTaskCompletionAnnouncementSettings,
  type TaskCompletionAnnouncementEvent,
  type TaskCompletionAnnouncementReceipt,
  type TaskCompletionAnnouncementRecord,
  type TaskCompletionAnnouncementSettings
} from "../shared/taskCompletionAnnouncementContract.js";

const maxRecentRecords = 40;
const maxSeenIds = 4_096;
const sensitiveValuePattern = /\b(token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b\s*[:=]\s*([^\s,;，；]+)/gi;
const markdownPrefixPattern = /^\s*(?:[-*+•]|\d+[.)]|\[[ xX]\])\s+/gm;
const markdownRulePattern = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm;

type TaskCompletionAnnouncementIndex = {
  recordClass: "task-completion-announcement-metadata";
  sourceOfTruth: "events/YYYY-MM-DD.jsonl";
  stableId: "id";
  orderBy: "receivedAt";
  activityAt: "receivedAt";
  action: "rotate";
  sourceRetention: "retained";
  idempotencyWindowRecords: number;
  recovery: "manual-rebuild-from-retained-shards";
  seenIds: string[];
  recent: TaskCompletionAnnouncementRecord[];
};

const indexContract = {
  recordClass: "task-completion-announcement-metadata",
  sourceOfTruth: "events/YYYY-MM-DD.jsonl",
  stableId: "id",
  orderBy: "receivedAt",
  activityAt: "receivedAt",
  action: "rotate",
  sourceRetention: "retained",
  idempotencyWindowRecords: maxSeenIds,
  recovery: "manual-rebuild-from-retained-shards"
} as const;

export function taskCompletionAnnouncementDataRoot(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "RabiPC", "RabiRoute", "task-completion-announcements");
}

export function taskCompletionAnnouncementSettingsPath(): string {
  return path.join(taskCompletionAnnouncementDataRoot(), "settings.json");
}

function cloneSettings(settings: TaskCompletionAnnouncementSettings): TaskCompletionAnnouncementSettings {
  return JSON.parse(JSON.stringify(settings)) as TaskCompletionAnnouncementSettings;
}

function readIndex(filePath: string): TaskCompletionAnnouncementIndex {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TaskCompletionAnnouncementIndex>;
    return {
      ...indexContract,
      seenIds: Array.isArray(value.seenIds) ? value.seenIds.filter((id): id is string => typeof id === "string").slice(-maxSeenIds) : [],
      recent: Array.isArray(value.recent) ? value.recent.slice(0, maxRecentRecords) as TaskCompletionAnnouncementRecord[] : []
    };
  } catch {
    return { ...indexContract, seenIds: [], recent: [] };
  }
}

export class TaskCompletionAnnouncementSettingsStore {
  constructor(private readonly filePath = taskCompletionAnnouncementSettingsPath()) {}

  read(): TaskCompletionAnnouncementSettings {
    try {
      return normalizeTaskCompletionAnnouncementSettings(JSON.parse(fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "")));
    } catch {
      return cloneSettings(DEFAULT_TASK_COMPLETION_ANNOUNCEMENT_SETTINGS);
    }
  }

  write(value: unknown): TaskCompletionAnnouncementSettings {
    const settings = normalizeTaskCompletionAnnouncementSettings(value);
    atomicWriteFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  }
}

export class TaskCompletionAnnouncementLedger {
  private readonly indexFile: string;
  private readonly eventsRoot: string;

  constructor(root = taskCompletionAnnouncementDataRoot()) {
    this.indexFile = path.join(root, "event-index.json");
    this.eventsRoot = path.join(root, "events");
  }

  has(id: string): boolean {
    return readIndex(this.indexFile).seenIds.includes(id);
  }

  list(limit = 12): TaskCompletionAnnouncementRecord[] {
    return readIndex(this.indexFile).recent.slice(0, Math.max(1, Math.min(maxRecentRecords, Math.trunc(limit) || 12)));
  }

  append(record: TaskCompletionAnnouncementRecord): void {
    const index = readIndex(this.indexFile);
    const receivedDate = /^\d{4}-\d{2}-\d{2}/.exec(record.receivedAt)?.[0] ?? new Date().toISOString().slice(0, 10);
    const eventFile = path.join(this.eventsRoot, `${receivedDate}.jsonl`);
    fs.mkdirSync(this.eventsRoot, { recursive: true });
    fs.appendFileSync(eventFile, `${JSON.stringify(record)}\n`, "utf8");
    const seenIds = [...index.seenIds.filter(id => id !== record.id), record.id].slice(-maxSeenIds);
    const recent = [record, ...index.recent.filter(item => item.id !== record.id)].slice(0, maxRecentRecords);
    atomicWriteFileSync(this.indexFile, `${JSON.stringify({ ...indexContract, seenIds, recent }, null, 2)}\n`);
  }
}

function normalizeText(text: string, settings: TaskCompletionAnnouncementSettings): string {
  let value = String(text || "").replace(/\r\n?/g, "\n");
  if (settings.redactSensitive) value = value.replace(sensitiveValuePattern, "$1：----");
  if (settings.cleanMarkdown) {
    value = value.replace(markdownRulePattern, "；").replace(markdownPrefixPattern, "");
    value = value.replace(/`([^`]+)`/g, "$1").replace(/#{1,6}\s*/g, "");
  }
  return value.replace(/\s+/g, " ").replace(/[；;]{2,}/g, "；").trim().slice(0, settings.maxChars);
}

function eventId(event: TaskCompletionAnnouncementEvent): string {
  const supplied = String(event.id || "").trim();
  if (supplied) return supplied.slice(0, 240);
  const turnId = String(event.turnId || "").trim();
  return `${event.source}:${String(event.sessionId || "").trim()}:${turnId || crypto.createHash("sha256").update(String(event.text || "")).digest("hex").slice(0, 16)}`.slice(0, 240);
}

function shouldAnnounce(event: TaskCompletionAnnouncementEvent, settings: TaskCompletionAnnouncementSettings): string | null {
  if (!settings.enabled) return "globally_disabled";
  const source = settings.sources[event.source];
  if (!source.enabled) return "source_disabled";
  if (event.isChild && !source.includeChildTasks) return "child_task_disabled";
  if (event.status === "completed" && !source.announceCompleted) return "completed_disabled";
  if (event.status === "failed" && !source.announceFailed) return "failed_disabled";
  return null;
}

export type TaskCompletionAnnouncementServiceDependencies = {
  settings: TaskCompletionAnnouncementSettingsStore;
  ledger: TaskCompletionAnnouncementLedger;
  synthesize: (command: {
    model: string;
    input: string;
    voice: string;
    responseFormat: string;
    speed: number;
    language: string | null;
    instructions: string | null;
    play: boolean;
    sessionId: string | null;
    routeId: string | null;
  }) => Promise<{ headers: Record<string, string | string[] | undefined> }>;
  resolveModel: () => Promise<string>;
  now?: () => Date;
};

export class TaskCompletionAnnouncementService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: TaskCompletionAnnouncementServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  settings(): TaskCompletionAnnouncementSettings {
    return this.dependencies.settings.read();
  }

  updateSettings(value: unknown): TaskCompletionAnnouncementSettings {
    return this.dependencies.settings.write(value);
  }

  records(limit?: number): TaskCompletionAnnouncementRecord[] {
    return this.dependencies.ledger.list(limit);
  }

  async preview(): Promise<TaskCompletionAnnouncementReceipt> {
    return this.accept({
      id: `preview:${this.now().toISOString()}`,
      source: "codex",
      sessionId: "rabi-tts-settings-preview",
      status: "completed",
      text: "任务完成播报已接入 Rabi 的全局播放队列。",
      taskName: "语音消息端"
    }, true);
  }

  async accept(event: TaskCompletionAnnouncementEvent, preview = false): Promise<TaskCompletionAnnouncementReceipt> {
    const settings = this.settings();
    const id = eventId(event);
    if (!event.source || !settings.sources[event.source]) throw new Error("Unsupported task announcement source.");
    if (!String(event.sessionId || "").trim()) throw new Error("Task announcement sessionId is required.");
    if (!String(event.text || "").trim()) throw new Error("Task announcement text is required.");
    if (!preview && this.dependencies.ledger.has(id)) return { accepted: true, duplicate: true, spoken: false, eventId: id, reason: "duplicate" };

    const now = this.now().toISOString();
    const reason = preview ? null : shouldAnnounce(event, settings);
    const text = normalizeText(event.text, settings);
    const taskName = normalizeText(event.taskName || "", settings);
    const base: Omit<TaskCompletionAnnouncementRecord, "decision" | "reason" | "playbackJobId"> = {
      id,
      source: event.source,
      sessionId: String(event.sessionId).trim().slice(0, 200),
      turnId: String(event.turnId || "").trim().slice(0, 200),
      status: event.status,
      ...(taskName ? { taskName } : {}),
      isChild: event.isChild === true,
      occurredAt: String(event.occurredAt || now),
      receivedAt: now,
      textHash: crypto.createHash("sha256").update(text).digest("hex")
    };
    if (reason || !text) {
      if (!preview) this.dependencies.ledger.append({ ...base, decision: "ignored", reason: reason || "empty_after_normalization" });
      return { accepted: true, duplicate: false, spoken: false, eventId: id, reason: reason || "empty_after_normalization" };
    }
    const announcement = `${taskName ? `《${taskName}》` : "任务"}${event.status === "failed" ? "未完成" : "已完成"}：${text}`;
    try {
      const model = await this.dependencies.resolveModel();
      if (!model) throw new Error("No local TTS model is available for task announcements.");
      const result = await this.dependencies.synthesize({
        model,
        input: announcement,
        voice: settings.voice,
        responseFormat: "wav",
        speed: 1,
        language: "zh",
        instructions: "用夜雨清楚、自然、简短的中文播报任务完成总结。",
        play: true,
        sessionId: `task-announcement-${event.source}-${base.sessionId}`.slice(0, 200),
        routeId: "rabi-task-completion"
      });
      const playbackJob = result.headers["x-rabispeech-playback-job"];
      const playbackJobId = Array.isArray(playbackJob) ? playbackJob[0] : playbackJob;
      if (!preview) this.dependencies.ledger.append({ ...base, decision: "spoken", ...(playbackJobId ? { playbackJobId } : {}) });
      return { accepted: true, duplicate: false, spoken: true, eventId: id, ...(playbackJobId ? { playbackJobId } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!preview) this.dependencies.ledger.append({ ...base, decision: "failed", reason: message.slice(0, 500) });
      return { accepted: true, duplicate: false, spoken: false, eventId: id, reason: message };
    }
  }
}
