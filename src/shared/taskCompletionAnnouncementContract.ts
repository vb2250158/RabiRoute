export const TASK_COMPLETION_ANNOUNCEMENT_MAX_CHARS = 1_000;
export const TASK_COMPLETION_ANNOUNCEMENT_DEFAULT_MAX_CHARS = 420;

export type TaskCompletionAnnouncementSource = "codex" | "dsh";
export type TaskCompletionAnnouncementStatus = "completed" | "failed";

export type TaskCompletionAnnouncementSourceSettings = {
  enabled: boolean;
  announceCompleted: boolean;
  announceFailed: boolean;
  includeChildTasks: boolean;
};

export type TaskCompletionAnnouncementSettings = {
  enabled: boolean;
  voice: string;
  maxChars: number;
  redactSensitive: boolean;
  cleanMarkdown: boolean;
  sources: Record<TaskCompletionAnnouncementSource, TaskCompletionAnnouncementSourceSettings>;
};

export type TaskCompletionAnnouncementEvent = {
  id?: string;
  source: TaskCompletionAnnouncementSource;
  sessionId: string;
  turnId?: string;
  status: TaskCompletionAnnouncementStatus;
  text: string;
  taskName?: string;
  isChild?: boolean;
  occurredAt?: string;
};

export type TaskCompletionAnnouncementRecord = {
  id: string;
  source: TaskCompletionAnnouncementSource;
  sessionId: string;
  turnId: string;
  status: TaskCompletionAnnouncementStatus;
  taskName?: string;
  isChild: boolean;
  occurredAt: string;
  receivedAt: string;
  decision: "spoken" | "ignored" | "failed";
  reason?: string;
  textHash: string;
  playbackJobId?: string;
};

export type TaskCompletionAnnouncementReceipt = {
  accepted: boolean;
  duplicate: boolean;
  spoken: boolean;
  eventId: string;
  reason?: string;
  playbackJobId?: string;
};

const defaultSource = (enabled: boolean): TaskCompletionAnnouncementSourceSettings => ({
  enabled,
  announceCompleted: true,
  announceFailed: false,
  includeChildTasks: false
});

export const DEFAULT_TASK_COMPLETION_ANNOUNCEMENT_SETTINGS: TaskCompletionAnnouncementSettings = {
  // Keep the established Codex completion voice behaviour after migration.
  enabled: true,
  voice: "YeYu",
  maxChars: TASK_COMPLETION_ANNOUNCEMENT_DEFAULT_MAX_CHARS,
  redactSensitive: true,
  cleanMarkdown: true,
  sources: {
    codex: defaultSource(true),
    dsh: defaultSource(false)
  }
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceSettings(value: unknown, fallback: TaskCompletionAnnouncementSourceSettings): TaskCompletionAnnouncementSourceSettings {
  const row = record(value);
  return {
    enabled: row.enabled === true,
    announceCompleted: row.announceCompleted !== false,
    announceFailed: row.announceFailed === true,
    includeChildTasks: row.includeChildTasks === true
  };
}

export function normalizeTaskCompletionAnnouncementSettings(value: unknown): TaskCompletionAnnouncementSettings {
  const row = record(value);
  const sources = record(row.sources);
  return {
    enabled: row.enabled !== false,
    voice: typeof row.voice === "string" && row.voice.trim() ? row.voice.trim().slice(0, 200) : "YeYu",
    maxChars: Math.max(40, Math.min(
      TASK_COMPLETION_ANNOUNCEMENT_MAX_CHARS,
      Math.trunc(typeof row.maxChars === "number" ? row.maxChars : TASK_COMPLETION_ANNOUNCEMENT_DEFAULT_MAX_CHARS)
    )),
    redactSensitive: row.redactSensitive !== false,
    cleanMarkdown: row.cleanMarkdown !== false,
    sources: {
      codex: sourceSettings(sources.codex, DEFAULT_TASK_COMPLETION_ANNOUNCEMENT_SETTINGS.sources.codex),
      dsh: sourceSettings(sources.dsh, DEFAULT_TASK_COMPLETION_ANNOUNCEMENT_SETTINGS.sources.dsh)
    }
  };
}
