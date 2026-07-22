import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMessageContextToDir,
  messageContextArchiveIndexPath,
  messageContextCurrentPath,
  messageContextFromHistoryRecord,
  messageContextFromOutboxEvent,
  readMessageContextArchiveIndex,
  recentMessageContextItems,
  recentMessageContextText
} from "./messageContextStore.js";

function temporaryDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-${name}-`));
}

test("message context archives an exact old prefix only after the 72h trigger", () => {
  const dir = temporaryDir("message-context-archive");
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  const hour = 60 * 60;
  appendMessageContextToDir(dir, {
    time: now / 1_000 - 80 * hour,
    direction: "inbound",
    adapter: "speech",
    channel: "speech",
    conversationKey: "speech:session:one",
    kind: "asr",
    text: "最早的语音"
  }, { archiveCheck: false, now });
  appendMessageContextToDir(dir, {
    time: now / 1_000 - 30 * hour,
    direction: "outbound",
    adapter: "speech",
    channel: "speech",
    conversationKey: "speech:session:one",
    kind: "tts",
    text: "较早的回复"
  }, { archiveCheck: false, now });
  const appended = appendMessageContextToDir(dir, {
    time: now / 1_000 - hour,
    direction: "inbound",
    adapter: "speech",
    channel: "speech",
    conversationKey: "speech:session:one",
    kind: "asr",
    text: "当前语音"
  }, { now });

  assert.match(appended?.archivedPath || "", /1~2\.jsonl$/);
  const index = readMessageContextArchiveIndex(dir);
  assert.deepEqual(index.archives.map((item) => [item.firstSequence, item.lastSequence, item.entryCount]), [[1, 2, 2]]);
  assert.equal(fs.readFileSync(messageContextCurrentPath(dir), "utf8").trim().split(/\r?\n/).length, 1);
  assert.deepEqual(recentMessageContextItems([dir], { limit: 10 }).map((item) => item.text), ["当前语音"]);
  assert.deepEqual(recentMessageContextItems([dir], { limit: 10, includeArchives: true }).map((item) => item.text), [
    "最早的语音",
    "较早的回复",
    "当前语音"
  ]);
});

test("message context does not archive a 24h-old prefix until a record exceeds 72h", () => {
  const dir = temporaryDir("message-context-no-archive");
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  appendMessageContextToDir(dir, {
    time: now / 1_000 - 48 * 60 * 60,
    direction: "inbound",
    adapter: "wecom",
    channel: "wecom",
    conversationKey: "wecom:chat-one",
    text: "两天前"
  }, { archiveCheck: false, now });
  const appended = appendMessageContextToDir(dir, {
    time: now / 1_000,
    direction: "inbound",
    adapter: "wecom",
    channel: "wecom",
    conversationKey: "wecom:chat-one",
    text: "现在"
  }, { now });
  assert.equal(appended?.archivedPath, undefined);
  assert.equal(readMessageContextArchiveIndex(dir).archives.length, 0);
});

test("automatic context shares one ASR/TTS budget within the current endpoint conversation", () => {
  const dir = temporaryDir("message-context-filter");
  const records = [
    { time: 1, direction: "inbound" as const, adapter: "speech", channel: "speech", conversationKey: "speech:session:one", kind: "asr", text: "ASR 一" },
    { time: 2, direction: "outbound" as const, adapter: "speech", channel: "speech", conversationKey: "speech:session:one", kind: "tts", text: "TTS 一" },
    { time: 3, direction: "inbound" as const, adapter: "napcat", channel: "napcat", conversationKey: "napcat:group:100", kind: "group", text: "QQ 消息" },
    { time: 4, direction: "inbound" as const, adapter: "speech", channel: "speech", conversationKey: "speech:session:two", kind: "asr", text: "另一个 session" }
  ];
  for (const record of records) appendMessageContextToDir(dir, record, { archiveCheck: false });

  const items = recentMessageContextItems([dir], {
    limit: 2,
    adapter: "speech",
    channel: "speech",
    conversationKey: "speech:session:one"
  });
  assert.deepEqual(items.map((item) => [item.direction, item.kind, item.text]), [
    ["inbound", "asr", "ASR 一"],
    ["outbound", "tts", "TTS 一"]
  ]);
  assert.match(recentMessageContextText([dir], {
    limit: 2,
    adapter: "speech",
    channel: "speech",
    conversationKey: "speech:session:one"
  }), /出站 \| speech\/tts/);
});

test("legacy raw logs migrate once while failed Outbox sends stay out of context", () => {
  const dir = temporaryDir("message-context-legacy");
  fs.writeFileSync(path.join(dir, "group-messages.jsonl"), `${JSON.stringify({
    time: 10,
    groupId: 100,
    userId: 200,
    rawMessage: "旧入站",
    messageId: "in-1"
  })}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "outbox-adapter.log.jsonl"), [
    JSON.stringify({ time: 11, event: "reply_sent", message: "旧出站", data: { targetType: "group", groupId: 100, sentMessageId: "out-1", messageId: "in-1" } }),
    JSON.stringify({ time: 12, event: "reply_failed", message: "未发送", data: { targetType: "group", groupId: 100 } })
  ].join("\n") + "\n", "utf8");

  appendMessageContextToDir(dir, {
    time: 13,
    direction: "inbound",
    adapter: "napcat",
    channel: "napcat",
    conversationKey: "napcat:group:100",
    text: "新入站",
    messageId: "in-2"
  }, { archiveCheck: false });

  assert.deepEqual(recentMessageContextItems([dir], {
    limit: 10,
    adapter: "napcat",
    channel: "napcat",
    conversationKey: "napcat:group:100"
  }).map((item) => item.text), ["旧入站", "旧出站", "新入站"]);
});

test("stable endpoint message ids deduplicate explicit sends and later self echoes", () => {
  const dir = temporaryDir("message-context-dedupe");
  const sent = messageContextFromOutboxEvent("reply_sent", "已发送", {
    targetType: "group",
    groupId: 100,
    sentMessageId: "out-1"
  }, 20);
  assert.ok(sent);
  appendMessageContextToDir(dir, sent, { archiveCheck: false });
  const echo = messageContextFromHistoryRecord("group", {
    time: 21,
    groupId: 100,
    rawMessage: "已发送",
    messageId: "out-1",
    isSelf: true
  });
  assert.ok(echo);
  const appended = appendMessageContextToDir(dir, echo, { archiveCheck: false });
  assert.equal(appended?.appended, false);
  assert.equal(recentMessageContextItems([dir], 10).length, 1);
});

test("timestamps accept ISO or milliseconds and nextSequence recovers from current records", () => {
  const dir = temporaryDir("message-context-time");
  const firstAt = Date.UTC(2026, 6, 21, 10, 0, 0);
  appendMessageContextToDir(dir, {
    time: new Date(firstAt).toISOString() as unknown as number,
    direction: "inbound",
    adapter: "wecom",
    conversationKey: "wecom:one",
    text: "ISO 时间"
  }, { archiveCheck: false });
  appendMessageContextToDir(dir, {
    time: firstAt + 1_000,
    direction: "inbound",
    adapter: "wecom",
    conversationKey: "wecom:one",
    text: "毫秒时间"
  }, { archiveCheck: false });
  fs.writeFileSync(messageContextArchiveIndexPath(dir), `${JSON.stringify({ schemaVersion: 1, nextSequence: 1, archives: [] })}\n`, "utf8");
  const third = appendMessageContextToDir(dir, {
    time: firstAt / 1_000 + 2,
    direction: "inbound",
    adapter: "wecom",
    conversationKey: "wecom:one",
    text: "恢复序号"
  }, { archiveCheck: false });

  assert.equal(third?.record.sequence, 3);
  assert.deepEqual(recentMessageContextItems([dir], 10).map(item => item.time), [
    firstAt / 1_000,
    firstAt / 1_000 + 1,
    firstAt / 1_000 + 2
  ]);
});

test("message ids are scoped by gateway and archived self echoes still deduplicate", () => {
  const dir = temporaryDir("message-context-scope");
  const now = Date.UTC(2026, 6, 21, 12, 0, 0);
  const old = now / 1_000 - 80 * 60 * 60;
  for (const gatewayId of ["route-a", "route-b"]) {
    appendMessageContextToDir(dir, {
      time: old,
      direction: "outbound",
      adapter: "napcat",
      transport: "napcat",
      gatewayId,
      instanceId: "qq-main",
      conversationKey: `napcat:gateway:${gatewayId}:instance:qq-main:group:100`,
      text: `回复 ${gatewayId}`,
      messageId: "same-id"
    }, { archiveCheck: false, now });
  }
  appendMessageContextToDir(dir, {
    time: now / 1_000,
    direction: "inbound",
    adapter: "napcat",
    gatewayId: "route-a",
    instanceId: "qq-main",
    conversationKey: "napcat:gateway:route-a:instance:qq-main:group:100",
    text: "当前消息",
    messageId: "current"
  }, { now });

  const echo = messageContextFromHistoryRecord("group", {
    time: now / 1_000 + 1,
    groupId: 100,
    rawMessage: "回复 route-a",
    messageId: "same-id",
    isSelf: true,
    gatewayId: "route-a",
    instanceId: "qq-main"
  });
  assert.ok(echo);
  assert.equal(appendMessageContextToDir(dir, echo, { archiveCheck: false, now })?.appended, false);
  assert.equal(recentMessageContextItems([dir], { limit: 10, includeArchives: true }).length, 3);
});

test("voice speaker identity and heartbeat endpoint metadata survive normalization", () => {
  const dir = temporaryDir("message-context-speaker");
  const voice = messageContextFromHistoryRecord("voice", {
    time: Date.now() / 1_000,
    rawMessage: "明天三点开会",
    kind: "asr",
    adapterType: "speech",
    transport: "rabipc",
    sessionId: "meeting-one",
    speakerId: "person-qiu-yu",
    speakerName: "秋雨",
    speakerKind: "known",
    speakerConfidence: 0.94,
    speakerDecision: "voiceprint",
    voiceprintId: "voiceprint-qiu-yu",
    speakerVerified: true
  });
  const heartbeat = messageContextFromHistoryRecord("heartbeat", {
    time: Date.now() / 1_000 + 1,
    rawMessage: "检查进度"
  });
  assert.ok(voice);
  assert.ok(heartbeat);
  appendMessageContextToDir(dir, voice, { archiveCheck: false });
  appendMessageContextToDir(dir, heartbeat, { archiveCheck: false });

  const items = recentMessageContextItems([dir], 10);
  assert.equal(items[0].speakerName, "秋雨");
  assert.equal(items[0].voiceprintId, "voiceprint-qiu-yu");
  assert.equal(items[0].speakerVerified, true);
  assert.equal(items[1].adapter, "heartbeat");
});

test("attachment-only messages remain visible without persisting local paths", () => {
  const dir = temporaryDir("message-context-attachment-only");
  const record = messageContextFromHistoryRecord("role_panel", {
    time: Date.now() / 1_000,
    roleId: "Rabi",
    rawMessage: "",
    attachments: [{
      id: "attachment-one",
      kind: "file",
      fileName: "C:\\Users\\PrivateUser\\Documents\\meeting-notes.pdf",
      mimeType: "application/pdf",
      size: 128
    }]
  });
  assert.ok(record);
  assert.equal(record.text, "[附件消息] meeting-notes.pdf");
  assert.equal(record.attachments?.[0]?.name, "meeting-notes.pdf");
  assert.doesNotMatch(JSON.stringify(record), /PrivateUser|Documents/);
  appendMessageContextToDir(dir, record, { archiveCheck: false });
  assert.equal(recentMessageContextItems([dir], 10)[0]?.text, "[附件消息] meeting-notes.pdf");
});

test("legacy RabiLink archived segments are imported into the canonical ledger", () => {
  const dir = temporaryDir("message-context-rabilink-archive");
  const archiveDir = path.join(dir, "rabilink-conversations");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, "2026-07-20.jsonl"), `${JSON.stringify({
    schemaVersion: 1,
    entryId: "rabilink-archived-1",
    recordedAt: "2026-07-20T10:00:00.000Z",
    time: Date.UTC(2026, 6, 20, 10, 0, 0) / 1_000,
    direction: "user_to_agent",
    kind: "voice_transcript",
    channel: "rabilink",
    text: "归档眼镜消息",
    sourceDeviceKind: "wearable",
    transport: "rabilink",
    sessionId: "glasses-one"
  })}\n`, "utf8");
  appendMessageContextToDir(dir, {
    time: Date.UTC(2026, 6, 21, 10, 0, 0) / 1_000,
    direction: "inbound",
    adapter: "wearable",
    transport: "rabilink",
    conversationKey: "wearable:session:glasses-one",
    text: "当前眼镜消息"
  }, { archiveCheck: false });

  const items = recentMessageContextItems([dir], { limit: 10, adapter: "wearable" });
  assert.deepEqual(items.map(item => item.text), ["归档眼镜消息", "当前眼镜消息"]);
  assert.equal(items[0].transport, "rabilink");
});
