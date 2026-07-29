import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverPlanApprovalFeedback,
  type PlanApprovalFeedbackPersonaRequest
} from "./planApprovalFeedbackDelivery.js";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import type { PlanItem } from "../roleKnowledge.js";

function plan(taskBinding: PlanItem["taskBinding"]): PlanItem {
  return {
    id: "plan-approval-delivery",
    title: "审批直达原业务任务",
    focus: "缩短审批后的续投路径",
    status: "进行中",
    attachments: [],
    steps: [{ id: "approve", title: "等待审批", status: "进行中" }],
    currentStepId: "approve",
    taskBinding,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    keywords: []
  };
}

const feedback: PlanFeedbackRecord = {
  id: "feedback-approval-delivery",
  roleId: "XinghaiBuilder",
  planId: "plan-approval-delivery",
  planTitle: "审批直达原业务任务",
  stepId: "approve",
  stepTitle: "等待审批",
  kind: "approval_suggestion",
  author: "user",
  source: "webgui",
  text: "批准按推荐方案实施。",
  attachments: [],
  planAttachments: [],
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  deliveryStatus: "pending"
};

const guidance: PlanFeedbackRecord = {
  ...feedback,
  id: "feedback-plan-guidance",
  stepId: undefined,
  stepTitle: undefined,
  kind: "guidance",
  text: "先确认整体入口体验，再调整后续未开始步骤。"
};

test("approval is delivered to the bound Codex task and persona only receives an auto-delivered notice", async () => {
  const taskRequests: Array<{ threadId: string; cwd: string; prompt: string }> = [];
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];
  const result = await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000001",
      sessionTitle: "原业务任务",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback,
    sendToTask: async (request) => { taskRequests.push(request); },
    sendToPersona: async (request) => { personaRequests.push(request); }
  });

  assert.equal(result.mode, "bound_task");
  assert.equal(taskRequests.length, 1);
  assert.equal(taskRequests[0]?.threadId, "019f0000-0000-7000-8000-000000000001");
  assert.equal(taskRequests[0]?.cwd, "C:\\Data\\CottonProject\\PangHu");
  assert.match(taskRequests[0]?.prompt || "", /批准按推荐方案实施/);
  assert.match(taskRequests[0]?.prompt || "", /approval_response/);
  assert.equal(personaRequests.length, 1);
  assert.equal(personaRequests[0]?.kind, "auto_delivered_notice");
  assert.match(personaRequests[0]?.text || "", /已自动投递到绑定业务会话/);
  assert.match(personaRequests[0]?.text || "", /无需再次转发/);
});

test("approval falls back to the persona when the plan has no complete task binding", async () => {
  let taskCalls = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];
  const result = await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan(undefined),
    feedback,
    sendToTask: async () => { taskCalls += 1; },
    sendToPersona: async (request) => { personaRequests.push(request); }
  });

  assert.equal(result.mode, "persona_fallback");
  assert.equal(taskCalls, 0);
  assert.equal(personaRequests.length, 1);
  assert.equal(personaRequests[0]?.kind, "full_feedback");
  assert.match(personaRequests[0]?.text || "", /请按原流程处理/);
});

test("plan guidance reaches the bound task without pretending to approve a step", async () => {
  const taskRequests: Array<{ threadId: string; cwd: string; prompt: string }> = [];
  await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000006",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback: guidance,
    sendToTask: async (request) => { taskRequests.push(request); },
    sendToPersona: async () => undefined
  });

  assert.equal(taskRequests.length, 1);
  assert.match(taskRequests[0]?.prompt || "", /引导属于整个计划，不绑定某个步骤/);
  assert.match(taskRequests[0]?.prompt || "", /同步调整尚未开始的步骤/);
  assert.match(taskRequests[0]?.prompt || "", /kind=guidance_response/);
  assert.match(taskRequests[0]?.prompt || "", /不要携带 stepId/);
  assert.doesNotMatch(taskRequests[0]?.prompt || "", /批准按推荐方案/);
});

test("approval keeps retrying the bound Codex task and never asks the persona to relay it", async () => {
  let taskCalls = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];
  const result = await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000002",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback,
    sendToTask: async () => {
      taskCalls += 1;
      if (taskCalls < 3) throw new Error("Codex Desktop owner no-client-found");
    },
    sendToPersona: async (request) => { personaRequests.push(request); },
    directRetryAttempts: 3,
    directRetryDelayMs: 1
  });

  assert.equal(result.mode, "bound_task");
  assert.equal(taskCalls, 3);
  assert.deepEqual(personaRequests.map((request) => request.kind), [
    "auto_delivery_pending_notice",
    "auto_delivered_notice"
  ]);
  assert.doesNotMatch(personaRequests.map((request) => request.text).join("\n"), /请按原流程处理|续投对应业务任务/);
});

test("a persistent bound-task owner failure is recorded as failed instead of delivered to the persona", async () => {
  let taskCalls = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];

  await assert.rejects(deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000004",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback,
    sendToTask: async () => {
      taskCalls += 1;
      throw new Error("Codex Desktop owner no-client-found");
    },
    sendToPersona: async (request) => { personaRequests.push(request); },
    directRetryAttempts: 2,
    directRetryDelayMs: 1
  }), /no-client-found/);

  assert.equal(taskCalls, 2);
  assert.deepEqual(personaRequests.map((request) => request.kind), [
    "auto_delivery_pending_notice",
    "auto_delivery_failed_notice"
  ]);
  assert.ok(personaRequests.every((request) => request.kind !== "full_feedback"));
  assert.match(personaRequests[0]?.text || "", /自动重试|无需代为转发/);
  assert.match(personaRequests[1]?.text || "", /仍未成功|未标记为已投递/);
});

test("an ambiguous IPC timeout is not replayed because the owner may already have accepted the feedback", async () => {
  let taskCalls = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];

  await assert.rejects(deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000005",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback,
    sendToTask: async () => {
      taskCalls += 1;
      throw new Error("Codex Desktop IPC request timed out: thread-follower-start-turn");
    },
    sendToPersona: async (request) => { personaRequests.push(request); },
    directRetryAttempts: 3,
    directRetryDelayMs: 1
  }), /request timed out/);

  assert.equal(taskCalls, 1);
  assert.deepEqual(personaRequests.map((request) => request.kind), ["auto_delivery_failed_notice"]);
  assert.ok(personaRequests.every((request) => request.kind !== "full_feedback"));
});

test("a persona notice failure does not resend approval to the already-started business task", async () => {
  let taskCalls = 0;
  const result = await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000003",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback,
    sendToTask: async () => { taskCalls += 1; },
    sendToPersona: async () => { throw new Error("persona route offline"); }
  });

  assert.equal(result.mode, "bound_task");
  assert.equal(taskCalls, 1);
  assert.match(result.message || "", /persona route offline/);
});
