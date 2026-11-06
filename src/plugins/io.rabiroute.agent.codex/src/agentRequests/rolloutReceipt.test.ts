import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { findRolloutDeliveryReceipt, readRolloutUserMessages } from "./rolloutReceipt.js";

const zstdCompressSync = (zlib as typeof zlib & {
  zstdCompressSync?: (input: string | Buffer) => Buffer;
}).zstdCompressSync;

const deliveryId = "12345678-1234-4567-8123-123456789abc";
const prompt = `[消息源]\n投递 ID：${deliveryId}\n\n[消息内容]\nWork`;
function row(role: string, text: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } }) + "\n";
}

test("receipt lookup finds an accepted user message beyond the old 4 MiB tail", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("user", prompt) + row("assistant", "x".repeat(5 * 1024 * 1024)));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), true);
  assert.equal(await findRolloutDeliveryReceipt(file, "missing"), false);
});

test("receipt lookup reads the exact compressed sibling for the requested task", async t => {
  assert.ok(zstdCompressSync, "This regression requires the Node Zstandard runtime used by RabiRoute.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-compressed-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const content = JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n" + row("user", prompt);
  fs.writeFileSync(file + ".zst", zstdCompressSync(Buffer.from(content)));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId, "exact-task"), true);
});

test("receipt lookup verifies a restored JSONL sibling for a recorded compressed path", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-restored-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordedPath = path.join(root, "rollout.jsonl.zst");
  const restoredPath = recordedPath.slice(0, -4);
  fs.writeFileSync(restoredPath, JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n" + row("user", prompt));
  assert.equal(await findRolloutDeliveryReceipt(recordedPath, deliveryId, "exact-task"), true);
  await assert.rejects(findRolloutDeliveryReceipt(recordedPath, deliveryId, "different-task"),
    (error: NodeJS.ErrnoException) => error.code === "CODEX_ROLLOUT_IDENTITY_MISMATCH");
});

test("receipt lookup rejects an unterminated hot JSONL tail as incomplete evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-incomplete-hot-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", "complete") + '{"type":"response_item","payload":');
  await assert.rejects(findRolloutDeliveryReceipt(file, deliveryId),
    (error: NodeJS.ErrnoException) => error.code === "CODEX_ROLLOUT_INCOMPLETE_RECORD");
});

test("receipt lookup rejects an unterminated compressed tail as incomplete evidence", async t => {
  assert.ok(zstdCompressSync, "This regression requires the Node Zstandard runtime used by RabiRoute.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-incomplete-compressed-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl.zst");
  const content = JSON.stringify({ type: "session_meta", payload: { id: "exact-task" } }) + "\n"
    + '{"type":"response_item","payload":';
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(content)));
  await assert.rejects(findRolloutDeliveryReceipt(file, deliveryId, "exact-task"),
    (error: NodeJS.ErrnoException) => error.code === "CODEX_ROLLOUT_INCOMPLETE_RECORD");
});

test("receipt lookup rejects assistant quotations and accepts exact historical plan feedback", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-feedback-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", prompt));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), false);
  fs.appendFileSync(file, row("user", "[消息源]\n消息源类型：计划\n\n[消息内容]\n[计划审批：已直接投递到绑定业务会话]\n计划：Example\n计划 ID：plan-one\n反馈 ID：feedback-one\n意见：继续"));
  assert.equal(await findRolloutDeliveryReceipt(file, "feedback-one"), true);
  assert.equal(await findRolloutDeliveryReceipt(file, "feedback-on"), false);
  await assert.rejects(findRolloutDeliveryReceipt(path.join(root, "absent.jsonl"), deliveryId), /ENOENT/);
});

test("point lookup decodes a JSON Unicode-escaped delivery ID", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-escaped-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const actual = "agent-" + "a".repeat(64);
  const content = `[消息源]\n投递 ID：${actual}\n\n[消息内容]\nWork`;
  fs.writeFileSync(file, row("user", content).replace(actual, "\\u0061gent-" + "a".repeat(64)));
  assert.equal(await findRolloutDeliveryReceipt(file, actual), true);
});

test("point lookup rejects matching literals outside an exact accepted user envelope", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-filtered-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", prompt) + row("tool", prompt)
    + row("user", "A quotation: " + prompt) + '{"invalid":' + deliveryId + '}\n');
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), false);
});

test("point lookup retains feedback IDs that themselves require JSON escaping", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-feedback-escaped-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  const feedbackId = 'feedback/"one"';
  const content = `[消息源]\n消息源类型：计划\n\n[消息内容]\n[计划审批：已直接投递到绑定业务会话]\n计划：Example\n计划 ID：plan-one\n反馈 ID：${feedbackId}\n意见：继续`;
  fs.writeFileSync(file, row("user", content).replaceAll("/", "\\/"));
  assert.equal(await findRolloutDeliveryReceipt(file, feedbackId), true);
});

test("point lookup keeps scanning after unrelated records across stream chunks", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-chunk-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", "x".repeat(130000)) + row("user", prompt));
  assert.equal(await findRolloutDeliveryReceipt(file, deliveryId), true);
  const all = [];
  for await (const value of readRolloutUserMessages(file)) all.push(value);
  assert.deepEqual(all, [prompt]);
});

test("point lookup does not turn abort or identity failure into absent receipt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-unknown-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  fs.writeFileSync(file, row("assistant", "unrelated"));
  await assert.rejects(findRolloutDeliveryReceipt(file, deliveryId, "", AbortSignal.abort()), /abort/i);
  await assert.rejects(findRolloutDeliveryReceipt(file + ".zst", deliveryId, "another-task"),
    (error: NodeJS.ErrnoException) => error.code === "CODEX_ROLLOUT_IDENTITY_MISMATCH");
});
