import fs from "node:fs";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { messageHistoryStorage, type MessageContextRecord } from "./messageContextStore.js";

/** Derived-index work budget only; original message storage and body reads are unchanged. */
export const MESSAGE_HISTORY_INDEX_RECORD_BYTES = 8 * 1024 * 1024;
export const MESSAGE_HISTORY_TAIL_FORMAT = 1;
type RecordIssue = "malformed" | "oversized" | "unrecognized";
export type MessageHistoryCursor = { offset: number; records: number; prefixHash: string; identity: string; epoch: string; atLineBoundary?: boolean;
  format?: number; issues?: Record<RecordIssue, number>; issueSamples?: Array<{ offset: number; bytes: number; reason: RecordIssue }>; pendingBytes?: number };
export type MessageHistoryTailRow = { position: number; record: MessageContextRecord; checkpoint?: MessageHistoryCursor };
type PrefixSnapshot = { bytes: number; identity: string; hash: string };
type PrefixState = { cursor: MessageHistoryCursor; snapshot: PrefixSnapshot; hash: Hash };
const prefixStates = new Map<string, { verified?: PrefixState; pending?: PrefixState }>();

function rememberPrefixProposal(file: string, state: PrefixState): void {
  const entry = prefixStates.get(file) ?? {};
  entry.pending = state;
  prefixStates.delete(file); prefixStates.set(file, entry);
  while (prefixStates.size > 16) prefixStates.delete(prefixStates.keys().next().value!);
}

function settlePrefixValidation(file: string, snapshot: PrefixSnapshot, valid: boolean): boolean {
  if (!valid) { prefixStates.delete(file); return false; }
  const entry = prefixStates.get(file);
  if (entry?.pending && entry.pending.snapshot.bytes === snapshot.bytes && entry.pending.snapshot.identity === snapshot.identity
    && entry.pending.snapshot.hash === snapshot.hash) {
    entry.verified = entry.pending; entry.pending = undefined;
    prefixStates.delete(file); prefixStates.set(file, entry);
  }
  return true;
}

function normalizedLine(text: string): MessageContextRecord | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return messageHistoryStorage.normalizeStored(raw as Record<string, unknown>);
  } catch { return undefined; }
}

/** Retain one bounded record, never repeatedly concatenate an unfinished line. */
class RecordBuffer {
  bytes = 0;
  private chunks: Buffer[] = [];
  append(part: Buffer): void {
    this.bytes += part.length;
    if (this.bytes <= MESSAGE_HISTORY_INDEX_RECORD_BYTES) this.chunks.push(Buffer.from(part));
    else this.chunks = [];
  }
  text(): string | undefined { return this.bytes > MESSAGE_HISTORY_INDEX_RECORD_BYTES ? undefined : Buffer.concat(this.chunks, this.bytes).toString("utf8").trim(); }
  reset(): void { this.bytes = 0; this.chunks = []; }
}

/** Legacy selection uses the same normalized-row condition as the original reader. */
export function hasNormalizedMessageHistoryRecord(file: string): boolean {
  let descriptor: number;
  try { descriptor = fs.openSync(file, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024); const pending = new RecordBuffer();
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      // Unparseable/oversized bytes cannot prove that modern records supersede legacy data.
      if (!read) { const text = pending.text(); return text !== undefined && Boolean(normalizedLine(text)); }
      const chunk = buffer.subarray(0, read);
      let begin = 0;
      for (let end = chunk.indexOf(10, begin); end !== -1; end = chunk.indexOf(10, begin)) {
        pending.append(chunk.subarray(begin, end));
        const text = pending.text();
        if (text !== undefined && normalizedLine(text)) return true;
        pending.reset();
        begin = end + 1;
      }
      pending.append(chunk.subarray(begin));
    }
  } finally { fs.closeSync(descriptor); }
}

/** Background-only cursor. A larger file is an append only after its old prefix is verified. */
export function readMessageHistoryTail(file: string, previous?: MessageHistoryCursor, expectedStamp?: string, acceptFinalRecord: boolean | "valid" = false, reusePrefixState = false): {
  cursor: MessageHistoryCursor; rows: MessageHistoryTailRow[]; reset: boolean; bytesParsed: number;
  snapshot: { bytes: number; identity: string; hash: string }
} {
  // Opt-in reuse is speculative: callers must verify the full captured prefix
  // with verifyMessageHistoryPrefix before publishing any proposed rows.
  let descriptor: number; let reusedPrefix = false;
  try { descriptor = fs.openSync(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    prefixStates.delete(file);
    if (expectedStamp && expectedStamp !== "missing") throw new Error("MESSAGE_HISTORY_INDEX_LAGGING");
    const hash = createHash("sha256").digest("hex");
    return { cursor: { offset: 0, records: 0, prefixHash: hash, identity: "missing", epoch: randomUUID(), format: MESSAGE_HISTORY_TAIL_FORMAT }, rows: [], reset: true, bytesParsed: 0,
      snapshot: { bytes: 0, identity: "missing", hash } };
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const identity = `${stat.dev}:${stat.ino}`;
    const expected = expectedStamp?.split(":");
    const limit = expected ? Number(expected[2]) : stat.size;
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > stat.size || (expected && `${expected[0]}:${expected[1]}` !== identity)
      || (expectedStamp && stamp !== expectedStamp && stat.size === limit)) throw new Error("MESSAGE_HISTORY_INDEX_LAGGING");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let hash = createHash("sha256");
    let offset = 0;
    let append = Boolean(previous && previous.format === MESSAGE_HISTORY_TAIL_FORMAT && previous.identity === identity && previous.offset <= limit && previous.atLineBoundary !== false);
    if (append) {
      const cached = reusePrefixState ? prefixStates.get(file)?.verified : undefined;
      if (cached && cached.cursor.identity === previous!.identity && cached.cursor.epoch === previous!.epoch
        && cached.cursor.offset === previous!.offset && cached.cursor.records === previous!.records && cached.cursor.prefixHash === previous!.prefixHash) {
        hash = cached.hash.copy(); offset = previous!.offset; reusedPrefix = true;
      }
      while (offset < previous!.offset) {
        const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, previous!.offset - offset), offset);
        if (!read) throw new Error("MESSAGE_HISTORY_INDEX_LAGGING");
        hash.update(buffer.subarray(0, read)); offset += read;
      }
      append = hash.copy().digest("hex") === previous!.prefixHash;
    }
    if (!append) { offset = 0; hash = createHash("sha256"); }
    const epoch = append ? previous!.epoch : randomUUID();
    const start = offset;
    let confirmed = offset;
    let records = append ? previous!.records : 0;
    const pending = new RecordBuffer();
    let lineHash = hash.copy();
    const issues = { malformed: 0, oversized: 0, unrecognized: 0, ...(append ? previous!.issues : {}) };
    const issueSamples = append ? [...(previous!.issueSamples ?? [])] : [];
    const rows: MessageHistoryTailRow[] = [];
    const issue = (reason: RecordIssue) => {
      issues[reason]++;
      if (issueSamples.length < 8) issueSamples.push({ offset: confirmed - pending.bytes, bytes: pending.bytes, reason });
    };
    const consume = (text: string | undefined, atLineBoundary: boolean) => {
      if (text === undefined) { issue("oversized"); return; }
      if (!text) return;
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch { issue("malformed"); return; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issue("unrecognized"); return; }
      const record = messageHistoryStorage.normalizeStored(raw as Record<string, unknown>);
      if (record) {
        const position = records++;
        const checkpoint = records % 5000 === 0 ? { offset: confirmed, records, prefixHash: hash.copy().digest("hex"), identity, epoch, atLineBoundary,
          format: MESSAGE_HISTORY_TAIL_FORMAT, issues: { ...issues }, issueSamples: [...issueSamples] } : undefined;
        rows.push({ position, record, checkpoint });
      } else issue("unrecognized");
    };
    while (offset < limit) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (!read) throw new Error("MESSAGE_HISTORY_INDEX_LAGGING");
      const chunk = buffer.subarray(0, read);
      let begin = 0;
      for (let end = chunk.indexOf(10, begin); end !== -1; end = chunk.indexOf(10, begin)) {
        const part = chunk.subarray(begin, end + 1);
        pending.append(part); lineHash.update(part);
        hash = lineHash.copy(); confirmed = offset + end + 1;
        consume(pending.text(), true);
        pending.reset();
        begin = end + 1;
      }
      const rest = chunk.subarray(begin); pending.append(rest); lineHash.update(rest);
      offset += read;
    }
    let atLineBoundary = true;
    const finalText = pending.text();
    if (acceptFinalRecord && pending.bytes && (acceptFinalRecord === true || (finalText !== undefined && normalizedLine(finalText)))) {
      hash = lineHash.copy(); confirmed = offset; consume(finalText, false);
      pending.reset(); atLineBoundary = false;
    }
    // A reused prefix can start in the middle of a rewritten row. Validate before
    // treating that apparent malformed fragment as an actual source issue.
    if (reusedPrefix && issues.malformed > (previous!.issues?.malformed ?? 0)) {
      const candidate = { bytes: limit, identity, hash: lineHash.copy().digest("hex") };
      if (!verifyMessageHistoryPrefix(file, candidate)) { prefixStates.delete(file); return readMessageHistoryTail(file, previous, expectedStamp, acceptFinalRecord, false); }
    }
    const snapshot = { bytes: limit, identity, hash: lineHash.digest("hex") };
    const prefixState = reusePrefixState ? hash.copy() : undefined;
    const cursor = { offset: confirmed, records, prefixHash: hash.digest("hex"), identity, epoch, atLineBoundary,
      format: MESSAGE_HISTORY_TAIL_FORMAT, issues, issueSamples, pendingBytes: pending.bytes };
    if (prefixState) rememberPrefixProposal(file, { cursor: { ...cursor }, snapshot: { ...snapshot }, hash: prefixState });
    return { cursor, rows, reset: !append, bytesParsed: limit - start, snapshot };
  } catch (error) {
    if (reusedPrefix && error instanceof Error && /^MESSAGE_HISTORY_INDEX_(?:SOURCE_INVALID|LAGGING)/.test(error.message)) {
      prefixStates.delete(file);
      return readMessageHistoryTail(file, previous, expectedStamp, acceptFinalRecord, false);
    }
    throw error;
  } finally { fs.closeSync(descriptor); }
}

/** Confirm the captured byte prefix still exists after indexing, allowing later appends. */
export function verifyMessageHistoryPrefix(file: string, snapshot: PrefixSnapshot): boolean {
  let descriptor: number;
  try { descriptor = fs.openSync(file, "r"); }
  catch (error) { prefixStates.delete(file); if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot.identity === "missing"; throw error; }
  try {
    const stat = fs.fstatSync(descriptor);
    if (`${stat.dev}:${stat.ino}` !== snapshot.identity || stat.size < snapshot.bytes) return settlePrefixValidation(file, snapshot, false);
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(128 * 1024);
    let offset = 0;
    while (offset < snapshot.bytes) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, snapshot.bytes - offset), offset);
      if (!read) return settlePrefixValidation(file, snapshot, false);
      hash.update(buffer.subarray(0, read)); offset += read;
    }
    return settlePrefixValidation(file, snapshot, hash.digest("hex") === snapshot.hash);
  } catch (error) {
    prefixStates.delete(file); throw error;
  } finally { fs.closeSync(descriptor); }
}
