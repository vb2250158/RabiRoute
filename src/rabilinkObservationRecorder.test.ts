import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRabiLinkConversationEntries } from "./rabilinkConversationLedger.js";
import {
  isRabiLinkRecordFirstSource,
  recordRabiLinkVoiceObservation
} from "./rabilinkObservationRecorder.js";

test("record-first source selection accepts adapter names, payload sources, JSON arrays, and wildcard", () => {
  assert.equal(isRabiLinkRecordFirstSource("fennenote", "desktop", {
    rabilinkRecordFirstSources: "fennenote, xiaoai"
  }), true);
  assert.equal(isRabiLinkRecordFirstSource("webhook", "fennenote", {
    rabilinkRecordFirstSources: "[\"fennenote\"]"
  }), true);
  assert.equal(isRabiLinkRecordFirstSource("webhook", "mobile", {
    rabilinkRecordFirstSources: "*"
  }), true);
  assert.equal(isRabiLinkRecordFirstSource("webhook", "mobile", {
    rabilinkRecordFirstSources: "fennenote"
  }), false);
});

test("a continuous transcript source enters the shared ledger once without becoming a direct Agent task", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-record-first-observation-"));
  const record = {
    time: Date.parse("2026-07-14T09:30:04.000Z") / 1000,
    rawMessage: "这是一条常驻转写观察，不应逐句直接投递。",
    messageId: "fennenote-segment-42",
    senderName: "FenneNote",
    adapterType: "fennenote",
    source: "fennenote",
    sourceDeviceId: "desktop-mic",
    sourceDeviceName: "Desk microphone",
    sourceDeviceKind: "phone",
    transport: "phone-companion",
    sessionId: "resident-session",
    startedAt: "2026-07-14T09:30:00.000Z",
    endedAt: "2026-07-14T09:30:04.000Z"
  };

  const first = recordRabiLinkVoiceObservation(record, {
    dataDir,
    wakeReviewer: false,
    routeVariables: { rabilinkConversationSplitAfterHours: "6" }
  });
  const duplicate = recordRabiLinkVoiceObservation(record, {
    dataDir,
    wakeReviewer: false,
    routeVariables: { rabilinkConversationSplitAfterHours: "6" }
  });

  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  const entries = readRabiLinkConversationEntries(dataDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].direction, "user_to_agent");
  assert.equal(entries[0].kind, "voice_transcript");
  assert.equal(entries[0].requiresReview, true);
  assert.equal(entries[0].source, "fennenote");
  assert.equal(entries[0].messageId, "fennenote-segment-42");
  assert.equal(entries[0].sessionId, "resident-session");
  assert.equal(entries[0].sourceDeviceKind, "phone");
  assert.equal(entries[0].transport, "phone-companion");
  assert.equal(entries[0].recordedAt, "2026-07-14T09:30:04.000Z");
  assert.equal(entries[0].capturedAt, Date.parse("2026-07-14T09:30:00.000Z"));
});
