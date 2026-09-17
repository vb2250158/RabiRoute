import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { antigravityMainLogPath } from "./antigravityBridge.js";

/**
 * Antigravity conversation discovery.
 *
 * The host keeps a per-user SQLite index of conversations at
 *   ~/.gemini/antigravity/conversation_summaries.db
 * and per-conversation transcripts under
 *   ~/.gemini/antigravity/brain/<conversationId>/...
 *
 * The index is the read model the desktop sidebar itself uses, so it is the
 * authoritative source for "which conversations exist". `title` is the single
 * display-name field; there is no separate user-named field as some other hosts
 * have, so name matching uses `title` directly.
 *
 * Attribution matters: the index is shared by the desktop app and every CLI
 * conversation, and a workspace can be attributed to another product (e.g.
 * `antigravity` vs `agy`). Callers that want "sessions of this kind" must pass
 * an explicit expected `appDataDir`, or they will list unrelated conversations.
 */

export type AntigravitySession = {
  id: string;
  title: string;
  preview: string;
  projectId: string;
  workspaceUris: string[];
  appDataDir: string;
  status: string;
  stepCount: number;
  updatedAt: string;
  /** True when the conversation has never received a user turn. */
  empty: boolean;
};

export type AntigravitySessionStoreOptions = {
  /** Explicit index path. Overrides the per-user default. */
  databasePath?: string;
  /** Restrict to conversations attributed to this product directory. */
  appDataDir?: string;
  /** Include conversations with no user turn yet. Defaults to false. */
  includeEmpty?: boolean;
};

export type AntigravitySessionQuery = {
  limit?: number;
  offset?: number;
  query?: string;
  workspace?: string;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const READ_TIMEOUT_MS = 10_000;

/** Antigravity's per-user data root. */
export function antigravityDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANTIGRAVITY_DATA_HOME?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".gemini", "antigravity");
}

/** Path of the conversation index database. */
export function antigravitySummariesDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityDataDir(env), "conversation_summaries.db");
}

/**
 * Read the conversation index.
 *
 * The database is opened read-only through a `file:...?mode=ro` URI and the
 * query is issued by a short-lived helper process, because Node has no built-in
 * SQLite driver and pulling one in for a single read is not worth the
 * dependency. The helper is `node:sqlite`, available in the Node version the
 * project already requires.
 *
 * Returns an empty array when the index does not exist yet — a host that has
 * never been run is a normal state, not an error.
 */
export function readAntigravitySessions(
  options: AntigravitySessionStoreOptions = {}
): AntigravitySession[] {
  const databasePath = options.databasePath ?? antigravitySummariesDatabasePath();
  if (!fs.existsSync(databasePath)) return [];

  const includeEmpty = options.includeEmpty === true;
  const appDataDirFilter = options.appDataDir?.trim() ?? "";
  const script = buildIndexReadScript(databasePath, includeEmpty, appDataDirFilter);

  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { timeout: READ_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (error) {
    throw new Error(`Could not read the Antigravity conversation index: ${describeError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    throw new Error("Antigravity conversation index returned unparseable output.");
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((row): AntigravitySession[] => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const id = typeof record.conversation_id === "string" ? record.conversation_id.trim() : "";
    if (!id) return [];
    const stepCount = typeof record.step_count === "number" ? record.step_count : 0;
    return [{
      id,
      title: text(record.title) || id,
      preview: text(record.preview),
      projectId: text(record.project_id),
      workspaceUris: parseWorkspaceUris(record.workspace_uris),
      appDataDir: text(record.app_data_dir),
      status: text(record.status),
      stepCount,
      updatedAt: text(record.last_modified_time),
      // `last_user_input_step_index` defaults to -1 and only advances once a
      // real user turn lands, so it is the reliable emptiness signal.
      empty: typeof record.last_user_input_step_index !== "number"
        || record.last_user_input_step_index < 0
    }];
  });
}

/**
 * The index reader runs in a child process so this module stays free of a
 * SQLite dependency. `node:sqlite` is used when present; otherwise the query
 * fails loudly rather than silently returning nothing.
 */
function buildIndexReadScript(
  databasePath: string,
  includeEmpty: boolean,
  appDataDir: string
): string {
  const conditions = ["conversation_id IS NOT NULL", "conversation_id <> ''"];
  if (!includeEmpty) conditions.push("last_user_input_step_index >= 0");
  if (appDataDir) conditions.push("app_data_dir = :appDataDir");
  const where = conditions.join(" AND ");
  return `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(`file:${databasePath.replace(/\\/g, "/")}?mode=ro`)}, { readOnly: true });
const rows = db.prepare(${JSON.stringify(
    `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, `
    + `status, project_id, app_data_dir, last_user_input_step_index `
    + `FROM conversation_summaries WHERE ${where} `
    + `ORDER BY last_modified_time DESC`
  )}).all(${appDataDir ? `{ appDataDir: ${JSON.stringify(appDataDir)} }` : ""});
db.close();
process.stdout.write(JSON.stringify(rows));
`.trim();
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * `workspace_uris` holds a JSON array in current builds, but older rows store
 * plain text. Accept both rather than dropping the workspace.
 */
function parseWorkspaceUris(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.flatMap((entry): string[] => {
          if (typeof entry === "string" && entry.trim()) return [entry.trim()];
          if (entry && typeof entry === "object") {
            const uri = text((entry as Record<string, unknown>).uri);
            if (uri) return [uri];
          }
          return [];
        });
      }
    } catch {
      // Fall through: treat as a single raw token.
    }
  }
  return [raw];
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.slice(0, 300);
  }
  return error instanceof Error ? error.message : String(error);
}

/** Windows paths compare case-insensitively; normalize before comparing. */
export function normalizeAntigravityWorkspace(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function sessionMatchesWorkspace(session: AntigravitySession, workspace: string): boolean {
  const target = normalizeAntigravityWorkspace(workspace);
  if (!target) return true;
  return session.workspaceUris.some((uri) => {
    const normalized = normalizeAntigravityWorkspace(stripFileScheme(uri));
    if (!normalized) return false;
    return normalized === target || normalized.startsWith(`${target}/`);
  });
}

function stripFileScheme(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\/\/?/i, "");
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

/** Page through conversations, applying the workspace and text filters. */
export function listAntigravitySessions(
  options: AntigravitySessionStoreOptions & AntigravitySessionQuery = {}
): { sessions: AntigravitySession[]; total: number; hasMore: boolean } {
  const all = readAntigravitySessions(options);
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const filtered = all
    .filter((session) => sessionMatchesWorkspace(session, options.workspace ?? ""))
    .filter((session) => !query
      || session.title.toLocaleLowerCase().includes(query)
      || session.preview.toLocaleLowerCase().includes(query));

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0);
  return {
    sessions: filtered.slice(offset, offset + limit),
    total: filtered.length,
    hasMore: filtered.length > offset + limit
  };
}

/**
 * Antigravity conversation ids are plain UUIDs, which is the *same* shape Codex
 * task ids use. Format alone therefore cannot tell the two owners apart, so any
 * code that needs to know the owner must read the persisted `agentType` instead
 * of guessing from the id. This helper only rules out ids that are definitely
 * not Antigravity (notably the `session-` prefixed DSH form).
 */
const antigravityConversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAntigravityConversationId(value: unknown): boolean {
  return typeof value === "string" && antigravityConversationIdPattern.test(value.trim());
}

/**
 * Focus a conversation in the desktop app.
 *
 * The host exposes no documented "focus conversation" subcommand, so this uses
 * the app's own conversation URL. It is a best-effort convenience: the caller
 * surfaces a failure rather than treating it as a delivery.
 */
export function openAntigravitySession(conversationId: string): void {
  const wanted = conversationId.trim();
  if (!wanted) throw new Error("Antigravity conversation id is required.");
  const target = `antigravity://conversation/${encodeURIComponent(wanted)}`;
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
}

/**
 * Read one conversation by id, in the shape the shared plan/thread read models
 * expect. `status` mirrors the host's own vocabulary so callers can map it onto
 * their own state set.
 */
export function readAntigravitySession(
  conversationId: string,
  options: AntigravitySessionStoreOptions = {}
): {
  id: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  archived: boolean;
  source: string;
  active: boolean;
  status: { type: string };
} {
  const wanted = conversationId.trim();
  if (!wanted) throw new Error("Antigravity conversation id is required.");
  const session = readAntigravitySessions({ ...options, includeEmpty: true })
    .find((candidate) => candidate.id === wanted);
  if (!session) throw new Error(`Antigravity conversation was not found: ${wanted}`);

  const workspace = session.workspaceUris
    .map((uri) => stripFileScheme(uri))
    .find((candidate): candidate is string => Boolean(candidate));
  const active = /active|running|working/i.test(session.status);
  return {
    id: session.id,
    title: session.title || session.id,
    ...(workspace ? { cwd: workspace } : {}),
    updatedAt: session.updatedAt,
    archived: false,
    source: "antigravity",
    active,
    status: { type: active ? "active" : session.empty ? "notLoaded" : "idle" }
  };
}

/** Distinct workspaces present in the conversation index. */
export function listAntigravityWorkspaces(
  options: AntigravitySessionStoreOptions = {}
): string[] {
  const seen = new Map<string, string>();
  for (const session of readAntigravitySessions({ ...options, includeEmpty: true })) {
    for (const uri of session.workspaceUris) {
      const workspace = stripFileScheme(uri);
      if (!workspace) continue;
      const key = normalizeAntigravityWorkspace(workspace);
      if (!seen.has(key)) seen.set(key, workspace);
    }
  }
  return [...seen.values()];
}

/**
 * Host liveness probe.
 *
 * `tasklist` costs roughly 600 ms because it spawns a process, and the manager
 * scan asks for this status on every request. The Antigravity startup log is
 * rewritten by the host on each launch, so its mtime is a ~2 ms signal that the
 * desktop booted; the process table is then only consulted when that signal is
 * stale enough to matter. The combined result is cached briefly so a burst of
 * scans pays the expensive check at most once.
 */
const HOST_PROBE_CACHE_MS = 10_000;
/** A log touched inside this window is treated as proof the host is up. */
const HOST_LOG_FRESH_MS = 6 * 60 * 60 * 1000;
let hostProbeCache: { at: number; running: boolean } | null = null;

function probeHostViaLog(): boolean | undefined {
  try {
    const stat = fs.statSync(antigravityMainLogPath());
    if (Date.now() - stat.mtimeMs < HOST_LOG_FRESH_MS) return true;
    return undefined;
  } catch {
    return undefined;
  }
}

function probeHostViaProcessTable(): boolean {
  try {
    const output = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq language_server.exe", "/FO", "CSV", "/NH"],
      { timeout: 5_000, windowsHide: true, encoding: "utf8" }
    );
    return /language_server\.exe/i.test(output ?? "");
  } catch {
    return false;
  }
}

/**
 * True when the desktop app or its language server is currently running.
 *
 * Pass `fresh` to bypass the cache after an action that is expected to change
 * the host state, such as a delivery attempt.
 */
export function antigravityHostRunning(options: { fresh?: boolean } = {}): boolean {
  const now = Date.now();
  if (!options.fresh && hostProbeCache && now - hostProbeCache.at < HOST_PROBE_CACHE_MS) {
    return hostProbeCache.running;
  }
  const fromLog = probeHostViaLog();
  const running = fromLog ?? probeHostViaProcessTable();
  hostProbeCache = { at: now, running };
  return running;
}

/** Drop the cached host probe so the next check hits the process table. */
export function resetAntigravityHostProbe(): void {
  hostProbeCache = null;
}
