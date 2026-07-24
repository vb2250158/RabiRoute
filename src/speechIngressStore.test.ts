import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SpeechIngressStore, speechIngressDisplayText, speechIngressSingleSpeakerMetadata } from "./speechIngressStore.js";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("speech ingress stores one host record with complete speaker turns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-ingress-"));
  const store = new SpeechIngressStore(root);
  const first = store.append({
    recordId: "speech-record-one",
    text: "明天三点开会 我知道了",
    sessionId: "room-one",
    source: "microphone",
    sourceHostId: "host-guid-one",
    sourceHostName: "Studio PC",
    sourceDeviceId: "phone-one",
    sourceStreamId: "phone-one-audio",
    audioFormat: "pcm_s16le",
    channels: 1,
    peak: 0.42,
    rms: 0.18,
    provider: "dashscope",
    model: "paraformer-v2",
    language: "zh",
    duration: 3.2,
    recordedAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:00:00.000Z",
    completedAt: "2026-07-23T10:00:03.200Z",
    segments: [
      {
        id: 0,
        start: 0,
        end: 1.6,
        text: "明天三点开会",
        speakerLabel: "Speaker 1",
        speakerId: "voiceprint-a",
        speakerClusterId: "cluster-user",
        speakerName: "用户",
        speakerDecision: "voiceprint_auto_match",
        speakerScore: 0.91,
        words: [
          { id: 0, word: "明天", start: 0, end: 0.4, probability: 0.96, speaker: "Speaker 1" },
          { id: 1, word: "三点开会", start: 0.4, end: 1.6, probability: 0.93, speaker: "Speaker 1" }
        ]
      },
      {
        id: 1,
        start: 1.7,
        end: 3.2,
        text: "我知道了",
        speakerLabel: "Speaker 2",
        speakerClusterId: "cluster-guest",
        speakerDecision: "voiceprint_unknown_cluster"
      }
    ]
  }, "fallback-id");

  assert.equal(first.appended, true);
  assert.equal(first.record.id, "speech-record-one");
  assert.equal(first.record.sourceHostId, "host-guid-one");
  assert.equal(first.record.sourceHostName, "Studio PC");
  assert.equal(first.record.sourceDeviceId, "phone-one");
  assert.equal(first.record.sourceStreamId, "phone-one-audio");
  assert.equal(first.record.audioFormat, "pcm_s16le");
  assert.equal(first.record.channels, 1);
  assert.equal(first.record.peak, 0.42);
  assert.equal(first.record.rms, 0.18);
  assert.equal(first.record.startedAt, "2026-07-23T10:00:00.000Z");
  assert.equal(first.record.completedAt, "2026-07-23T10:00:03.200Z");
  assert.equal(first.record.segments[0]?.speakerId, undefined);
  assert.equal(first.record.segments[0]?.voiceprintId, "cluster-user");
  assert.equal(first.record.segments[0]?.speakerName, undefined);
  assert.deepEqual(first.record.segments[0]?.words, [
    { id: 0, word: "明天", start: 0, end: 0.4, probability: 0.96, confidence: undefined, speaker: "Speaker 1" },
    { id: 1, word: "三点开会", start: 0.4, end: 1.6, probability: 0.93, confidence: undefined, speaker: "Speaker 1" }
  ]);
  assert.equal(first.record.segments[1]?.speakerClusterId, "cluster-guest");
  assert.equal(first.record.segments[1]?.voiceprintId, "cluster-guest");
  assert.equal(speechIngressDisplayText(first.record), "cluster-user：明天三点开会\ncluster-guest：我知道了");

  const duplicate = store.append({ recordId: "speech-record-one", text: "重试不应覆盖", sessionId: "room-one" });
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.record.text, "明天三点开会 我知道了");
  assert.equal(store.list()[0]?.id, "speech-record-one");
  store.appendDeliveryReceipt({
    schemaVersion: 1,
    recordId: "speech-record-one",
    routeId: "RouteB",
    messageAdapterType: "speech",
    status: "recorded",
    reason: "keyword_not_matched",
    completedAt: "2026-07-23T10:00:02.000Z"
  });
  store.appendDeliveryReceipt({
    schemaVersion: 1,
    recordId: "speech-record-one",
    routeId: "RouteA",
    messageAdapterType: "speech",
    status: "delivered",
    completedAt: "2026-07-23T10:00:01.000Z"
  });
  assert.deepEqual(
    store.listDeliveryReceipts("speech-record-one").map(item => [item.routeId, item.status]),
    [["RouteA", "delivered"], ["RouteB", "recorded"]]
  );
});

test("speech ingress exposes only canonical voiceprint evidence to Route metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-ingress-identity-"));
  const record = new SpeechIngressStore(root).append({
    recordId: "speech-single-speaker",
    text: "继续处理。",
    sourceHostId: "host-guid-one",
    segments: [{
      id: 0,
      start: 0,
      end: 1,
      text: "继续处理。",
      voiceprintId: "cluster-user",
      speakerClusterId: "cluster-user",
      speakerId: "host-profile-user",
      speakerSuggestionId: "host-candidate-user"
    }]
  }).record;

  assert.equal(speechIngressDisplayText(record), "cluster-user：继续处理。");
  assert.equal(record.segments[0]?.speakerId, undefined);
  assert.equal(record.segments[0]?.speakerSuggestionId, undefined);
  assert.deepEqual(speechIngressSingleSpeakerMetadata(record), {
    speakerId: "cluster-user",
    speakerConfidence: undefined,
    speakerDecision: undefined,
    voiceprintId: "cluster-user"
  });
});

test("speech ingress serializes host-record deduplication across processes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-speech-ingress-lock-"));
  const lockPath = path.join(root, ".speech-ingress.lock");
  const readyPath = path.join(root, "lock-ready");
  const holder = spawn(process.execPath, [
    "-e",
    [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "const lock=process.argv[1];",
      "const ready=process.argv[2];",
      "fs.mkdirSync(path.dirname(lock), {recursive:true});",
      "fs.writeFileSync(lock, 'held\\n');",
      "fs.writeFileSync(ready, 'ready\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);",
      "fs.unlinkSync(lock);"
    ].join(""),
    lockPath,
    readyPath
  ], { stdio: "ignore" });
  t.after(() => {
    if (holder.exitCode == null) holder.kill();
  });
  await waitForFile(readyPath);

  const store = new SpeechIngressStore(root);
  const startedAt = Date.now();
  const result = store.append({ recordId: "one-record", text: "只写一次", sessionId: "one-session" });
  const elapsedMs = Date.now() - startedAt;
  if (holder.exitCode == null) await once(holder, "exit");

  assert.equal(result.appended, true);
  assert.ok(elapsedMs >= 200, `Expected append to wait for the host-record lock, waited ${elapsedMs}ms.`);
  assert.equal(store.list().filter(item => item.id === "one-record").length, 1);
});
