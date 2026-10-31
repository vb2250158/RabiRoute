import { createHash } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import path from "node:path";
import { withPersonaHistoryIndex } from "./personaChatHistoryIndex.js";
import { recordDataMutationAudit } from "./observability/dataMutationAudit.js";
import type { PersonaChatReply, PersonaChatHistoryPage } from "./shared/personaChatHistory.js";

const HISTORY_PATH = "chat-history/final-replies.jsonl";
const writes = new Map<string, Promise<unknown>>();
function parseReply(line: string): PersonaChatReply {
  const value = JSON.parse(line) as PersonaChatReply;
  const identity = (value?.kind === "agent_delivery" || value?.kind === "user_delivery") ? [value.deliveryId, value.targetSessionId] : [value?.turnId];
  if (!value || ![value.id, value.receivedAt, value.sessionId, value.text, ...identity].every(item => typeof item === "string" && item.length > 0)) {
    throw new Error("Invalid persona chat history record.");
  }
  return value;
}

export async function appendPersonaChatReply(
  roleDir: string,
  input: Pick<PersonaChatReply, "sessionId" | "turnId" | "text" | "kind" | "deliveryId" | "deliveryStatus" | "targetSessionId" | "sessionTitle" | "targetSessionTitle" | "sourceTaskOwner" | "targetTaskOwner" | "sourceLabel" | "planId" | "planTitle" | "feedbackId">
): Promise<PersonaChatReply | null> {
  if (!input.sessionId.trim() || !input.text.trim()) return null;
  if ((input.kind === "agent_delivery" || input.kind === "user_delivery") ? !input.deliveryId?.trim() || !input.targetSessionId?.trim() : !input.turnId?.trim()) return null;
  const file = path.resolve(roleDir, HISTORY_PATH);
  const record: PersonaChatReply = {
    ...input,
    id: createHash("sha256").update(JSON.stringify(input.kind === "user_delivery" && input.feedbackId
      ? ["user_delivery", input.planId, input.feedbackId, input.targetSessionId]
      : (input.kind === "agent_delivery" || input.kind === "user_delivery")
      ? [input.kind, input.deliveryId]
      : [input.sessionId, input.turnId, input.text])).digest("hex"),
    receivedAt: new Date().toISOString()
  };
  // One append transaction per persona. Replayed hooks do not create a second row.
  const previous = writes.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => withPersonaHistoryIndex(file, parseReply, async index => {
    const existing = index.find(record.id);
    if (existing && !existing.valid) throw new Error('The recorded reply with this identity is damaged; repair that record before replaying it.');
    if (existing) return null;
    index.assertIdentityComplete();
    const start = index.size;
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await index.appended([record], start);
    } finally {
      await handle.close();
    }
    recordDataMutationAudit({
      group: "persona.chat-history", event: "persona_chat_reply_recorded", owner: "personaChatHistory",
      action: "append", target: { type: "persona-chat-reply", id: record.id },
      dataSource: { kind: "ledger", id: file }, outcome: "committed"
    });
    return record;
  }));
  writes.set(file, write);
  try { return await write; }
  finally { if (writes.get(file) === write) writes.delete(file); }
}

/** Appends device exchanges with stable identity; replay must preserve the original text. */
export async function appendPersonaAiuiExchange(roleDir: string, input: { sessionId: string; turnId: string; userText: string; assistantText?: string | null }, beforeAppend?: () => void) {
  const file = path.resolve(roleDir, HISTORY_PATH);
  const rows: PersonaChatReply[] = [
    { kind: 'aiui_user', text: input.userText, sessionId: 'aiui:' + input.sessionId, turnId: input.turnId + ':user', id: '', receivedAt: new Date().toISOString(), sourceLabel: '眼镜 AIUI' },
    ...(input.assistantText ? [{ kind: 'aiui_assistant' as const, text: input.assistantText, sessionId: 'aiui:' + input.sessionId, turnId: input.turnId + ':assistant', id: '', receivedAt: new Date().toISOString(), sourceLabel: '眼镜 AIUI' }] : [])
  ];
  for (const row of rows) row.id = createHash('sha256').update(JSON.stringify(['aiui', row.sessionId, row.turnId])).digest('hex');
  const previous = writes.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => withPersonaHistoryIndex(file, parseReply, async index => {
    beforeAppend?.();
    for (const row of rows) {
      const existing = index.find(row.id);
      if (existing && (await index.read(existing)).text !== row.text) throw new Error('AIUI_TURN_CONFLICT');
    }
    const pending = rows.filter(row => !index.find(row.id));
    if (pending.length) index.assertIdentityComplete();
    const start = index.size;
    if (pending.length) {
      beforeAppend?.();
      await mkdir(path.dirname(file), { recursive: true });
      beforeAppend?.();
      const handle = await open(file, 'a');
      try {
        beforeAppend?.();
        await handle.writeFile(pending.map(row => JSON.stringify(row) + '\n').join(''), 'utf8'); await handle.sync();
        await index.appended(pending, start);
      } finally { await handle.close(); }
      recordDataMutationAudit({ group: 'persona.chat-history', event: 'persona_aiui_exchange_recorded', owner: 'personaChatHistory', action: 'append', target: { type: 'persona-chat-reply', id: rows[0]!.id }, dataSource: { kind: 'ledger', id: file }, outcome: 'committed' });
    }
    return { state: 'committed', turnId: input.turnId, recordIds: rows.map(row => row.id), deduplicated: pending.length === 0 };
  }));
  writes.set(file, write);
  try { return await write; } finally { if (writes.get(file) === write) writes.delete(file); }
}

/** Reads backwards by byte offset, so paging never reloads the complete history. */
export async function readPersonaChatHistory(roleDir: string, cursor?: number, limit = 50, options: { summary?: boolean; direction?: "older" | "newer"; id?: string } = {}): Promise<PersonaChatHistoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100.");
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid chat history cursor.");
  if (options.direction === 'newer') return readForwardHistory(roleDir, cursor ?? 0, limit, options);
  const file = path.resolve(roleDir, HISTORY_PATH);
  // Await the writer for a coherent boundary; its failure does not invalidate readable rows.
  await writes.get(file)?.catch(() => undefined);
  const handle = await open(file, "r").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return { entries: [], nextCursor: null };
  try {
    const size = (await handle.stat()).size;
    let position = cursor ?? size;
    let invalidRecords = 0;
    if (position > size) throw new Error("Chat history changed; refresh the list.");
    if (position > 0) {
      const newline = Buffer.alloc(1);
      await handle.read(newline, 0, 1, position - 1);
      if (newline[0] !== 10) {
        if (cursor !== undefined) throw new Error("Incomplete chat history record or invalid cursor.");
        // A partially written last row does not hide earlier complete replies.
        invalidRecords++;
        while (position > 0) {
          const start = Math.max(0, position - 65536), tail = Buffer.alloc(position - start);
          await handle.read(tail, 0, tail.length, start);
          const boundary = tail.lastIndexOf(10);
          position = boundary >= 0 ? start + boundary + 1 : start;
          if (boundary >= 0) break;
        }
      }
    }
    let pending = Buffer.alloc(0);
    let discardOversized = false;
    const entries: PersonaChatReply[] = [];
    let responseBytes = 0;
    let scannedBytes = 0;
    const readableSize = cursor === undefined ? position : size;
    let newestEnd = position;
    while (position > 0) {
      const start = Math.max(0, position - 64 * 1024);
      const buffer = Buffer.alloc(position - start);
      await handle.read(buffer, 0, buffer.length, start);
      scannedBytes += buffer.length;
      const combined = Buffer.concat([buffer, pending]);
      let end = combined.length;
      if (discardOversized) {
        const newline = combined.lastIndexOf(10);
        if (newline < 0) { position = start; pending = Buffer.alloc(0); continue; }
        end = newline; discardOversized = false;
        if (scannedBytes >= 1024 * 1024) return { entries, nextCursor: start + newline + 1 || null,
          ...(options.summary ? { newerCursor: newestEnd < readableSize ? newestEnd : null } : {}), invalidRecords };
      } else if (combined[end - 1] === 10) end -= 1;
      while (end > 0) {
        const newline = combined.lastIndexOf(10, end - 1);
        if (newline < 0 && start > 0) break;
        const lineStart = newline + 1;
        const line = combined.subarray(lineStart, end);
        if (line.length) {
          try {
            if (line.length > 1024 * 1024) throw new Error("Oversized record");
            const record = parseReply(line.toString("utf8"));
            entries.push(options.summary ? summarizeReply(record, start + lineStart, start + end + 1) : record);
          } catch { invalidRecords++; }
          responseBytes += line.length;
        }
        const nextCursor = start + lineStart;
        if (entries.length >= limit || responseBytes >= 1024 * 1024 || scannedBytes >= 1024 * 1024) {
          return { entries, nextCursor: nextCursor > 0 ? nextCursor : null, ...(options.summary ? { newerCursor: newestEnd < readableSize ? newestEnd : null, invalidRecords } : { invalidRecords }) };
        }
        end = newline;
      }
      pending = combined.subarray(0, Math.max(0, end));
      if (pending.length > 1024 * 1024) { invalidRecords++; pending = Buffer.alloc(0); discardOversized = true; }
      position = start;
    }
    return { entries, nextCursor: null, ...(options.summary ? { newerCursor: newestEnd < readableSize ? newestEnd : null, invalidRecords } : { invalidRecords }) };
  } finally {
    await handle.close();
  }
}

function summarizeReply(record: PersonaChatReply, start: number, end: number): PersonaChatReply {
  return { ...record, text: record.text.slice(0, 2000), textTruncated: record.text.length > 2000, historyCursor: start, historyEndCursor: end };
}

async function readForwardHistory(roleDir: string, cursor: number, limit: number,
  options: { summary?: boolean; id?: string }): Promise<PersonaChatHistoryPage> {
  const file = path.resolve(roleDir, HISTORY_PATH);
  // Await the writer for a coherent boundary; its failure does not invalidate readable rows.
  await writes.get(file)?.catch(() => undefined);
  const handle = await open(file, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!handle) return { entries: [], nextCursor: null, newerCursor: null };
  try {
    const size = (await handle.stat()).size;
    if (cursor > size) throw new Error('Chat history changed; refresh the list.');
    if (cursor) {
      const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, cursor - 1);
      if (byte[0] !== 10) throw new Error('Invalid chat history cursor.');
    }
    let position = cursor, start = cursor, pending = Buffer.alloc(0), invalidRecords = 0, bytes = 0;
    const entries: PersonaChatReply[] = [];
    let discardOversized = false;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(65536, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new Error('Chat history changed; refresh the list.');
      position += bytesRead; pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const end = start + newline + 1;
        const line = pending.subarray(0, newline);
        if (line.length && !discardOversized) {
          try {
            if (line.length > 1024 * 1024) throw new Error('Persona chat history record is too large.');
            const record = parseReply(line.toString('utf8'));
            if (options.id && record.id !== options.id) throw new Error('Chat history identity changed; refresh this reply.');
            entries.push(options.summary ? summarizeReply(record, start, end) : record);
          } catch (error) { if (options.id) throw error; invalidRecords++; }
          bytes += line.length;
        }
        pending = pending.subarray(newline + 1); start = end; discardOversized = false;
        if (entries.length >= limit || bytes >= 1024 * 1024 || position - cursor >= 1024 * 1024) return { entries: entries.reverse(), nextCursor: cursor > 0 ? cursor : null, newerCursor: end < size ? end : null, invalidRecords };
      }
      if (pending.length > 1024 * 1024) {
        if (options.id) throw new Error('Persona chat history record is too large.');
        if (!discardOversized) invalidRecords++;
        discardOversized = true; start += pending.length; pending = Buffer.alloc(0);
      }
    }
    if (pending.length && !discardOversized) invalidRecords++;
    return { entries: entries.reverse(), nextCursor: cursor > 0 ? cursor : null, newerCursor: null, invalidRecords };
  } finally { await handle.close(); }
}
