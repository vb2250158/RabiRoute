import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendMessageContextToDir,
  messageContextFromOutboxEvent,
  recentMessageContextItems,
  recentMessageContextText
} from "./messageContext.js";

test("message context merges legacy inbound and outbound endpoint records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-context-"));
  fs.writeFileSync(path.join(dir, "group-messages.jsonl"), `${JSON.stringify({
    time: 10,
    groupId: 123,
    userId: 456,
    rawMessage: "用户问题",
    messageId: "in-1",
    senderName: "用户"
  })}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "outbox-adapter.log.jsonl"), `${JSON.stringify({
    time: 11,
    event: "reply_sent",
    message: "Agent 回复",
    data: { targetType: "group", groupId: 123, messageId: "in-1", sentMessageId: "out-1" }
  })}\n`, "utf8");
  fs.mkdirSync(path.join(dir, "role-panel"));
  fs.writeFileSync(path.join(dir, "role-panel", "messages.jsonl"), `${JSON.stringify({
    id: "panel-user-1",
    time: 12,
    direction: "user",
    sender: "本地用户",
    text: "面板补充"
  })}\n`, "utf8");

  const items = recentMessageContextItems([dir], 20);
  assert.deepEqual(items.map(item => [item.adapter, item.direction, item.text]), [
    ["napcat", "inbound", "用户问题"],
    ["napcat", "outbound", "Agent 回复"],
    ["rolePanel", "inbound", "面板补充"]
  ]);
  assert.match(recentMessageContextText([dir], 20), /出站 \| napcat/);
});

test("message context includes ASR and TTS while deduplicating migrated rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-context-voice-"));
  fs.writeFileSync(path.join(dir, "voice-transcripts.jsonl"), [
    JSON.stringify({ time: 20, kind: "asr", adapterType: "speech", rawMessage: "星海，在吗", messageId: "asr-1" }),
    JSON.stringify({ time: 21, kind: "tts", adapterType: "speech", rawMessage: "我在", messageId: "tts-1", isSelf: true })
  ].join("\n") + "\n", "utf8");
  appendMessageContextToDir(dir, {
    time: 21,
    direction: "outbound",
    adapter: "speech",
    kind: "tts",
    text: "我在",
    messageId: "tts-1"
  }, { archiveCheck: false });

  const items = recentMessageContextItems([dir], 20);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.kind), ["asr", "tts"]);
});

test("only successful Outbox events become outbound context", () => {
  assert.equal(messageContextFromOutboxEvent("reply_blocked", "未发送", {}), undefined);
  const sent = messageContextFromOutboxEvent("rabispeech_tts_sent", "语音回复", {
    routeProfileId: "voice-route",
    sentMessageId: "play-1"
  }, 30);
  assert.equal(sent?.adapter, "speech");
  assert.equal(sent?.direction, "outbound");
});
