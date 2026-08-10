import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listConversationSituations, recordConversationSituation } from "./conversationSituationStore.js";
import { conversationSituationForIdentity } from "./routing/conversationSituation.js";

test("conversation situation snapshots preserve a reviewable shadow assessment without chat text", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-conversation-situation-"));
  const situation = conversationSituationForIdentity(undefined, {
    conversationId: "napcat:instance:qq-main:group:b4f8",
    messageIds: ["message-1"],
    routeKind: "group_message"
  });
  const stored = recordConversationSituation(roleDir, "route-xinghai", "group_message", situation);
  assert.ok(stored);
  assert.equal(stored?.conversationId, "napcat:instance:qq-main:group:b4f8");
  assert.equal(stored?.decisions.mayCreateOrUpdateCurrentProjectRecords, false);
  assert.equal(listConversationSituations(roleDir)[0]?.id, stored?.id);
  const serialized = fs.readFileSync(path.join(roleDir, "conversation", "situations", `${stored?.id}.json`), "utf8");
  assert.doesNotMatch(serialized, /边缘空间|rawMessage|聊天正文/);
});

test("replaying one delivered message updates the same situation snapshot", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-conversation-situation-replay-"));
  const situation = conversationSituationForIdentity(undefined, {
    conversationId: "napcat:instance:qq-main:group:b4f8",
    messageIds: ["message-1"],
    routeKind: "group_message"
  });
  const first = recordConversationSituation(roleDir, "route-xinghai", "group_message", situation);
  const second = recordConversationSituation(roleDir, "route-xinghai", "group_message", situation);
  assert.equal(second?.id, first?.id);
  assert.equal(listConversationSituations(roleDir).length, 1);
});

test("conversation situation shadow records retain a bounded review window", () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-conversation-situation-retention-"));
  for (let index = 0; index < 203; index += 1) {
    recordConversationSituation(roleDir, "route-xinghai", "group_message", conversationSituationForIdentity(undefined, {
      conversationId: "napcat:instance:qq-main:group:b4f8", messageIds: [`message-${index}`], routeKind: "group_message"
    }));
  }
  assert.equal(listConversationSituations(roleDir, 1_000).length, 200);
});
