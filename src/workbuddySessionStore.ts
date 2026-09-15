/**
 * WorkBuddy (Tencent AI office workbench) session store.
 *
 * WorkBuddy runs one session process per task. Each live process publishes a
 * descriptor under `<workbuddyHome>/sessions/<pid>.json`, and the desktop task
 * list itself is authoritative in `<workbuddyHome>/workbuddy.db` (`sessions`
 * table). This module owns discovery for the WorkBuddy agent endpoint: reading
 * those two sources, normalizing workspaces, and resolving the single task that
 * a delivery may target.
 *
 * Status: discovery and resolution only. Delivery is not implemented yet; the
 * gateway credential acquisition path and the desktop-visibility contract are
 * still open (see docs/workbuddy-agent-adapter-plan.md).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The desktop treats a heartbeat older than this as a dead session process. */
export const WORKBUDDY_SESSION_STALE_MS = 120_000;

/** Session kinds that must never be used as a delivery target. */
const NON_DELIVERABLE_KINDS = new Set(["prewarm", "teammate"]);

export type WorkbuddySessionDescriptor = {
  pid: number;
  sessionId: string;
  kind: string;
  cwd?: string;
  endpoint?: string;
  mode?: string;
  version?: string;
  hostname?: string;
  startedAt?: number;
  lastHeartbeat?: number;
  updatedAt?: number;
  /** Named-pipe address published by prewarm workers; metadata operations only. */
  socketPath?: string;
  stale: boolean;
  processAlive: boolean;
  /** A live interactive session that exposes an authenticated loopback gateway. */
  deliverable: boolean;
};

export type WorkbuddyTaskRow = {
  id: string;
  cwd: string;
  title: string;
  customTitle: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  deletedAt: number;
  isPlayground: boolean;
  isBackgroundAutomation: boolean;
  mode: string;
  model: string;
};

export type WorkbuddyTask = {
  id: string;
  /** User-visible name: the user's own title when present, otherwise the auto title. */
  name: string;
  userNamed: boolean;
  /** Auto-generated title, kept separate because it must never drive name lookups. */
  autoTitle: string;
  workspace: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  background: boolean;
  mode: string;
  model: string;
  /** Live session process currently serving this task, when one exists. */
  live: { pid: number; endpoint: string; stale: boolean } | null;
};

export type WorkbuddyResolveResult =
  | { outcome: "bound"; task: WorkbuddyTask }
  | { outcome: "archived"; taskId: string }
  | { outcome: "candidates"; candidates: WorkbuddyTask[] }
  | { outcome: "missing"; requestedName: string; workspace: string }
  | { outcome: "invalid"; reason: string };

export function workbuddyHomeDir(): string {
  const configured = process.env.RABI_WORKBUDDY_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".workbuddy");
}

export function workbuddyDatabasePath(home = workbuddyHomeDir()): string {
  return path.join(home, "workbuddy.db");
}

export function workbuddySessionsDir(home = workbuddyHomeDir()): string {
  return path.join(home, "sessions");
}

/**
 * Canonical workspace comparison key. The desktop database stores
 * `C:\Data\Project`, the session gateway returns `c:\Data\Project`, and Windows
 * paths are case-insensitive, so drive letter case, separator style and a
 * trailing separator must all collapse. Keep the raw value for display.
 */
export function normalizeWorkbuddyWorkspace(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  let normalized = raw.replace(/\//g, "\\");
  normalized = normalized.replace(/\\{2,}/g, "\\");
  if (/^[a-zA-Z]:\\?$/.test(normalized)) normalized = `${normalized.slice(0, 2)}\\`;
  while (normalized.length > 3 && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  return normalized.toLocaleLowerCase();
}

/**
 * The desktop's compressed project directory name, e.g.
 * `C:\work\example` becomes `c-work-example`.
 * Case is meaningful here, so this must not use the lowercased comparison key.
 */
export function workbuddyProjectId(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim().replace(/\//g, "\\") : "";
  if (!raw) return "";
  return raw
    .replace(/^([a-zA-Z]):\\?/, (_match, drive: string) => `${drive.toLocaleLowerCase()}-`)
    .replace(/\\+$/, "")
    .replace(/\\+/g, "-");
}

export function sameWorkbuddyWorkspace(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeWorkbuddyWorkspace(left);
  const b = normalizeWorkbuddyWorkspace(right);
  return Boolean(a) && a === b;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function parseWorkbuddySessionDescriptor(
  value: unknown,
  options: { now?: number; alive?: (pid: number) => boolean } = {}
): WorkbuddySessionDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pid = finiteNumber(record.pid);
  const sessionId = nonEmptyString(record.sessionId);
  if (!pid || !sessionId) return null;
  const kind = nonEmptyString(record.kind) || "unknown";
  const lastHeartbeat = finiteNumber(record.lastHeartbeat) || undefined;
  const now = options.now ?? Date.now();
  const alive = (options.alive ?? isProcessAlive)(pid);
  const stale = !lastHeartbeat || now - lastHeartbeat > WORKBUDDY_SESSION_STALE_MS;
  const endpoint = nonEmptyString(record.endpoint) || nonEmptyString(record.url);
  const meta = record.meta && typeof record.meta === "object" ? record.meta as Record<string, unknown> : {};
  return {
    pid,
    sessionId,
    kind,
    ...(nonEmptyString(record.cwd) ? { cwd: nonEmptyString(record.cwd) } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(nonEmptyString(record.mode) ? { mode: nonEmptyString(record.mode) } : {}),
    ...(nonEmptyString(record.version) ? { version: nonEmptyString(record.version) } : {}),
    ...(nonEmptyString(record.hostname) ? { hostname: nonEmptyString(record.hostname) } : {}),
    ...(finiteNumber(record.startedAt) ? { startedAt: finiteNumber(record.startedAt) } : {}),
    ...(lastHeartbeat ? { lastHeartbeat } : {}),
    ...(finiteNumber(record.updatedAt) ? { updatedAt: finiteNumber(record.updatedAt) } : {}),
    ...(nonEmptyString(meta.socketPath) ? { socketPath: nonEmptyString(meta.socketPath) } : {}),
    stale,
    processAlive: alive,
    deliverable: !stale && alive && Boolean(endpoint) && !NON_DELIVERABLE_KINDS.has(kind)
  };
}

/**
 * Read every published session descriptor. Stale or dead entries are returned
 * as well, so callers can distinguish "task exists but its owner is gone" from
 * "task does not exist".
 */
export function listWorkbuddySessionDescriptors(options: {
  sessionsDir?: string;
  now?: number;
  alive?: (pid: number) => boolean;
} = {}): WorkbuddySessionDescriptor[] {
  const dir = options.sessionsDir ?? workbuddySessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const descriptors: WorkbuddySessionDescriptor[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const descriptor = parseWorkbuddySessionDescriptor(parsed, options);
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors.sort((left, right) => left.pid - right.pid);
}

const TASK_COLUMNS = `
  id, cwd, title, custom_title, status, created_at, updated_at, last_activity_at,
  deleted_at, is_playground, is_background_automation, mode, model
`;

function mapTaskRow(row: Record<string, unknown>): WorkbuddyTaskRow {
  const customTitle = nonEmptyString(row.custom_title);
  const title = nonEmptyString(row.title);
  return {
    id: nonEmptyString(row.id),
    cwd: nonEmptyString(row.cwd),
    title,
    customTitle,
    status: nonEmptyString(row.status),
    createdAt: finiteNumber(row.created_at),
    updatedAt: finiteNumber(row.updated_at),
    lastActivityAt: finiteNumber(row.last_activity_at) || finiteNumber(row.updated_at),
    deletedAt: finiteNumber(row.deleted_at),
    isPlayground: finiteNumber(row.is_playground) === 1,
    isBackgroundAutomation: finiteNumber(row.is_background_automation) === 1,
    mode: nonEmptyString(row.mode),
    model: nonEmptyString(row.model)
  };
}

/** Read the desktop task rows. Returns an empty list when the database is absent. */
export function readWorkbuddyTaskRows(databasePath = workbuddyDatabasePath()): WorkbuddyTaskRow[] {
  if (!fs.existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT ${TASK_COLUMNS} FROM sessions
      ORDER BY COALESCE(NULLIF(last_activity_at, 0), NULLIF(updated_at, 0), created_at) DESC
      LIMIT 10000
    `).all() as Record<string, unknown>[];
    return rows.map(mapTaskRow);
  } finally {
    database.close();
  }
}

export function listWorkbuddyWorkspaces(databasePath = workbuddyDatabasePath()): string[] {
  return [...new Set(readWorkbuddyTaskRows(databasePath)
    .filter(row => !row.deletedAt && row.cwd)
    .map(row => row.cwd))];
}

function toIso(value: number): string {
  return value > 0 ? new Date(value).toISOString() : "";
}

export function toWorkbuddyTask(
  row: WorkbuddyTaskRow,
  descriptors: WorkbuddySessionDescriptor[] = []
): WorkbuddyTask {
  const live = descriptors.find(descriptor =>
    descriptor.sessionId === row.id && Boolean(descriptor.endpoint));
  return {
    id: row.id,
    name: row.customTitle || row.title,
    userNamed: Boolean(row.customTitle),
    autoTitle: row.title,
    workspace: row.cwd,
    status: row.status,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt || row.lastActivityAt),
    archived: row.deletedAt > 0,
    background: row.isBackgroundAutomation,
    mode: row.mode,
    model: row.model,
    live: live && live.endpoint
      ? { pid: live.pid, endpoint: live.endpoint, stale: live.stale }
      : null
  };
}

export function listWorkbuddyTasks(options: {
  databasePath?: string;
  descriptors?: WorkbuddySessionDescriptor[];
  query?: string;
  workspace?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
} = {}): WorkbuddyTask[] {
  const descriptors = options.descriptors ?? listWorkbuddySessionDescriptors();
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const workspace = normalizeWorkbuddyWorkspace(options.workspace);
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 200) || 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  return readWorkbuddyTaskRows(options.databasePath)
    .filter(row => options.includeArchived || !row.deletedAt)
    .filter(row => !workspace || normalizeWorkbuddyWorkspace(row.cwd) === workspace)
    .map(row => toWorkbuddyTask(row, descriptors))
    .filter(task => !query
      || task.name.toLocaleLowerCase().includes(query)
      || task.autoTitle.toLocaleLowerCase().includes(query))
    .slice(offset, offset + limit);
}

export function readWorkbuddyTask(
  taskId: string,
  options: { databasePath?: string; descriptors?: WorkbuddySessionDescriptor[] } = {}
): WorkbuddyTask | null {
  const id = nonEmptyString(taskId);
  if (!id) return null;
  const row = readWorkbuddyTaskRows(options.databasePath).find(candidate => candidate.id === id);
  return row ? toWorkbuddyTask(row, options.descriptors ?? listWorkbuddySessionDescriptors()) : null;
}

/**
 * Standard resolver order, shared by the settings save commit point and real
 * delivery: exact ID, then saved name plus normalized workspace, newest
 * `updatedAt` wins, a tie asks the user, zero matches may create once.
 *
 * A stale or missing session process is reported through `task.live === null`
 * so callers fail closed instead of starting a replacement runtime.
 */
export function resolveWorkbuddyTask(input: {
  sessionId?: string;
  sessionName?: string;
  workspace?: string;
  databasePath?: string;
  descriptors?: WorkbuddySessionDescriptor[];
}): WorkbuddyResolveResult {
  const descriptors = input.descriptors ?? listWorkbuddySessionDescriptors();
  const rows = readWorkbuddyTaskRows(input.databasePath);
  const requestedId = nonEmptyString(input.sessionId);
  if (requestedId) {
    const byId = rows.find(row => row.id === requestedId);
    if (!byId) return { outcome: "invalid", reason: "保存的任务 ID 在当前 WorkBuddy 任务库中不存在。" };
    if (byId.deletedAt > 0) return { outcome: "archived", taskId: byId.id };
    const workspace = input.workspace?.trim();
    if (workspace && byId.cwd && !sameWorkbuddyWorkspace(workspace, byId.cwd)) {
      return {
        outcome: "invalid",
        reason: `绑定工作目录 ${workspace} 与任务实际目录 ${byId.cwd} 不一致，已停止投递。`
      };
    }
    return { outcome: "bound", task: toWorkbuddyTask(byId, descriptors) };
  }
  const requestedName = nonEmptyString(input.sessionName);
  if (!requestedName) return { outcome: "invalid", reason: "缺少任务 ID，也没有可用于查找的任务名称。" };
  const normalizedWorkspace = normalizeWorkbuddyWorkspace(input.workspace);
  const matches = rows
    .filter(row => !row.deletedAt)
    .filter(row => (row.customTitle || row.title) === requestedName)
    .filter(row => !normalizedWorkspace || normalizeWorkbuddyWorkspace(row.cwd) === normalizedWorkspace);
  if (matches.length === 0) {
    return { outcome: "missing", requestedName, workspace: input.workspace ?? "" };
  }
  if (matches.length === 1) {
    return { outcome: "bound", task: toWorkbuddyTask(matches[0], descriptors) };
  }
  const ordered = [...matches].sort((left, right) =>
    (right.updatedAt || right.lastActivityAt) - (left.updatedAt || left.lastActivityAt));
  const newest = ordered[0].updatedAt || ordered[0].lastActivityAt;
  const runnerUp = ordered[1].updatedAt || ordered[1].lastActivityAt;
  if (newest === runnerUp) {
    return { outcome: "candidates", candidates: ordered.map(row => toWorkbuddyTask(row, descriptors)) };
  }
  return { outcome: "bound", task: toWorkbuddyTask(ordered[0], descriptors) };
}
