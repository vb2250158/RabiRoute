import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAdapterLogToDir, appendVoiceTranscriptEventForAdapterToDir } from "./history.js";
import { runtimeLayout } from "./config.js";

function rows(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test("persona voice transcript files deduplicate one host ASR record across matching Routes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-history-"));
  const record = {
    time: Date.now() / 1_000,
    rawMessage: "同一段语音",
    messageId: "speech-record-one",
    adapterType: "speech"
  } as const;

  appendVoiceTranscriptEventForAdapterToDir("speech", record, dir);
  appendVoiceTranscriptEventForAdapterToDir("speech", record, dir);

  assert.equal(rows(path.join(dir, "speech-voice-transcripts.jsonl")).length, 1);
  assert.equal(rows(path.join(dir, "voice-transcripts.jsonl")).length, 1);
  assert.equal(fs.existsSync(path.join(dir, "voice-transcripts.jsonl.lock")), false);
});

test("voice transcript deduplication remains scoped to the logical message endpoint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-voice-history-endpoint-"));
  const base = { time: Date.now() / 1_000, rawMessage: "语音", messageId: "shared-id" };
  appendVoiceTranscriptEventForAdapterToDir("speech", { ...base, adapterType: "speech" }, dir);
  appendVoiceTranscriptEventForAdapterToDir("rabilink", { ...base, adapterType: "rabilink" }, dir);
  assert.equal(rows(path.join(dir, "voice-transcripts.jsonl")).length, 2);
});

test("adapter log keeps the original stack of a supplied error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-stack-"));
  const failure = (): never => {
    throw new Error("probe adapter failure");
  };
  let caught: unknown;
  try {
    failure();
  } catch (error) {
    caught = error;
  }

  appendAdapterLogToDir("router", { event: "probe_failed", level: "error", error: caught }, dir);

  const [record] = rows(path.join(dir, "router-adapter.log.jsonl"));
  assert.equal(record.message, "probe adapter failure");
  assert.match(String(record.stack), /Error: probe adapter failure/);
  assert.match(String(record.stack), /history\.test/);
});

test("adapter log keeps caller message and writes no stack without an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-plain-"));
  appendAdapterLogToDir("router", { event: "probe_ok", level: "info", message: "custom text" }, dir);

  const [record] = rows(path.join(dir, "router-adapter.log.jsonl"));
  assert.equal(record.message, "custom text");
  assert.equal("stack" in record, false);
});

test("adapter log falls back to a textual error value without fabricating a stack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-text-"));
  appendAdapterLogToDir("router", { event: "probe_failed", level: "error", error: "plain failure" }, dir);

  const [record] = rows(path.join(dir, "router-adapter.log.jsonl"));
  assert.equal(record.message, "plain failure");
  assert.equal("stack" in record, false);
});

test("adapter log reads message from a shaped error object instead of stringifying it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-shaped-"));
  appendAdapterLogToDir("router", {
    event: "probe_failed",
    level: "error",
    error: { message: "shaped failure", code: "E_SHAPED" }
  }, dir);

  const [record] = rows(path.join(dir, "router-adapter.log.jsonl"));
  assert.equal(record.message, "shaped failure");
  assert.equal("stack" in record, false);
});

test("adapter log preserves explicit message and stack while bounding derived stacks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-overrides-"));
  appendAdapterLogToDir("router", { event: "explicit", message: "context", stack: "caller stack", error: new Error("underlying") }, dir);
  appendAdapterLogToDir("router", { event: "bounded", error: { message: "large", stack: "x".repeat(20_000) } }, dir);
  const [explicit, bounded] = rows(path.join(dir, "router-adapter.log.jsonl"));
  assert.equal(explicit.message, "context");
  assert.equal(explicit.stack, "caller stack");
  assert.equal(String(bounded.stack).length, 16_000);
});


test("adapter log redacts the original error, caller context and duplicate error data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-adapter-log-redact-"));
  const root = runtimeLayout.stateRoot;
  const error = new Error(`token=private-token at ${root}/private`);
  error.stack = `Error: Bearer private-bearer at ${root}\\private password=private-password`;
  appendAdapterLogToDir("router", { event: "failure", message: `failure ${error.message}`, data: { error: error.message }, error }, dir);
  const [record] = rows(path.join(dir, "router-adapter.log.jsonl"));
  const serialized = JSON.stringify(record);
  for (const value of ["private-token", "private-bearer", "private-password", root.replace(/\\/g, "/")]) assert.equal(serialized.includes(value), false);
  assert.match(String(record.stack), /<projectRoot>/);
  assert.match(String(record.message), /<redacted>/);
  assert.match(String((record.data as { error: string }).error), /<redacted>/);
});
