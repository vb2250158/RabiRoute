import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePendingMessageGroup,
  messageGroupEnqueueInputForForward
} from "./messageGroupingForward.js";
import type { GroupMessageRecord } from "../history.js";
import type { PendingMessageGroup } from "../messageGrouping.js";

const policy = {
  enabled: true,
  settleSeconds: 6,
  incompleteSettleSeconds: 12,
  maxWaitSeconds: 20
};

test("forward records map to a stable endpoint, conversation, speaker, and reply grouping key", () => {
  const record: GroupMessageRecord = {
    time: 1_785_820_000,
    groupId: 10001,
    userId: 20002,
    senderName: "小明",
    messageId: 30003,
    repliedMessageId: "29999",
    rawMessage: "这个"
  };
  const input = messageGroupEnqueueInputForForward("direct_reply", record, {}, policy, "route-main");

  assert.equal(input?.endpoint, "napcat");
  assert.match(input?.conversationKey ?? "", /group:10001/);
  assert.match(input?.baseKey ?? "", /sender:小明/);
  assert.match(input?.key ?? "", /reply:29999/);
  assert.match(input?.identity ?? "", /message:30003/);
});

test("message-group merge keeps every fragment, attachment, message id, and strongest route", () => {
  const group: PendingMessageGroup = {
    groupId: "message-group-test",
    key: "key",
    baseKey: "base",
    endpoint: "napcat",
    conversationKey: "napcat:group:10001",
    sender: "小明",
    createdAt: 1_000,
    updatedAt: 2_000,
    deadlineAt: 8_000,
    maxDeadlineAt: 21_000,
    status: "pending",
    attempts: 0,
    items: [
      {
        identity: "m1",
        receivedAt: 1_000,
        incomplete: true,
        payload: {
          routeKind: "group_message",
          record: { time: 1, groupId: 10001, userId: 20002, messageId: "m1", rawMessage: "这个", attachments: [{ name: "a.png" }] },
          extraValues: { first: "yes" }
        }
      },
      {
        identity: "m2",
        receivedAt: 2_000,
        incomplete: false,
        payload: {
          routeKind: "direct_at",
          record: { time: 2, groupId: 10001, userId: 20002, messageId: "m2", rawMessage: "按钮往下挪一点。", segments: [{ type: "text" }] },
          extraValues: { second: "yes" }
        }
      }
    ]
  };

  const merged = mergePendingMessageGroup(group);
  assert.equal(merged.routeKind, "direct_at");
  assert.equal(merged.record.rawMessage, "这个\n按钮往下挪一点。");
  assert.equal(merged.record.messageId, "m2");
  assert.deepEqual((merged.record as any).attachments, [{ name: "a.png" }]);
  assert.deepEqual((merged.record as any).segments, [{ type: "text" }]);
  assert.equal(merged.extraValues.messageGroupId, "message-group-test");
  assert.equal(merged.extraValues.messageGroupMessageCount, 2);
  assert.equal(merged.extraValues.messageGroupMessageIds, "m1,m2");
  assert.equal(merged.record.messageGroupId, group.groupId);
  assert.deepEqual(merged.record.messageGroupMessageIds, ["m1", "m2"]);
});
