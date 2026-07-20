import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { readGroupMessages } from "./history.js";
import { replyIdsForTest, resolveNapCatReplyChain } from "./napcatReplyMessages.js";

test("NapCat reply resolver reads structured and CQ reply ids", () => {
  assert.deepEqual(
    replyIdsForTest(
      "[CQ:reply,id=reply-from-cq]正文",
      [{ type: "reply", data: { id: "reply-from-segment" } }]
    ),
    ["reply-from-segment", "reply-from-cq"]
  );
});

test("NapCat reply resolver fetches and caches a missing recursive reply chain", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-reply-"));
  const requested: string[] = [];
  const messages = new Map([
    ["300", {
      selfId: 9000,
      userId: 9000,
      time: 3,
      messageId: 300,
      messageType: "group",
      groupId: 7000,
      senderName: "路由助手",
      rawMessage: "[CQ:reply,id=200][CQ:at,qq=1000]第二层说明",
      message: [
        { type: "reply", data: { id: "200" } },
        { type: "at", data: { qq: "1000" } },
        { type: "text", data: { text: "第二层说明" } }
      ]
    }],
    ["200", {
      selfId: 9000,
      userId: 1000,
      time: 2,
      messageId: 200,
      messageType: "group",
      groupId: 7000,
      senderName: "测试同学",
      rawMessage: "最早的问题描述",
      message: [{ type: "text", data: { text: "最早的问题描述" } }]
    }]
  ]);

  const result = await resolveNapCatReplyChain({
    rawMessage: "[CQ:reply,id=300]当前追问",
    currentMessageId: 400,
    sourceMessageType: "group",
    sourceGroupId: 7000,
    sourceUserId: 1001,
    selfId: 9000,
    botNickname: "路由助手",
    instanceId: "napcat-test",
    endpoint: { httpUrl: "http://127.0.0.1:3000", accessToken: "" },
    dataDir,
    getMessageById: async (messageId) => {
      requested.push(messageId);
      const message = messages.get(messageId);
      if (!message) throw new Error(`missing test message ${messageId}`);
      return message;
    }
  });

  assert.deepEqual(requested, ["300", "200"]);
  assert.deepEqual(result.resolvedMessageIds, ["300", "200"]);
  assert.deepEqual(result.errors, []);
  const cached = readGroupMessages(dataDir);
  assert.deepEqual(cached.map((item) => String(item.messageId)), ["300", "200"]);
  assert.equal(cached[0].lookupSource, "onebot_get_msg");
  assert.equal(cached[0].isSelf, true);
  assert.equal(cached[1].senderName, "测试同学");
});

test("NapCat reply resolver reports get_msg failures without blocking the current message", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-reply-error-"));
  const result = await resolveNapCatReplyChain({
    rawMessage: "[CQ:reply,id=missing]当前追问",
    sourceMessageType: "group",
    sourceGroupId: 7000,
    sourceUserId: 1001,
    selfId: 9000,
    instanceId: "napcat-test",
    endpoint: { httpUrl: "http://127.0.0.1:3000", accessToken: "" },
    dataDir,
    getMessageById: async () => {
      throw new Error("NapCat unavailable");
    }
  });

  assert.deepEqual(result.resolvedMessageIds, []);
  assert.deepEqual(result.errors, [{ messageId: "missing", message: "NapCat unavailable" }]);
  assert.deepEqual(readGroupMessages(dataDir), []);
});
