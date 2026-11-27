/**
 * Antigravity writes a plain JSONL transcript per conversation, which is the only readable
 * text form: `conversations/<id>.db` stores protobuf payloads that need the vendor schema.
 * Reading the transcript keeps this adapter from inventing a second conversation format.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type AntigravityTranscriptMessage = { role: "user" | "assistant"; text: string; time: string };

type TranscriptRow = {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  created_at?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

/** Antigravity's per-conversation transcript, newest layout first then the earlier alias. */
export function antigravityTranscriptPath(conversationId: string, homeDir = os.homedir()): string | undefined {
  const id = conversationId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const root = path.join(homeDir, ".gemini", "antigravity", "brain", id, ".system_generated", "logs");
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The user request is wrapped in envelope tags; the readable request is inside them. */
function unwrapUserRequest(value: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(value);
  const inner = (match?.[1] ?? value).trim();
  return inner;
}

/**
 * Keep only the user's request and the model's visible prose. Tool calls, planner frames and
 * injected settings are execution detail, not the conversation a reader is looking for.
 *
 * Antigravity uses both frame shapes across builds: sometimes the prose is a `PLANNER_RESPONSE`
 * and sometimes a `GENERIC` step, so either one carries an answer when it has text.
 */
export function readAntigravityTranscript(conversationId: string, homeDir = os.homedir()): AntigravityTranscriptMessage[] {
  const file = antigravityTranscriptPath(conversationId, homeDir);
  if (!file) return [];
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const messages: AntigravityTranscriptMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: TranscriptRow;
    try { row = JSON.parse(line) as TranscriptRow; } catch { continue; }
    const source = textOf(row.source);
    const content = textOf(row.content).trim();
    if (!content) continue;
    const time = textOf(row.created_at);
    if (source === "USER_EXPLICIT") {
      const text = unwrapUserRequest(content);
      if (text) messages.push({ role: "user", text, time });
      continue;
    }
    const type = textOf(row.type);
    if (source === "MODEL" && (type === "PLANNER_RESPONSE" || type === "GENERIC")) {
      messages.push({ role: "assistant", text: content, time });
    }
  }
  return messages;
}

/**
 * The shared history page format for a native transcript: `entries` carry a stable sequence
 * and a `record.timestamp`, which is the same envelope the Codex and WorkBuddy readers use.
 */
export function readAntigravityHistory(
  conversationId: string,
  options: { limit?: number; homeDir?: string } = {}
): { entries: Array<{ sequence: number; record: { type: string; role: string; timestamp: string; content: Array<{ type: string; text: string }> } }>; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(400, Math.floor(options.limit ?? 200) || 200));
  const all = readAntigravityTranscript(conversationId, options.homeDir);
  // The newest page is what a reader opens; the earlier turns stay reachable through a cursor.
  const start = Math.max(0, all.length - limit);
  const entries = all.slice(start).map((message, index) => ({
    sequence: start + index,
    record: {
      type: "message", role: message.role, timestamp: message.time,
      content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }]
    }
  }));
  return { entries, nextCursor: start > 0 ? String(start) : null };
}
