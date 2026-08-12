import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendGroupMessageToDir } from "../history.js";
import type { PendingMessageGroup } from "../messageGrouping.js";
import { collectMessageGroupSourceEvidence } from "./sourceEvidence.js";

test("message source evidence keeps the exact reply chain and readable image paths", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-evidence-"));
  const imagePath = path.join(dataDir, "quoted.png");
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  appendGroupMessageToDir({
    time: 100,
    groupId: 10,
    userId: 20,
    messageId: "quoted-1",
    rawMessage: "[CQ:image,file=quoted.png] 动态提示",
    attachments: [{
      id: "quoted-1:image:1",
      kind: "image",
      name: "quoted.png",
      path: imagePath,
      size: 3,
      status: "ready",
      sourceMessageId: "quoted-1"
    }]
  }, dataDir);
  const group: PendingMessageGroup = {
    groupId: "group-1",
    key: "key",
    baseKey: "base",
    endpoint: "qq",
    conversationKey: "group:10",
    sender: "user:21",
    replyToMessageId: "quoted-1",
    createdAt: 101_000,
    updatedAt: 101_000,
    deadlineAt: 101_000,
    maxDeadlineAt: 101_000,
    status: "pending",
    attempts: 0,
    items: [{
      identity: "current",
      receivedAt: 101_000,
      incomplete: false,
      payload: {
        routeKind: "direct_reply",
        record: { time: 101, groupId: 10, userId: 21, messageId: "current-1", repliedMessageId: "quoted-1", rawMessage: "动态显示的" },
        extraValues: {}
      }
    }]
  };

  const evidence = collectMessageGroupSourceEvidence(group, dataDir);
  assert.deepEqual(evidence.replyChainMessageIds, ["quoted-1"]);
  assert.equal(evidence.attachments[0]?.id, "quoted-1:image:1");
  assert.deepEqual(evidence.readyImagePaths, [imagePath]);
});

test("message source evidence marks CQ images without a local file as unavailable", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-evidence-missing-"));
  const group = {
    groupId: "group-2",
    key: "key",
    baseKey: "base",
    endpoint: "qq",
    conversationKey: "group:10",
    sender: "user:21",
    createdAt: 101_000,
    updatedAt: 101_000,
    deadlineAt: 101_000,
    maxDeadlineAt: 101_000,
    status: "pending",
    attempts: 0,
    items: [{
      identity: "current",
      receivedAt: 101_000,
      incomplete: false,
      payload: {
        routeKind: "group_message",
        record: { time: 101, groupId: 10, userId: 21, messageId: "current-2", rawMessage: "[CQ:image,file=missing.png] 看下这个" },
        extraValues: {}
      }
    }]
  } satisfies PendingMessageGroup;

  const evidence = collectMessageGroupSourceEvidence(group, dataDir);
  assert.equal(evidence.attachments[0]?.status, "unavailable");
  assert.match(evidence.attachments[0]?.error || "", /没有保存为本地附件/);
  assert.deepEqual(evidence.readyImagePaths, []);
});
