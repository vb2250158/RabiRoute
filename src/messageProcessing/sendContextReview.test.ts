import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSendRequest } from "../agentSend.js";
import type { MessageContextRecord } from "../messageContextStore.js";
import type { MessageProcessingRequirement } from "./board.js";
import { MessageProcessingSendContextReview } from "./sendContextReview.js";

function requirement(status: MessageProcessingRequirement["status"] = "awaiting_send"): MessageProcessingRequirement {
  return {
    id: "requirement-1",
    dedupeKey: "message-group:requirement-1",
    kind: "message_reply",
    replyPolicy: "required",
    status,
    source: {
      routeId: "route-main",
      routeProfileId: "route-main",
      roleId: "Rabi",
      endpoint: "napcat",
      conversationKey: "napcat:group:456",
      sender: "user-1",
      routeKinds: ["direct_reply"],
      messageIds: ["source-1"],
      summary: "这和局域网访问有什么关系？",
      replyContext: { groupId: "456", messageId: "source-1" }
    },
    createdAt: "2026-08-11T09:40:00.000Z",
    updatedAt: "2026-08-11T09:41:00.000Z",
    dueAt: "2026-08-11T09:50:00.000Z"
  };
}

function inbound(messageId: string, text: string, time: number, replyToMessageId?: string): MessageContextRecord {
  return {
    id: `context-${messageId}`,
    time,
    direction: "inbound",
    adapter: "napcat",
    channel: "napcat",
    conversationKey: "napcat:group:456",
    sender: "user-1",
    text,
    messageId,
    replyToMessageId
  };
}

function outbound(messageId: string, text: string, time: number, replyToMessageId: string): MessageContextRecord {
  return {
    id: `context-${messageId}`,
    time,
    direction: "outbound",
    adapter: "napcat",
    channel: "napcat",
    conversationKey: "napcat:group:456",
    sender: "Agent",
    text,
    messageId,
    replyToMessageId
  };
}

function sendRequest(senderSessionId = "message-agent-1"): AgentSendRequest {
  return {
    deliveryId: "delivery-1",
    sender: { agentType: "message_processing", sessionId: senderSessionId },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-1" },
    payload: { type: "text", text: "这是 Rabi 局域网访问问题，与聊天计划无关。" },
    tracking: { requirementId: "requirement-1" }
  };
}

test("message-processing send is rejected until the exact latest context and payload are reviewed", () => {
  let currentRequirement = requirement();
  const records = [
    inbound("wrong-agent-reply", "错误关联到了聊天计划", 1),
    inbound("source-1", "这和局域网访问有什么关系？", 2, "wrong-agent-reply")
  ];
  const review = new MessageProcessingSendContextReview({
    getRequirement: (id) => id === currentRequirement.id ? structuredClone(currentRequirement) : undefined,
    findRequirementBySourceMessage: (_routeId, messageId) => messageId === "source-1" ? structuredClone(currentRequirement) : undefined,
    loadContext: () => structuredClone(records),
    now: () => new Date("2026-08-11T09:42:00.000Z")
  });

  assert.throws(() => review.validateSend(sendRequest()), /send-context review/i);

  const snapshot = review.snapshot("requirement-1");
  const approval = review.approve("requirement-1", {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "The latest reply chain confirms this is a Rabi LAN issue."
  });
  const approvedRequest = sendRequest();
  approvedRequest.tracking = {
    requirementId: "requirement-1",
    sendContextReviewToken: approval.sendContextReviewToken
  };
  assert.doesNotThrow(() => review.validateSend(approvedRequest));

  records.push(inbound("newer-1", "已经有人说明了，不用重复回复", 3));
  assert.throws(() => review.validateSend(approvedRequest), /context changed.*review again/i);
});

test("a prior outbound reply blocks another Agent from approving a paraphrase", () => {
  const currentRequirement = requirement("sent");
  const records = [
    inbound("source-1", "这和局域网访问有什么关系？", 1),
    outbound("sent-1", "这是 Rabi 局域网访问问题。", 2, "source-1")
  ];
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: (_routeId, messageId) => messageId === "source-1" ? structuredClone(currentRequirement) : undefined,
    loadContext: () => structuredClone(records)
  });

  const snapshot = review.snapshot("requirement-1");
  assert.equal(snapshot.alreadyReplied, true);
  assert.deepEqual(snapshot.priorReplies.map((item) => item.messageId), ["sent-1"]);
  assert.throws(() => review.approve("requirement-1", {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "primary-agent-1",
    proposedSend: {
      ...sendRequest("primary-agent-1"),
      sender: { agentType: "primary_persona", sessionId: "primary-agent-1" }
    },
    reason: "Repeat the correction with different wording."
  }), /already has a sent reply/i);
});

test("a reply to a tracked source message cannot bypass its requirement from another Agent", () => {
  const currentRequirement = requirement("sent");
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: (_routeId, messageId) => messageId === "source-1" ? structuredClone(currentRequirement) : undefined,
    loadContext: () => [inbound("source-1", "这和局域网访问有什么关系？", 1)]
  });
  const untracked = sendRequest("primary-agent-1");
  untracked.sender = { agentType: "primary_persona", sessionId: "primary-agent-1" };
  untracked.tracking = {};

  assert.throws(() => review.validateSend(untracked), /belongs to message-processing requirement requirement-1/i);
});

test("context review stays sensitive to new messages after a long conversation", () => {
  const currentRequirement = requirement();
  const records: MessageContextRecord[] = [inbound("source-1", "原始问题", 1)];
  for (let index = 0; index < 50; index += 1) {
    records.push(inbound(`followup-${index}`, `后续消息 ${index}`, index + 2));
  }
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: (_routeId, messageId) => messageId === "source-1" ? structuredClone(currentRequirement) : undefined,
    loadContext: () => structuredClone(records),
    now: () => new Date("2026-08-11T09:42:00.000Z")
  });
  const snapshot = review.snapshot("requirement-1");
  assert.equal(snapshot.contextItems.at(-1)?.messageId, "followup-49");
  const approval = review.approve("requirement-1", {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "Reviewed the latest long conversation."
  });
  const approvedRequest = sendRequest();
  approvedRequest.tracking = {
    requirementId: "requirement-1",
    sendContextReviewToken: approval.sendContextReviewToken
  };

  records.push(inbound("followup-50", "审核后新到的消息", 52));
  assert.throws(() => review.validateSend(approvedRequest), /context changed.*review again/i);
});
