import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportSpeechTranscript } from "./export-speech-transcript.mjs";

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function record(id, recordedAt, text, segments = []) {
  return {
    schemaVersion: 1,
    id,
    recordedAt,
    ingestedAt: recordedAt,
    time: Date.parse(recordedAt) / 1_000,
    source: "mobile_audio_stream",
    transport: "rabispeech_remote_audio",
    channelType: "rabilink.mobile_audio",
    messageAdapterType: "rabilink",
    sessionId: "phone",
    text,
    segments
  };
}

test("exports a deduplicated time range as one Markdown line per speaker segment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-speech-export-"));
  const inputDir = path.join(root, "messages");
  const outputPath = path.join(root, "exports", "range.md");
  const first = record("speech-1", "2026-07-30T00:00:00.000Z", "整条后备文本", [
    { id: "segment-1", start: 0, end: 1, speakerLabel: "speaker-a", text: "第一句" }
  ]);
  const second = record("speech-2", "2026-07-30T01:00:00.000Z", "第二句 换行", [
    {
      id: "segment-2",
      start: 1.5,
      end: 3,
      speakerLabel: "voice",
      voiceprintId: "cluster-b",
      text: "第二句\n换行"
    }
  ]);
  writeJsonl(path.join(inputDir, "2026-07-30.jsonl"), [second, first]);
  writeJsonl(path.join(inputDir, "2026-07-31.jsonl"), [second]);

  const result = await exportSpeechTranscript({
    inputDir,
    outputPath,
    from: "2026-07-30T00:30:00.000Z",
    to: "2026-07-30T02:00:00.000Z",
    timeZone: "Asia/Hong_Kong"
  });

  assert.equal(result.recordsRead, 3);
  assert.equal(result.uniqueRecords, 2);
  assert.equal(result.exportedLines, 1);
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    "[2026-07-30 09:00:01] cluster-b：第二句 换行\n"
  );
});

test("falls back to record text and refuses to overwrite without force", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-speech-export-"));
  const inputDir = path.join(root, "messages");
  const outputPath = path.join(root, "range.md");
  writeJsonl(path.join(inputDir, "2026-07-30.jsonl"), [
    record("speech-1", "2026-07-30T00:00:00.000Z", "没有分段")
  ]);

  await exportSpeechTranscript({
    inputDir,
    outputPath,
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T01:00:00.000Z",
    timeZone: "UTC"
  });
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    "[2026-07-30 00:00:00] 未知说话人：没有分段\n"
  );

  await assert.rejects(
    exportSpeechTranscript({
      inputDir,
      outputPath,
      from: "2026-07-30T00:00:00.000Z",
      to: "2026-07-30T01:00:00.000Z",
      timeZone: "UTC"
    }),
    /already exists/
  );

  const forced = await exportSpeechTranscript({
    inputDir,
    outputPath,
    from: "2026-07-30T00:00:00.000Z",
    to: "2026-07-30T01:00:00.000Z",
    timeZone: "UTC",
    force: true
  });
  assert.equal(forced.exportedLines, 1);
});
