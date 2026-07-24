import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageContextToDir } from "./messageContextStore.js";
import { updatePersonaVoiceIdentity } from "./personaVoiceIdentities.js";
import { listPersonaVoiceTranscriptViews, queryPersonaVoiceTranscriptViews } from "./personaVoiceTranscriptView.js";

test("persona voice transcript view joins explicit user relationships without rewriting raw speech", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-voice-view-"));
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-one",
    voiceprintId: "cluster-user",
    displayName: "老板",
    relationship: "当前人格的用户",
    isUser: true,
    aliases: []
  });
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-one",
    voiceprintId: "cluster-colleague",
    displayName: "同事甲",
    relationship: "项目同事",
    isUser: false,
    aliases: []
  });
  updatePersonaVoiceIdentity(roleDir, {
    sourceHostId: "host-one",
    voiceprintId: "host-profile-user",
    displayName: "主机候选资料",
    relationship: "不能决定人格关系",
    isUser: false,
    aliases: []
  });
  const base = Date.UTC(2026, 6, 23, 9, 0, 0) / 1_000;
  appendMessageContextToDir(roleDir, {
    time: base,
    direction: "inbound",
    adapter: "speech",
    kind: "asr",
    sourceHostId: "host-one",
    text: "先处理接口。",
    messageId: "voice-user",
    segments: [{
      id: 0,
      start: 0,
      end: 1,
      text: "先处理接口。",
      voiceprintId: "cluster-user",
      speakerClusterId: "cluster-user",
      speakerId: "host-profile-user",
      speakerSuggestionId: "host-profile-user"
    }]
  }, { archiveCheck: false });
  appendMessageContextToDir(roleDir, {
    time: base + 60,
    direction: "inbound",
    adapter: "speech",
    kind: "asr",
    sourceHostId: "host-one",
    text: "我来测试。",
    messageId: "voice-mixed",
    segments: [
      { id: 0, start: 0, end: 1, text: "先处理接口。", speakerClusterId: "cluster-user" },
      { id: 1, start: 1, end: 2, text: "我来测试。", speakerClusterId: "cluster-colleague" }
    ]
  }, { archiveCheck: false });
  appendMessageContextToDir(roleDir, {
    time: base + 120,
    direction: "inbound",
    adapter: "rabilink",
    kind: "asr",
    channelType: "rabilink.mobile_audio",
    sourceHostId: "host-two",
    text: "另一台电脑上的同名簇。",
    messageId: "voice-other-host",
    segments: [{ id: 0, start: 0, end: 1, text: "另一台电脑上的同名簇。", speakerClusterId: "cluster-user" }]
  }, { archiveCheck: false });

  const all = listPersonaVoiceTranscriptViews(roleDir, { limit: 10 });
  assert.deepEqual(all.map(item => item.personaClassification), ["user", "mixed", "unknown"]);
  assert.equal(all[0]?.segmentViews[0]?.evidence[0]?.identity?.displayName, "老板");
  assert.equal(all[1]?.segmentViews[1]?.classification, "other");
  assert.equal(all[2]?.segmentViews[0]?.evidence[0]?.identity, undefined);

  const user = listPersonaVoiceTranscriptViews(roleDir, { speaker: "user", limit: 10 });
  assert.deepEqual(user.map(item => item.record.messageId), ["voice-user", "voice-mixed"]);
  const other = listPersonaVoiceTranscriptViews(roleDir, { speaker: "other", limit: 10 });
  assert.deepEqual(other.map(item => item.record.messageId), ["voice-mixed"]);
  const later = listPersonaVoiceTranscriptViews(roleDir, { from: base + 90, to: base + 180, limit: 10 });
  assert.deepEqual(later.map(item => item.record.messageId), ["voice-other-host"]);

  const report = queryPersonaVoiceTranscriptViews(roleDir, { limit: 1 });
  assert.equal(report.matchedCount, 3);
  assert.equal(report.items.length, 1);
  assert.equal(report.summary.recordCount, 3);
  assert.equal(report.summary.mixedRecordCount, 1);
  assert.equal(report.summary.byClassification.user.segments, 2);
  assert.equal(report.summary.byClassification.other.segments, 1);
  assert.equal(report.summary.byClassification.unknown.segments, 1);
  assert.equal(report.summary.coverageRate, 0.75);
  assert.deepEqual(report.summary.unresolvedVoiceprints.map(item => [item.sourceHostId, item.voiceprintId]), [
    ["host-two", "cluster-user"]
  ]);

  const raw = fs.readFileSync(path.join(roleDir, "conversation", "current.jsonl"), "utf8");
  assert.doesNotMatch(raw, /老板|当前人格的用户|"isUser"/);
});
