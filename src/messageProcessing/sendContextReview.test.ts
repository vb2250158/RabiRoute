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

function aggregateRequirement(): MessageProcessingRequirement {
  return {
    ...requirement(),
    source: {
      ...requirement().source,
      messageIds: ["source-1", "unrelated-image"],
      evidenceReviewRequired: true,
      replyChainMessageIds: ["source-parent"],
      attachments: [{
        id: "unrelated-image:image:1",
        messageId: "unrelated-image",
        kind: "image",
        name: "expired.png",
        status: "unavailable",
        error: "HTTP 403"
      }]
    },
    sourceEvidenceReview: {
      reviewedMessageIds: ["source-1", "source-parent"],
      replyChainChecked: true,
      attachmentReviews: [],
      evidence: "核对了本次引用消息及其明确回复链。",
      reviewedAt: "2026-08-11T09:41:00.000Z",
      reviewedByThreadId: "message-agent-1"
    },
    projectFactAssessment: {
      status: "none",
      reviewedMessageIds: ["source-1", "source-parent"],
      replyChainChecked: true,
      evidence: "本次正文只基于已核对的文本消息和回复链。",
      assessedAt: "2026-08-11T09:41:00.000Z",
      assessedByThreadId: "message-agent-1"
    }
  };
}

test("message-processing send is rejected until the exact latest context and payload are reviewed", () => {
  let currentRequirement = requirement();
  currentRequirement.source.replyChainMessageIds = ["wrong-agent-reply"];
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
  const validated = review.validateSend(approvedRequest);
  assert.equal(validated?.requirement.id, "requirement-1");
  assert.equal(validated?.sourceMessageId, "source-1");

  records.push(inbound("newer-1", "已经有人说明了，不用重复回复", 3));
  assert.throws(() => review.validateSend(approvedRequest), /context changed.*review again/i);
});

test("approval reviews only the proposed reply source, its explicit chain, and their attachments", () => {
  const currentRequirement = aggregateRequirement();
  const records = [
    inbound("source-parent", "前一条明确问题", 1),
    inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent"),
    inbound("unrelated-image", "[CQ:image,file=expired.png]", 3),
    inbound("unrelated-followup", "另一段讨论", 4)
  ];
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: (_routeId, messageId) => currentRequirement.source.messageIds.includes(messageId)
      ? structuredClone(currentRequirement)
      : undefined,
    loadContext: () => structuredClone(records)
  });
  const snapshot = review.snapshot(currentRequirement.id);

  assert.doesNotThrow(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: ["source-parent", "source-1"],
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "正文只回答 source-1，并核对了 source-parent。"
  }));
});

test("approval fails closed when the quoted source attachment is unavailable", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.source.attachments = [{
    id: "source-1:image:1",
    messageId: "source-1",
    kind: "image",
    name: "expired.png",
    status: "unavailable",
    error: "HTTP 403"
  }];
  currentRequirement.sourceEvidenceReview!.attachmentReviews = [{
    attachmentId: "source-1:image:1",
    status: "unavailable",
    observation: "图片不可读。"
  }];
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "[CQ:image,file=expired.png]", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id);

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: ["source-parent", "source-1"],
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "尝试根据不可读图片作答。"
  }), /attachment.*unavailable|unavailable.*attachment/i);
});

test("approval fails closed when the explicit reply chain was not verified", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.sourceEvidenceReview!.reviewedMessageIds = ["source-1"];
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id);

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: ["source-parent", "source-1"],
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "回复链证据不完整。"
  }), /sourceEvidenceReview.*source-parent/i);
});

test("approval fails closed when the proposed body relies on messages outside the verified fact assessment", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.projectFactAssessment!.reviewedMessageIds = ["source-1"];
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id);

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: ["source-parent", "source-1"],
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "正文使用了未纳入项目事实核验的回复链。"
  }), /projectFactAssessment.*source-parent/i);
});

test("approval fails closed when the quoted source belongs to conflicting requirements", () => {
  const currentRequirement = aggregateRequirement();
  const conflictingRequirement = { ...aggregateRequirement(), id: "requirement-conflict" };
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(currentRequirement),
      structuredClone(conflictingRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id);

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: ["source-parent", "source-1"],
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "来源归属冲突。"
  }), /conflicting message-processing requirements/i);
});

test("historical requirements for the same Route, message group, and source resolve to the newest canonical requirement", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.id = "requirement-current";
  currentRequirement.createdAt = "2026-08-14T12:48:10.226Z";
  currentRequirement.source.replyContext = {
    ...currentRequirement.source.replyContext,
    messageGroupId: "message-group-b4f8"
  };
  const historicalRequirement = aggregateRequirement();
  historicalRequirement.id = "requirement-historical";
  historicalRequirement.messageGroupId = "message-group-b4f8";
  historicalRequirement.createdAt = "2026-08-14T12:19:22.849Z";
  const review = new MessageProcessingSendContextReview({
    getRequirement: (id) => id === currentRequirement.id ? structuredClone(currentRequirement) : undefined,
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(historicalRequirement),
      structuredClone(currentRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: currentRequirement.id };
  const snapshot = review.snapshot(currentRequirement.id, "source-1");

  assert.doesNotThrow(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "同一消息组的历史重复只归属最新 requirement。"
  }));
});

test("a newer plan progress notification cannot take reply ownership from a message reply requirement", () => {
  const replyRequirement = aggregateRequirement();
  replyRequirement.id = "requirement-message-reply";
  replyRequirement.messageGroupId = "message-group-b4f8";
  replyRequirement.createdAt = "2026-08-14T12:19:22.849Z";
  const planNotification = aggregateRequirement();
  planNotification.id = "requirement-plan-progress";
  planNotification.kind = "plan_progress_notification";
  planNotification.messageGroupId = "message-group-b4f8";
  planNotification.createdAt = "2026-08-14T12:48:10.226Z";
  planNotification.plan = {
    planId: "plan-1784791481558",
    planTitle: "无关计划进度",
    afterUpdatedAt: "2026-08-14T12:48:10.226Z",
    changes: ["status"]
  };
  const review = new MessageProcessingSendContextReview({
    getRequirement: (id) => id === replyRequirement.id ? structuredClone(replyRequirement) : undefined,
    findRequirementBySourceMessage: () => structuredClone(planNotification),
    findRequirementsBySourceMessage: () => [
      structuredClone(planNotification),
      structuredClone(replyRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "昼夜问题应该怎样处理？", 2, "source-parent")
    ]
  });
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: replyRequirement.id };
  const snapshot = review.snapshot(replyRequirement.id, "source-1");

  assert.doesNotThrow(() => review.approve(replyRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "群引用回复仍归属于原始 message_reply requirement。"
  }));
});

test("a plan progress notification alone cannot own a quoted group source message", () => {
  const planNotification = aggregateRequirement();
  planNotification.id = "requirement-plan-progress";
  planNotification.kind = "plan_progress_notification";
  planNotification.messageGroupId = "message-group-b4f8";
  planNotification.createdAt = "2026-08-14T12:48:10.226Z";
  planNotification.plan = {
    planId: "plan-1784791481558",
    planTitle: "无关计划进度",
    afterUpdatedAt: "2026-08-14T12:48:10.226Z",
    changes: ["status"]
  };
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(planNotification),
    findRequirementBySourceMessage: () => structuredClone(planNotification),
    findRequirementsBySourceMessage: () => [structuredClone(planNotification)],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "昼夜问题应该怎样处理？", 2, "source-parent")
    ]
  });
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: planNotification.id };
  const snapshot = review.snapshot(planNotification.id, "source-1");

  assert.throws(() => review.approve(planNotification.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "计划通知不得承接原群消息的引用回复。"
  }), /conflicting message-processing requirements or none.*none/i);
});

test("historical duplicates with an invalid creation time remain a source ownership conflict", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.id = "requirement-current";
  currentRequirement.messageGroupId = "message-group-b4f8";
  currentRequirement.createdAt = "2026-08-14T12:48:10.226Z";
  const historicalRequirement = aggregateRequirement();
  historicalRequirement.id = "requirement-historical";
  historicalRequirement.messageGroupId = "message-group-b4f8";
  historicalRequirement.createdAt = "invalid-created-at";
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(currentRequirement),
      structuredClone(historicalRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id, "source-1");
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: currentRequirement.id };

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "创建时间无效，无法唯一确定最新 requirement。"
  }), /conflicting message-processing requirements/i);
});

test("an older duplicate cannot approve a source owned by the newer canonical requirement", () => {
  const historicalRequirement = aggregateRequirement();
  historicalRequirement.id = "requirement-historical";
  historicalRequirement.messageGroupId = "message-group-b4f8";
  historicalRequirement.createdAt = "2026-08-14T12:19:22.849Z";
  const canonicalRequirement = aggregateRequirement();
  canonicalRequirement.id = "requirement-current";
  canonicalRequirement.source.replyContext = {
    ...canonicalRequirement.source.replyContext,
    messageGroupId: "message-group-b4f8"
  };
  canonicalRequirement.createdAt = "2026-08-14T12:48:10.226Z";
  const review = new MessageProcessingSendContextReview({
    getRequirement: (id) => id === historicalRequirement.id ? structuredClone(historicalRequirement) : undefined,
    findRequirementBySourceMessage: () => structuredClone(canonicalRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(historicalRequirement),
      structuredClone(canonicalRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: historicalRequirement.id };
  const snapshot = review.snapshot(historicalRequirement.id, "source-1");

  assert.throws(() => review.approve(historicalRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "旧 requirement 不得占用新 canonical 来源。"
  }), /belongs to message-processing requirement requirement-current, not requirement-historical/i);
});

test("requirements from different message groups remain a source ownership conflict", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.messageGroupId = "message-group-current";
  const independentRequirement = aggregateRequirement();
  independentRequirement.id = "requirement-independent";
  independentRequirement.messageGroupId = "message-group-independent";
  independentRequirement.createdAt = "2026-08-14T12:49:10.226Z";
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(currentRequirement),
      structuredClone(independentRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id, "source-1");

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "不同消息组不能合并为一个来源。"
  }), /conflicting message-processing requirements/i);
});

test("requirements from different Routes remain a source ownership conflict", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.messageGroupId = "message-group-b4f8";
  const otherRouteRequirement = aggregateRequirement();
  otherRouteRequirement.id = "requirement-other-route";
  otherRouteRequirement.messageGroupId = "message-group-b4f8";
  otherRouteRequirement.source.routeId = "route-secondary";
  otherRouteRequirement.source.routeProfileId = "route-secondary";
  otherRouteRequirement.createdAt = "2026-08-14T12:49:10.226Z";
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => [
      structuredClone(currentRequirement),
      structuredClone(otherRouteRequirement)
    ],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id, "source-1");

  assert.throws(() => review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "不同 Route 不能合并为一个来源。"
  }), /conflicting message-processing requirements/i);
});

test("a source ownership conflict appearing after approval blocks the send before Outbox", () => {
  const currentRequirement = aggregateRequirement();
  const conflictingRequirement = { ...aggregateRequirement(), id: "requirement-conflict" };
  let conflict = false;
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => conflict
      ? [structuredClone(currentRequirement), structuredClone(conflictingRequirement)]
      : [structuredClone(currentRequirement)],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const snapshot = review.snapshot(currentRequirement.id, "source-1");
  const approval = review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend: sendRequest(),
    reason: "来源归属在审批时唯一。"
  });
  const approvedRequest = sendRequest();
  approvedRequest.tracking = {
    requirementId: currentRequirement.id,
    sendContextReviewToken: approval.sendContextReviewToken
  };
  conflict = true;

  assert.throws(() => review.validateSend(approvedRequest), /conflicting message-processing requirements/i);
});

test("a newer canonical requirement appearing after approval invalidates the older review token", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.id = "requirement-current";
  currentRequirement.messageGroupId = "message-group-b4f8";
  currentRequirement.createdAt = "2026-08-14T12:48:10.226Z";
  const newerRequirement = aggregateRequirement();
  newerRequirement.id = "requirement-newer";
  newerRequirement.source.replyContext = {
    ...newerRequirement.source.replyContext,
    messageGroupId: "message-group-b4f8"
  };
  newerRequirement.createdAt = "2026-08-14T12:49:10.226Z";
  let newerExists = false;
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    findRequirementsBySourceMessage: () => newerExists
      ? [structuredClone(currentRequirement), structuredClone(newerRequirement)]
      : [structuredClone(currentRequirement)],
    loadContext: () => [
      inbound("source-parent", "前一条明确问题", 1),
      inbound("source-1", "这和局域网访问有什么关系？", 2, "source-parent")
    ]
  });
  const proposedSend = sendRequest();
  proposedSend.tracking = { requirementId: currentRequirement.id };
  const snapshot = review.snapshot(currentRequirement.id, "source-1");
  const approval = review.approve(currentRequirement.id, {
    contextVersion: snapshot.contextVersion,
    reviewedContextIds: snapshot.requiredReviewIds,
    reviewedByThreadId: "message-agent-1",
    proposedSend,
    reason: "审批时当前 requirement 是最新 canonical。"
  });
  proposedSend.tracking = {
    requirementId: currentRequirement.id,
    sendContextReviewToken: approval.sendContextReviewToken
  };
  newerExists = true;

  assert.throws(() => review.validateSend(proposedSend), /belongs to message-processing requirement requirement-newer/i);
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

test("a scoped snapshot keeps a selected source reviewable inside an aggregate with dozens of messages", () => {
  const currentRequirement = aggregateRequirement();
  currentRequirement.source.messageIds = Array.from({ length: 60 }, (_, index) => `aggregate-${index}`);
  currentRequirement.source.messageIds[30] = "source-1";
  currentRequirement.source.replyChainMessageIds = ["source-parent"];
  const records = currentRequirement.source.messageIds.map((messageId, index) =>
    inbound(messageId, `聚合消息 ${index}`, index + 2, messageId === "source-1" ? "source-parent" : undefined));
  records.unshift(inbound("source-parent", "明确回复链起点", 1));
  const review = new MessageProcessingSendContextReview({
    getRequirement: () => structuredClone(currentRequirement),
    findRequirementBySourceMessage: () => structuredClone(currentRequirement),
    loadContext: () => structuredClone(records)
  });

  const snapshot = review.snapshot(currentRequirement.id, "source-1");

  assert.equal(snapshot.sourceMessageId, "source-1");
  assert.deepEqual(snapshot.requiredReviewIds, ["source-1", "source-parent"]);
  assert.ok(snapshot.contextItems.some((item) => item.messageId === "source-1"));
});
