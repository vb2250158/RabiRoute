import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendVoiceTranscriptEventForAdapterToDir } from "./history.js";

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
