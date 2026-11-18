import { DatabaseSync } from "node:sqlite";
import { readWorkbuddyHistory } from "./workbuddyHistory.js";
import { normalizeWorkbuddyWorkspace, workbuddyDatabasePath } from "./workbuddySessionStore.js";

type Candidate = { id: string; cwd: string; title: string };

/** Capture the existing IDs before the caller can submit a new native task. */
export function snapshotWorkbuddyDesktopIds(): string[] {
  const database = new DatabaseSync(workbuddyDatabasePath(), { readOnly: true });
  try {
    return database.prepare("SELECT id FROM sessions").all().map(row => String(row.id));
  } finally {
    database.close();
  }
}

/** A matching, newly observed ordinary desktop task and its first user message are the receipt. */
export async function readWorkbuddyDesktopCreationReceipt(input: {
  workspace: string;
  existingIds: readonly string[];
  marker: string;
  signal?: AbortSignal;
}): Promise<
  | { state: "not_observed" }
  | { state: "created"; thread: Candidate; sequence: number }
  | { state: "conflict"; threadIds: string[] }
> {
  const workspace = normalizeWorkbuddyWorkspace(input.workspace);
  if (!workspace || !input.marker.trim()) throw new Error("必须提供原 WorkBuddy 创建标记及工作区。");
  input.signal?.throwIfAborted();
  const existing = new Set(input.existingIds);
  const database = new DatabaseSync(workbuddyDatabasePath(), { readOnly: true });
  let candidates: Candidate[];
  try {
    database.function("workbuddy_create_workspace", { deterministic: true }, cwd =>
      normalizeWorkbuddyWorkspace(typeof cwd === "string" ? cwd : null) === workspace ? 1 : 0);
    candidates = database.prepare(`SELECT id, cwd, COALESCE(NULLIF(custom_title, ''), title, id) AS title
      FROM sessions WHERE source_mode = 'craft' AND transport = 'local'
      AND COALESCE(is_playground, 0) = 0 AND COALESCE(is_background_automation, 0) = 0
      AND COALESCE(deleted_at, 0) = 0 AND workbuddy_create_workspace(cwd) = 1`).all()
      .map(row => ({ id: String(row.id), cwd: String(row.cwd), title: String(row.title) }))
      .filter(task => !existing.has(task.id));
  } finally {
    database.close();
  }

  const matches: Array<{ thread: Candidate; sequence: number }> = [];
  for (const candidate of candidates) {
    input.signal?.throwIfAborted();
    const history = await readWorkbuddyHistory(candidate.id, { limit: 120, signal: input.signal })
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    const first = history?.entries.find(entry => {
      const message = entry.record as { type?: string; role?: string } | null;
      return message?.type === "message" && message.role === "user";
    });
    if (!first) continue;
    const { content } = first.record as { content?: string | Array<{ type?: string; text?: string }> };
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(part => part?.type === "input_text" || part?.type === "text").map(part => part.text ?? "").join("\n")
      : "";
    if (text.includes(input.marker)) matches.push({ thread: candidate, sequence: first.sequence });
  }
  if (matches.length === 0) return { state: "not_observed" };
  if (matches.length > 1) return { state: "conflict", threadIds: matches.map(match => match.thread.id) };
  return { state: "created", ...matches[0]! };
}
