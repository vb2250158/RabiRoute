import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMessageHistoryTail, verifyMessageHistoryPrefix, hasNormalizedMessageHistoryRecord, MESSAGE_HISTORY_INDEX_RECORD_BYTES } from "./messageHistoryTail.js";
import { messageHistoryFileVersion } from "./messageHistorySourceVersion.js";

test("archive EOF records and durable mid-file cursors preserve every record", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "archive.jsonl");
  fs.writeFileSync(file, Array.from({ length: 6001 }, (_, id) => JSON.stringify({ id: String(id), sequence: id + 1,
    time: id + 1, text: "checkpoint 中文", adapter: "synthetic" })).join("\n"));
  const first = readMessageHistoryTail(file, undefined, undefined, true);
  assert.equal(first.rows.length, 6001);
  assert.equal(first.cursor.atLineBoundary, false);
  const checkpoint = first.rows[4999]!.checkpoint!;
  assert.equal(checkpoint.records, 5000);
  const resumed = readMessageHistoryTail(file, checkpoint, undefined, true);
  assert.equal(resumed.reset, false);
  assert.equal(resumed.rows.length, 1001);
  assert.equal(resumed.rows[0]!.position, 5000);
  fs.appendFileSync(file, "\n");
  assert.equal(readMessageHistoryTail(file, first.cursor, undefined, true).reset, true);
});

test("tail cursor consumes complete UTF-8 records once and resumes a partial line", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number) => JSON.stringify({ id: String(id), sequence: id, time: id, text: "中文😀", adapter: "synthetic" }) + "\n";
  const second = Buffer.from(line(2));
  fs.writeFileSync(file, Buffer.concat([Buffer.from(line(1)), second.subarray(0, second.length - 4)]));
  const first = readMessageHistoryTail(file);
  assert.equal(first.rows.length, 1); assert.equal(first.cursor.records, 1);
  assert.equal(first.cursor.offset, Buffer.byteLength(line(1)));
  fs.appendFileSync(file, second.subarray(second.length - 4));
  const next = readMessageHistoryTail(file, first.cursor);
  assert.equal(next.reset, false); assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].position, 1); assert.equal(next.rows[0].record.text, "中文😀");
  assert.equal(next.cursor.epoch, first.cursor.epoch);
  assert.equal(next.bytesParsed, second.length);
  assert.equal(readMessageHistoryTail(file, next.cursor).rows.length, 0);
});

test("rewrite with growth, truncation and replacement create new epochs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-rewrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const row = (text: string) => JSON.stringify({ time: 1, text, adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, row("before"));
  const original = readMessageHistoryTail(file);
  fs.writeFileSync(file, row("rewritten with a longer body"));
  const changed = readMessageHistoryTail(file, original.cursor);
  assert.equal(changed.reset, true); assert.notEqual(changed.cursor.epoch, original.cursor.epoch);
  assert.equal(changed.rows[0].record.text, "rewritten with a longer body");
  fs.writeFileSync(file, row("short"));
  const truncated = readMessageHistoryTail(file, changed.cursor);
  assert.equal(truncated.reset, true);
  fs.renameSync(file, path.join(root, "previous.jsonl")); fs.writeFileSync(file, row("new inode"));
  assert.equal(readMessageHistoryTail(file, truncated.cursor).reset, true);
});

test("complete bad lines are diagnosed individually while neighboring records and partial EOF remain readable", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const row = (id: number) => JSON.stringify({ id: String(id), time: id, text: "valid neighbor", adapter: "synthetic" });
  const raw = row(1) + "\n{broken\n[]\n{}\n" + row(2) + "\n{unfinished";
  fs.writeFileSync(file, raw);
  const first = readMessageHistoryTail(file, undefined, undefined, "valid");
  assert.deepEqual(first.rows.map(row => row.record.id), ["1", "2"]);
  assert.deepEqual(first.cursor.issues, { malformed: 1, unrecognized: 2, oversized: 0 });
  assert.equal(first.cursor.pendingBytes, Buffer.byteLength("{unfinished"));
  assert.equal(first.cursor.issueSamples?.length, 3);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  fs.appendFileSync(file, "\n" + row(3) + "\n");
  const next = readMessageHistoryTail(file, first.cursor, undefined, "valid");
  assert.equal(next.cursor.issues?.malformed, 2);
  assert.deepEqual(next.rows.map(row => row.record.id), ["3"]);
  assert.equal(next.cursor.pendingBytes, 0);
});

test("oversized lines use bounded buffers and the next normal row still indexes without changing source bytes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-record-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const longBody = "中😀".repeat(60000);
  const row = (id: number, text: string) => JSON.stringify({ id: String(id), time: id, text, adapter: "synthetic" }) + "\n";
  const raw = row(1, "x".repeat(MESSAGE_HISTORY_INDEX_RECORD_BYTES + 256)) + row(2, longBody) + row(3, "after");
  fs.writeFileSync(file, raw);
  const concat = Buffer.concat; let largest = 0;
  t.mock.method(Buffer, "concat", (chunks: readonly Uint8Array[], length?: number) => {
    largest = Math.max(largest, length ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    return concat(chunks, length);
  });
  assert.equal(hasNormalizedMessageHistoryRecord(file), true);
  const first = readMessageHistoryTail(file);
  assert.deepEqual(first.rows.map(row => row.record.id), ["2", "3"]);
  assert.equal(first.rows[0].record.text, longBody);
  assert.equal(first.cursor.issues?.oversized, 1);
  assert.ok(largest <= MESSAGE_HISTORY_INDEX_RECORD_BYTES);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  assert.equal(fs.readFileSync(file, "utf8"), raw);
  const next = readMessageHistoryTail(file, first.cursor);
  assert.equal(next.rows.length, 0); assert.equal(next.cursor.issues?.oversized, 1);
  // Old cursors carry no trustworthy issue counts; re-read once, then resume normally.
  const { format: _format, issues: _issues, ...legacy } = first.cursor;
  const upgraded = readMessageHistoryTail(file, legacy);
  assert.equal(upgraded.reset, true); assert.equal(upgraded.cursor.issues?.oversized, 1);
  assert.deepEqual(upgraded.rows.map(row => row.record.id), ["2", "3"]);
});

test("a captured byte boundary excludes later appends and prefix verification rejects edits", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const row = (text: string) => JSON.stringify({ time: 1, text, adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, row("first")); const stamp = messageHistoryFileVersion(file);
  fs.appendFileSync(file, row("later"));
  const captured = readMessageHistoryTail(file, undefined, stamp);
  assert.equal(captured.rows.length, 1); assert.equal(captured.rows[0].record.text, "first");
  assert.equal(verifyMessageHistoryPrefix(file, captured.snapshot), true);
  fs.writeFileSync(file, row("wrong") + row("later"));
  assert.equal(verifyMessageHistoryPrefix(file, captured.snapshot), false);
});

test("verified prefix state avoids a second old-prefix read while publication still verifies all bytes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-prefix-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number, text: string) => JSON.stringify({ id: String(id), sequence: id, time: id, text, adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, line(1, "old prefix 中文😀 ".repeat(8000)));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  const addition = line(2, "new record"); fs.appendFileSync(file, addition);
  const original = fs.readSync; let readBytes = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args); readBytes += count; return count;
  });
  const next = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.equal(next.reset, false); assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].record.text, "new record");
  assert.ok(readBytes <= Buffer.byteLength(addition), "tail read must reuse its previously verified SHA state");
  readBytes = 0;
  assert.equal(verifyMessageHistoryPrefix(file, next.snapshot), true);
  assert.ok(readBytes >= next.snapshot.bytes, "publication must still verify the complete captured prefix");
});

test("an unverified prefix proposal is never reused", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-unverified-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number) => JSON.stringify({ id: String(id), sequence: id, time: id, text: "record ".repeat(1000), adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, line(1));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  fs.appendFileSync(file, line(2));
  const original = fs.readSync; let readBytes = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args); readBytes += count; return count;
  });
  const next = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.ok(readBytes >= next.snapshot.bytes); assert.equal(next.reset, false);
  assert.equal(next.rows.length, 1); assert.equal(verifyMessageHistoryPrefix(file, next.snapshot), true);
});

test("cached prefix verification rejects an unnoticed rewrite plus append and recovers a new epoch", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-cached-rewrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number, text: string) => JSON.stringify({ id: String(id), sequence: id, time: id, text, adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, line(1, "before"));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  fs.writeFileSync(file, line(1, "after!") + line(2, "appended"));
  const proposal = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.equal(verifyMessageHistoryPrefix(file, proposal.snapshot), false);
  const recovered = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.equal(recovered.reset, true); assert.notEqual(recovered.cursor.epoch, first.cursor.epoch);
  assert.deepEqual(recovered.rows.map(row => row.record.text), ["after!", "appended"]);
  assert.equal(verifyMessageHistoryPrefix(file, recovered.snapshot), true);
});

test("a length-changing rewrite falls back from speculative tail parsing", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-growing-rewrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number, text: string) => JSON.stringify({ id: String(id), sequence: id, time: id, text, adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, line(1, "before"));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  const changed = "rewritten 中文😀 ".repeat(100);
  fs.writeFileSync(file, line(1, changed) + line(2, "appended"));
  const recovered = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.equal(recovered.reset, true); assert.notEqual(recovered.cursor.epoch, first.cursor.epoch);
  assert.deepEqual(recovered.rows.map(row => row.record.text), [changed.trim(), "appended"]);
  assert.equal(verifyMessageHistoryPrefix(file, recovered.snapshot), true);
});

test("evicted prefix state resumes from the durable hash without losing or duplicating rows", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-evicted-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const line = (id: number) => JSON.stringify({ id: String(id), sequence: id, time: id, text: "record ".repeat(1000), adapter: "synthetic" }) + "\n";
  const file = path.join(root, "current.jsonl"); fs.writeFileSync(file, line(1));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  for (let index = 0; index < 32; index++) {
    const other = path.join(root, `other-${index}.jsonl`); fs.writeFileSync(other, line(index + 10));
    const value = readMessageHistoryTail(other, undefined, undefined, false, true);
    assert.equal(verifyMessageHistoryPrefix(other, value.snapshot), true);
  }
  fs.appendFileSync(file, line(2));
  const original = fs.readSync; let readBytes = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args); readBytes += count; return count;
  });
  const next = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.ok(readBytes >= next.snapshot.bytes);
  assert.equal(next.reset, false); assert.equal(next.cursor.epoch, first.cursor.epoch);
  assert.equal(next.rows.length, 1); assert.equal(next.rows[0].position, 1);
  assert.equal(verifyMessageHistoryPrefix(file, next.snapshot), true);
});

test("verified prefix state keeps an incomplete UTF-8 tail pending until it is complete", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-cached-partial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const line = (id: number) => Buffer.from(JSON.stringify({ id: String(id), sequence: id, time: id, text: "中文😀", adapter: "synthetic" }) + "\n");
  const second = line(2); const firstLine = line(1);
  fs.writeFileSync(file, Buffer.concat([firstLine, second.subarray(0, second.length - 4)]));
  const first = readMessageHistoryTail(file, undefined, undefined, false, true);
  assert.equal(first.rows.length, 1); assert.equal(first.cursor.offset, firstLine.length);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  fs.appendFileSync(file, second.subarray(second.length - 4));
  const next = readMessageHistoryTail(file, first.cursor, undefined, false, true);
  assert.equal(next.reset, false); assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].position, 1); assert.equal(next.rows[0].record.text, "中文😀");
  assert.equal(verifyMessageHistoryPrefix(file, next.snapshot), true);
});

test("current EOF mode accepts complete records and keeps incomplete JSON pending", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-valid-eof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const row = (id: number) => JSON.stringify({ id: String(id), sequence: id, time: id, text: "中文😀", adapter: "synthetic" });
  fs.writeFileSync(file, row(1));
  const first = readMessageHistoryTail(file, undefined, undefined, "valid", true);
  assert.equal(first.rows.length, 1); assert.equal(first.cursor.atLineBoundary, false);
  assert.equal(verifyMessageHistoryPrefix(file, first.snapshot), true);
  const nextLine = Buffer.from(row(2) + "\n");
  fs.appendFileSync(file, Buffer.concat([Buffer.from("\n"), nextLine.subarray(0, nextLine.length - 4)]));
  const partial = readMessageHistoryTail(file, first.cursor, undefined, "valid", true);
  assert.equal(partial.rows.length, 1); assert.equal(partial.cursor.atLineBoundary, true);
  assert.equal(verifyMessageHistoryPrefix(file, partial.snapshot), true);
  fs.appendFileSync(file, nextLine.subarray(nextLine.length - 4));
  const completed = readMessageHistoryTail(file, partial.cursor, undefined, "valid", true);
  assert.equal(completed.rows.length, 1); assert.equal(completed.rows[0].position, 1);
  assert.equal(verifyMessageHistoryPrefix(file, completed.snapshot), true);
});

test("legacy selection stops at the first normalized record instead of loading the whole current file", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-tail-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "current.jsonl");
  const row = JSON.stringify({ sequence: 1, time: 1, text: "first valid record", adapter: "synthetic" }) + "\n";
  fs.writeFileSync(file, row + "ignored trailing bytes\n".repeat(32_000));
  const original = fs.readSync; let readBytes = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args); readBytes += count; return count;
  });
  assert.equal(hasNormalizedMessageHistoryRecord(file), true);
  assert.ok(readBytes < fs.statSync(file).size);
  fs.writeFileSync(file, "\n{invalid\n{}\n  ");
  assert.equal(hasNormalizedMessageHistoryRecord(file), false);
});
