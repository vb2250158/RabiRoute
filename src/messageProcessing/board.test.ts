import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageProcessingBoardStore } from "./board.js";
import type { PlanItem } from "../roleKnowledge.js";

function source(routeKinds: string[]) {
  return {
    routeId: "main",
    routeProfileId: "main",
    roleId: "DemoPersona",
    endpoint: "napcat",
    conversationKey: "group:100",
    sender: "user:200",
    routeKinds,
    messageIds: ["300"],
    summary: "@示例助手 这个界面怎么命名",
    replyContext: { targetType: "group", groupId: "100", messageId: "300" }
  };
}

function noneAssessment(messageIds = ["300"]) {
  return {
    status: "none" as const,
    reviewedMessageIds: messageIds,
    replyChainChecked: true,
    evidence: "Agent read the source messages and reply chain; no durable project fact was found.",
    assessedAt: "2026-08-05T06:00:00.000Z",
    assessedByThreadId: "message-agent-1"
  };
}

function scheduleAssessment(messageIds = ["300"]) {
  return {
    status: "critical" as const,
    reviewedMessageIds: messageIds,
    replyChainChecked: true,
    evidence: "Agent verified the original wording and classified it as an internal schedule target, not a public launch date.",
    assessedAt: "2026-08-05T06:00:00.000Z",
    assessedByThreadId: "message-agent-1",
    facts: [{ kind: "schedule" as const, evidence: "示例项目暂以2030年10月15日为内部上线目标" }]
  };
}

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    title: "实现选择界面",
    focus: "实现选择界面",
    status: "进行中",
    currentStep: "实现",
    currentStepId: "implement",
    nextAction: "完成 Prefab",
    attachments: [],
    steps: [{ id: "implement", title: "实现", status: "进行中" }],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    keywords: ["选择界面"],
    ...overrides
  };
}

test("explicit message requirements cannot be closed with a generic no-reply judgment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-1", messageGroupId: "group-1", source: source(["direct_at"]) });
  assert.throws(() => store.submitOutcome("req-1", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(),
    reasonCode: "agent_judgement",
    reason: "No plan work is needed."
  }), /requires a visible reply/i);
  const closed = store.submitOutcome("req-1", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(),
    reasonCode: "answered_by_other",
    reason: "Another member already supplied the complete answer."
  });
  assert.equal(closed.status, "not_required");
});

test("a required old message can close only with an explicit superseding follow-up reference", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-followup-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-followup", messageGroupId: "group-followup", source: source(["direct_reply"]) });
  const closed = store.submitOutcome("req-followup", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(),
    reasonCode: "superseded_by_followup",
    reason: "后续同题消息 messageId=400 已补全范围，旧消息不再单独回复。"
  });
  assert.equal(closed.status, "not_required");
});

test("superseded_by_followup rejects vague closure without a message id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-vague-followup-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-vague-followup", messageGroupId: "group-vague-followup", source: source(["direct_reply"]) });
  assert.throws(() => store.submitOutcome("req-vague-followup", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(),
    reasonCode: "superseded_by_followup",
    reason: "后面已经处理了。"
  }), /requires a concrete follow-up messageId/);
});

test("an attachment-only reply can close after its source id is consumed into a plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-attachment-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({
    requirementId: "req-attachment",
    messageGroupId: "group-attachment",
    source: { ...source(["direct_reply"]), messageIds: ["msg-attachment-1"], summary: "[CQ:image,file=example.png]" }
  });
  const closed = store.submitOutcome("req-attachment", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(["msg-attachment-1"]),
    reasonCode: "attachment_consumed",
    reason: "sourceMessageId=msg-attachment-1 已下载核对并登记到计划。",
    planId: "plan-1",
    planTitle: "1.1内容清单"
  });
  assert.equal(closed.status, "not_required");
});

test("ordinary group discussion remains an Agent decision and records missing outcomes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-decision-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  const item = store.registerMessageGroup({ requirementId: "req-2", messageGroupId: "group-2", source: source(["group_message"]) });
  assert.equal(item.replyPolicy, "agent_decides");
  store.recordDispatch("req-2", { threadId: "thread-1", threadName: "消息处理1", workspace: root });
  const board = store.board({}, new Map([["thread-1", {
    threadName: "Codex 左侧任务名",
    workspace: root,
    status: "idle" as const,
    observedAt: "2026-08-05T00:00:00.000Z"
  }]])) as {
    counts: { missingOutcome: number };
    items: Array<{ missingOutcome: boolean; worker?: { threadName: string; runtimeStatus?: string } }>;
  };
  assert.equal(board.counts.missingOutcome, 1);
  assert.equal(board.items[0]?.missingOutcome, true);
  assert.equal(board.items[0]?.worker?.threadName, "Codex 左侧任务名");
  assert.equal(board.items[0]?.worker?.runtimeStatus, "idle");
  const persisted = store.snapshot().requirements[0]?.worker;
  assert.equal(persisted?.active, undefined);
  assert.equal(persisted?.runtimeStatus, undefined);
  assert.equal(persisted?.observedAt, undefined);
});

test("the same platform message ids reuse one canonical requirement across repeated ingress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-source-dedupe-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  const first = store.registerMessageGroup({
    requirementId: "req-source-1",
    messageGroupId: "group-source-1",
    source: source(["direct_reply"])
  });
  store.recordDispatch(first.id, {
    threadId: "thread-1",
    threadName: "消息处理1",
    workspace: "C:\\workspace"
  });
  const repeated = store.registerMessageGroup({
    requirementId: "req-source-2",
    messageGroupId: "group-source-2",
    source: { ...source(["direct_reply"]), summary: "同一条消息被网关再次投递" }
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "processing");
  assert.equal(store.list().length, 1);
});

test("RabiManager does not infer project facts from message text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-no-semantic-inference-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  const item = store.registerMessageGroup({
    requirementId: "req-no-inference",
    messageGroupId: "group-no-inference",
    source: { ...source(["group_message"]), summary: "批准示例方案，2030年10月15日上线，交给示例负责人" }
  });
  assert.equal(item.criticalFacts, undefined);
  assert.equal(item.projectFactAssessment, undefined);
  assert.equal(item.factAssessmentRequired, true);
});

test("every recalled plan or memory requires an explicit Agent disposition", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-recall-disposition-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({
    requirementId: "req-recall",
    messageGroupId: "group-recall",
    source: source(["group_message"]),
    knowledgeMatches: [
      { id: "plan-ui", title: "界面计划", type: "plan", endpoint: "/api/roles/X/plans/plan-ui", score: 25, revisionAt: "2026-08-05T05:00:00.000Z" },
      { id: "memory-ui", title: "界面约定", type: "recent_memory", endpoint: "/api/roles/X/memory/recent/memory-ui", score: 20, revisionAt: "2026-08-05T04:00:00.000Z" }
    ]
  });
  assert.throws(() => store.submitOutcome("req-recall", {
    decision: "reply",
    projectFactAssessment: noneAssessment(),
    knowledgeMatchDispositions: [{
      knowledgeId: "plan-ui",
      knowledgeType: "plan",
      relevance: "relevant",
      evidence: "The message reports new UI feedback for this plan.",
      actions: [{ type: "reply", evidence: "Acknowledge the feedback in the group." }]
    }]
  }), /memory-ui/);
  assert.throws(() => store.submitOutcome("req-recall", {
    decision: "no_reply",
    projectFactAssessment: noneAssessment(),
    knowledgeMatchDispositions: [
      {
        knowledgeId: "plan-ui",
        knowledgeType: "plan",
        relevance: "relevant",
        evidence: "The message reports new UI feedback for this plan.",
        actions: [{ type: "no_action", evidence: "Ignore it." }]
      },
      {
        knowledgeId: "memory-ui",
        knowledgeType: "recent_memory",
        relevance: "not_relevant",
        evidence: "Only the generic word UI matched; the memory concerns another window.",
        actions: [{ type: "no_action", evidence: "False-positive keyword match." }]
      }
    ]
  }), /relevant recall requires/);
  const accepted = store.submitOutcome("req-recall", {
    decision: "reply",
    projectFactAssessment: noneAssessment(),
    knowledgeMatchDispositions: [
      {
        knowledgeId: "plan-ui",
        knowledgeType: "plan",
        relevance: "relevant",
        evidence: "The message reports new UI feedback for this plan.",
        actions: [{ type: "reply", evidence: "Acknowledge and discuss the feedback in the group." }]
      },
      {
        knowledgeId: "memory-ui",
        knowledgeType: "recent_memory",
        relevance: "not_relevant",
        evidence: "Only the generic word UI matched; the memory concerns another window.",
        actions: [{ type: "no_action", evidence: "False-positive keyword match." }]
      }
    ]
  });
  assert.equal(accepted.status, "awaiting_send");
  assert.equal(accepted.knowledgeMatchDispositions?.length, 2);
});

test("standalone knowledge callbacks accept explicit unchanged and keep deferred items open", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-knowledge-callback-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"), () => new Date("2026-08-05T06:00:00.000Z"));
  const item = store.registerMessageGroup({
    requirementId: "req-callback",
    messageGroupId: "group-callback",
    source: source(["group_message"]),
    knowledgeMatches: [
      { id: "plan-ui", title: "界面计划", type: "plan", endpoint: "/plans/plan-ui", score: 25, revisionAt: "2026-08-05T05:00:00.000Z" },
      { id: "memory-ui", title: "界面记忆", type: "recent_memory", endpoint: "/memory/memory-ui", score: 20, revisionAt: "2026-08-05T05:00:00.000Z" }
    ]
  });
  assert.equal(item.knowledgeCallbackDueAt, "2026-08-05T07:00:00.000Z");
  store.recordKnowledgeCallback("req-callback", {
    knowledgeId: "plan-ui",
    knowledgeType: "plan",
    result: "unchanged",
    responseAction: "reply",
    evidence: "Read the plan; this message asks only for a status confirmation and changes no scope.",
    callbackByThreadId: "message-agent-1"
  });
  store.recordKnowledgeCallback("req-callback", {
    knowledgeId: "memory-ui",
    knowledgeType: "recent_memory",
    result: "deferred",
    responseAction: "handoff",
    evidence: "The secretary is checking whether the new wording should extend the memory.",
    callbackByThreadId: "message-agent-1"
  });
  assert.deepEqual(store.pendingKnowledgeMatches("req-callback").map((match) => match.id), ["memory-ui"]);
  const board = store.board() as { counts: { knowledgeCallbackOpen: number } };
  assert.equal(board.counts.knowledgeCallbackOpen, 1);
  assert.throws(() => store.submitOutcome("req-callback", {
    decision: "reply",
    projectFactAssessment: noneAssessment()
  }), /memory-ui/);
  store.recordKnowledgeCallback("req-callback", {
    knowledgeId: "memory-ui",
    knowledgeType: "recent_memory",
    result: "not_relevant",
    responseAction: "none",
    evidence: "The memory concerns another window; only a generic keyword matched.",
    callbackByThreadId: "message-agent-1"
  });
  const accepted = store.submitOutcome("req-callback", {
    decision: "reply",
    projectFactAssessment: noneAssessment()
  });
  assert.equal(accepted.status, "awaiting_send");
  assert.equal((store.board() as { counts: { knowledgeCallbackOpen: number } }).counts.knowledgeCallbackOpen, 0);
});

test("critical project facts cannot close or reply before a verified record exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-critical-fact-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  const item = store.registerMessageGroup({
    requirementId: "req-critical",
    messageGroupId: "group-critical",
    source: {
      ...source(["group_message"]),
      summary: "示例项目暂以2030年10月15日为内部上线目标"
    }
  });
  assert.equal(item.criticalFacts, undefined);
  assert.throws(() => store.submitOutcome("req-critical", {
    decision: "no_reply",
    reason: "无需在群里回复。"
  }), /projectFactAssessment/i);
  assert.throws(() => store.submitOutcome("req-critical", {
    decision: "reply",
    projectFactAssessment: scheduleAssessment(),
    reason: "直接回答日期。"
  }), /critical project fact/i);

  const handedOff = store.submitOutcome("req-critical", {
    decision: "handoff",
    targetAgentType: "plan_secretary",
    reason: "交原计划秘书核对并记录。"
  });
  assert.equal(handedOff.status, "handed_off");

  const closed = store.submitOutcome("req-critical", {
    decision: "no_reply",
    projectFactAssessment: scheduleAssessment(),
    reason: "群内无需重复发言，但事实已写入统一包计划。",
    criticalFactDisposition: {
      status: "recorded",
      record: { type: "plan", planId: "plan-example-release" },
      evidence: "messageId=msg-schedule-1，已核对原文与回复链并写入计划。",
      verifiedAt: "2026-08-05T06:00:00.000Z"
    }
  });
  assert.equal(closed.status, "not_required");
  assert.deepEqual(closed.criticalFactDisposition?.record, { type: "plan", planId: "plan-example-release" });
});

test("a formal Agent reply returns a handed-off requirement to its publishing worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-handoff-return-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-return", messageGroupId: "group-return", source: source(["group_message"]) });
  store.recordDispatch("req-return", {
    threadId: "message-worker",
    threadName: "消息处理任务",
    workspace: root
  });
  const handedOff = store.submitOutcome("req-return", {
    decision: "handoff",
    targetAgentType: "plan_agent",
    targetThreadId: "plan-worker",
    reason: "请原计划任务调查后返回结果。"
  });
  assert.equal(handedOff.status, "handed_off");
  assert.throws(() => store.recordHandoffReturned("req-return", "another-worker"), /recorded target task/);
  const returned = store.recordHandoffReturned("req-return", "plan-worker");
  assert.equal(returned.status, "processing");
  assert.ok(returned.handoff?.returnedAt);
  assert.equal(returned.worker?.threadId, "message-worker");
});

test("a sent critical message remains open until the project fact record is verified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-critical-send-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({
    requirementId: "req-critical-send",
    messageGroupId: "group-critical-send",
    source: { ...source(["direct_reply"]), summary: "示例项目公测目标暂按2030年10月15日" }
  });
  store.submitOutcome("req-critical-send", {
    decision: "handoff",
    targetAgentType: "primary_persona",
    reason: "先由主人格确认当前口径。"
  });
  store.recordReply("req-critical-send", { ok: true, status: "sent", sentMessageId: "qq-critical" }, "delivery-critical");
  assert.equal(store.get("req-critical-send")?.status, "fact_assessment_pending");
  const board = store.board() as { counts: { factAssessmentOpen: number } };
  assert.equal(board.counts.factAssessmentOpen, 1);

  const completed = store.submitOutcome("req-critical-send", {
    decision: "reply",
    projectFactAssessment: scheduleAssessment(),
    criticalFactDisposition: {
      status: "recorded",
      record: { type: "plan", planId: "plan-release" },
      evidence: "已核对messageId=300并写入发布计划。",
      verifiedAt: "2026-08-05T06:00:00.000Z"
    }
  });
  assert.equal(completed.status, "sent");
  assert.equal((store.board() as { counts: { criticalFactOpen: number } }).counts.criticalFactOpen, 0);
});

test("a later Agent audit can replace a sent none assessment with a verified critical fact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-fact-audit-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-audit", messageGroupId: "group-audit", source: source(["group_message"]) });
  store.submitOutcome("req-audit", { decision: "reply", projectFactAssessment: noneAssessment() });
  store.recordReply("req-audit", { ok: true, status: "sent", sentMessageId: "qq-audit" });
  const corrected = store.submitOutcome("req-audit", {
    decision: "no_reply",
    projectFactAssessment: scheduleAssessment(),
    criticalFactDisposition: {
      status: "recorded",
      record: { type: "memory", memoryId: "memory-launch-target" },
      evidence: "messageId=300 was rechecked by the heartbeat Agent and recorded.",
      verifiedAt: "2026-08-05T07:00:00.000Z"
    }
  });
  assert.equal(corrected.status, "sent");
  assert.equal(corrected.projectFactAssessment?.status, "critical");
  assert.deepEqual(corrected.criticalFactDisposition?.record, { type: "memory", memoryId: "memory-launch-target" });
});

test("Outbox sent receipt is the terminal proof for a reply requirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-reply-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-3", messageGroupId: "group-3", source: source(["direct_reply"]) });
  store.submitOutcome("req-3", { decision: "reply", projectFactAssessment: noneAssessment(), reason: "Answer the direct question." });
  assert.equal(store.get("req-3")?.status, "awaiting_send");
  store.recordReply("req-3", { ok: true, status: "sent", sentMessageId: "qq-500" }, "delivery-1");
  const item = store.get("req-3");
  assert.equal(item?.status, "sent");
  assert.equal(item?.delivery?.sentMessageId, "qq-500");
});

test("a speech send cannot close a NapCat reply requirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-channel-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-channel-mismatch", messageGroupId: "group-channel-mismatch", source: source(["direct_reply"]) });
  store.submitOutcome("req-channel-mismatch", { decision: "reply", projectFactAssessment: noneAssessment(), reason: "Answer in QQ." });
  store.recordSend("req-channel-mismatch", {
    ok: true,
    status: "sent",
    channel: "speech",
    routeId: "main",
    target: { sessionId: "speech-1" },
    sentMessageId: "tts-job-1"
  }, "delivery-speech-1");
  const item = store.get("req-channel-mismatch");
  assert.equal(item?.status, "awaiting_send");
  assert.equal(item?.delivery?.channel, "speech");
  assert.match(item?.lastError || "", /expects napcat/);
});

test("linked plans generate required notifications only for communication-relevant changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-plan-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  store.registerMessageGroup({ requirementId: "req-4", messageGroupId: "group-4", source: source(["direct_at"]) });
  store.recordDispatch("req-4", { threadId: "thread-4", threadName: "消息处理4", workspace: root });
  store.submitOutcome("req-4", {
    decision: "handoff",
    targetAgentType: "plan_agent",
    roleId: "DemoPersona",
    planId: "plan-1",
    planTitle: "实现选择界面"
  });
  const before = plan();
  const unchangedCommunication = plan({ updatedAt: "2026-08-05T00:01:00.000Z", priority: "high" });
  assert.equal(store.registerPlanChange("DemoPersona", before, unchangedCommunication), undefined);
  const progressed = plan({
    status: "已完成",
    currentStep: "完成",
    currentStepId: "done",
    nextAction: "通知需求群",
    steps: [{ id: "implement", title: "实现", status: "已完成", completedAt: "2026-08-05T00:02:00.000Z" }],
    updatedAt: "2026-08-05T00:02:00.000Z"
  });
  const notification = store.registerPlanChange("DemoPersona", before, progressed);
  assert.equal(notification?.kind, "plan_progress_notification");
  assert.equal(notification?.replyPolicy, "required");
  assert.equal(notification?.worker?.threadId, "thread-4");
  assert.match(notification?.plan?.changes.join("\n") || "", /状态/);
});

test("one plan keeps separate notification origins for multiple conversations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-message-board-multi-origin-"));
  const store = new MessageProcessingBoardStore(path.join(root, "board.json"));
  const firstSource = source(["direct_at"]);
  const secondSource = {
    ...source(["private"]),
    conversationKey: "private:201",
    sender: "user:201",
    messageIds: ["301"],
    replyContext: { targetType: "private", userId: "201", messageId: "301" }
  };
  for (const [requirementId, messageGroupId, inputSource, threadId] of [
    ["req-origin-1", "group-origin-1", firstSource, "thread-origin-1"],
    ["req-origin-2", "group-origin-2", secondSource, "thread-origin-2"]
  ] as const) {
    store.registerMessageGroup({ requirementId, messageGroupId, source: inputSource });
    store.recordDispatch(requirementId, { threadId, threadName: threadId, workspace: root });
    store.submitOutcome(requirementId, {
      decision: "handoff",
      targetAgentType: "plan_agent",
      roleId: "DemoPersona",
      planId: "plan-1",
      planTitle: "实现选择界面"
    });
  }
  const before = plan();
  store.setPlanBaseline("DemoPersona", before);
  const progressed = plan({
    nextAction: "通知两个来源会话",
    updatedAt: "2026-08-05T00:03:00.000Z"
  });
  const notifications = store.planOriginList()
    .map((origin) => store.reconcilePlan(origin.key, progressed))
    .filter((item) => item != null);
  assert.equal(notifications.length, 2);
  assert.deepEqual(new Set(notifications.map((item) => item?.source.conversationKey)), new Set(["group:100", "private:201"]));
  assert.deepEqual(new Set(notifications.map((item) => item?.worker?.threadId)), new Set(["thread-origin-1", "thread-origin-2"]));
});
