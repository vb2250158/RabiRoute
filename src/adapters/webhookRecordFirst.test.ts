import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { readRabiLinkConversationEntries } from "../rabilinkConversationLedger.js";

test("FenneNote webhook can be recorded for idle review without direct Agent forwarding", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-fennenote-record-first-"));
  config.dataDir = dataDir;
  config.memoryDataDir = dataDir;
  config.agentAdapters = [];
  config.routeVariables = {
    rabilinkRecordFirstSources: "fennenote",
    rabilinkConversationSplitAfterHours: "6"
  };

  const { acceptWebhookPayload } = await import("./webhookAdapter.js");
  const record = acceptWebhookPayload({
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    source: "fennenote",
    path: "/fennenote",
    port: 8797,
    acceptedTypes: ["voice_transcript"],
    routeKind: "voice_transcript",
    missingTextMessage: "missing text"
  }, "/fennenote", {
    type: "voice_transcript",
    source: "fennenote",
    text: "只记录这段常驻转写，等线程空闲再审阅。",
    messageId: "segment-record-first-1",
    time: Date.parse("2026-07-14T10:00:00.000Z") / 1000
  }, 128);

  assert.equal(record.rawMessage, "只记录这段常驻转写，等线程空闲再审阅。");
  const ledger = readRabiLinkConversationEntries(dataDir);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].requiresReview, true);
  assert.equal(ledger[0].source, "fennenote");
  assert.equal(fs.existsSync(path.join(dataDir, "fennenote-voice-transcripts.jsonl")), true);
  assert.equal(fs.existsSync(path.join(dataDir, "agent-packets.jsonl")), false);

  const adapterLog = fs.readFileSync(path.join(dataDir, "fennenote-adapter.log.jsonl"), "utf8");
  assert.match(adapterLog, /"forwarding":"record_only"/);

  const retryWithoutId = {
    type: "voice_transcript",
    source: "fennenote",
    text: "这段没有显式消息 ID，但生产端时间戳可以稳定标识重试。",
    time: Date.parse("2026-07-14T10:01:00.000Z") / 1000
  };
  const firstRetryRecord = acceptWebhookPayload({
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    source: "fennenote",
    path: "/fennenote",
    port: 8797,
    acceptedTypes: ["voice_transcript"],
    routeKind: "voice_transcript",
    missingTextMessage: "missing text"
  }, "/fennenote", retryWithoutId, 128);
  acceptWebhookPayload({
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    source: "fennenote",
    path: "/fennenote",
    port: 8797,
    acceptedTypes: ["voice_transcript"],
    routeKind: "voice_transcript",
    missingTextMessage: "missing text"
  }, "/fennenote", retryWithoutId, 128);

  assert.equal(firstRetryRecord.messageId, undefined);
  const ledgerAfterRetry = readRabiLinkConversationEntries(dataDir);
  assert.equal(ledgerAfterRetry.length, 2);
  assert.equal(ledgerAfterRetry[1].text, retryWithoutId.text);
  assert.equal(fs.existsSync(path.join(dataDir, "agent-packets.jsonl")), false);
});
