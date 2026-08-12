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
    routeProfileId: "Ilias",
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
  assert.equal(entries[0].routeProfileId, "Ilias");
  assert.equal(entries[0].sourceDeviceKind, "phone");
  assert.equal(entries[0].transport, "phone-companion");
  assert.equal(entries[0].recordedAt, "2026-07-14T09:30:04.000Z");
  assert.equal(entries[0].capturedAt, Date.parse("2026-07-14T09:30:00.000Z"));
  assert.equal(entries[0].identityEndpoints, undefined);
});

test("record-first keeps normalized trusted device and multi-speaker endpoints for later identity review", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-record-first-identities-"));
  recordRabiLinkVoiceObservation({
    time: 1,
    rawMessage: "多人语音观察",
    messageId: "mobile-audio-one",
    adapterType: "rabilink",
    senderName: "Phone",
    senderIdentityTrusted: true,
    voiceIdentityTrusted: true,
    identityNamespace: "relay:rabilink",
    senderStableId: "phone-one",
    sourceHostId: "speech-host",
    segments: [
      { id: 1, start: 0, end: 1, text: "第一人", voiceprintId: "voice-a" },
      { id: 2, start: 1, end: 2, text: "第二人", speakerClusterId: "voice-b" }
    ]
  }, { dataDir, wakeReviewer: false });

  const endpoints = readRabiLinkConversationEntries(dataDir)[0]?.identityEndpoints ?? [];
  assert.deepEqual(endpoints.map(item => [item.platform, item.endpointIdentityNamespace, item.senderStableId]), [
    ["voice", "host:speech-host", "voice-a"],
    ["voice", "host:speech-host", "voice-b"],
    ["rabilink", "relay:rabilink", "phone-one"]
  ]);
});
