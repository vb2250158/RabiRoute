import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverPlanApprovalFeedback,
  PlanFeedbackDeliveryPendingError,
  type PlanApprovalFeedbackPersonaRequest,
  type PlanApprovalFeedbackSecretaryTarget
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

const secretary: PlanApprovalFeedbackSecretaryTarget = {
  threadId: "019f0000-0000-7000-8000-000000000091",
  threadName: "主人格 协助处理计划1",
  workspace: "C:\\Data\\CottonProject\\RabiRoute",
  model: "gpt-5.6-terra"
};

test("enabled plan secretary receives the control notice while the bound task receives the full approval", async () => {
  const taskRequests: Array<{ threadId: string; title: string; cwd: string; createIfMissing: true; prompt: string }> = [];
  const secretaryRequests: PlanApprovalFeedbackPersonaRequest[] = [];
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
    secretary,
    sendToTask: async (request) => { taskRequests.push(request); },
    sendToSecretary: async (target, request) => {
      assert.equal(target.threadId, secretary.threadId);
      secretaryRequests.push(request);
    },
    sendToPersona: async (request) => { personaRequests.push(request); }
  });

  assert.equal(result.mode, "bound_task");
  assert.equal(taskRequests.length, 1);
  assert.match(taskRequests[0]?.prompt || "", /秘书同步跟进控制面/);
  assert.deepEqual(secretaryRequests.map((request) => request.kind), ["auto_delivered_notice"]);
  assert.match(secretaryRequests[0]?.text || "", /需要决定、授权、输入或最终复核时通知主人格/);
  assert.equal(personaRequests.length, 0);
});

test("missing business binding falls back to the assigned secretary instead of the persona", async () => {
  const secretaryRequests: PlanApprovalFeedbackPersonaRequest[] = [];
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];
  const result = await deliverPlanApprovalFeedback({
    roleId: "XinghaiBuilder",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan(undefined),
    feedback,
    secretary,
    sendToTask: async () => { throw new Error("must not send"); },
    sendToSecretary: async (_target, request) => { secretaryRequests.push(request); },
    sendToPersona: async (request) => { personaRequests.push(request); }
  });

  assert.equal(result.mode, "secretary_fallback");
  assert.deepEqual(secretaryRequests.map((request) => request.kind), ["full_feedback"]);
  assert.equal(personaRequests.length, 0);
});

test("approval is delivered to the bound Codex task and persona only receives an auto-delivered notice", async () => {
  const taskRequests: Array<{ threadId: string; title: string; cwd: string; createIfMissing: true; prompt: string }> = [];
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
  assert.equal(taskRequests[0]?.title, "原业务任务");
  assert.equal(taskRequests[0]?.createIfMissing, true);
  assert.equal(taskRequests[0]?.cwd, "C:\\Data\\CottonProject\\PangHu");
  assert.match(taskRequests[0]?.prompt || "", /批准按推荐方案实施/);
  assert.match(taskRequests[0]?.prompt || "", /approval_response/);
  assert.equal(personaRequests.length, 1);
  assert.equal(personaRequests[0]?.kind, "auto_delivered_notice");
  assert.match(personaRequests[0]?.text || "", /系统已自动投递到绑定业务会话/);
  assert.match(personaRequests[0]?.text || "", /人格 Agent 只需复核后续结果/);
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
  assert.match(personaRequests[0]?.text || "", /记录失败并续投原任务/);
});

test("plan guidance reaches the bound task without pretending to approve a step", async () => {
  const taskRequests: Array<{ threadId: string; title: string; cwd: string; createIfMissing: true; prompt: string }> = [];
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
  assert.equal(taskRequests[0]?.title, "审批直达原业务任务");
  assert.equal(taskRequests[0]?.createIfMissing, true);
  assert.match(taskRequests[0]?.prompt || "", /引导影响范围、优先级或路径时/);
  assert.match(taskRequests[0]?.prompt || "", /PATCH 计划和未开始步骤/);
  assert.match(taskRequests[0]?.prompt || "", /kind=guidance_response/);
  assert.match(taskRequests[0]?.prompt || "", /feedbackId=response-feedback-plan-guidance/);
  assert.match(taskRequests[0]?.prompt || "", /只写当前 planId/);
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
  assert.match(personaRequests[0]?.text || "", /系统重试同一会话|保持 pending/);
  assert.match(personaRequests[1]?.text || "", /仍未交给 Desktop owner|未投递/);
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

test("an ambiguous IPC timeout is completed when feedbackId readback proves acceptance", async () => {
  let taskCalls = 0;
  let reads = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];

  const result = await deliverPlanApprovalFeedback({
    roleId: "Rabi",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000006",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback: guidance,
    directRetryAttempts: 3,
    directRetryDelayMs: 1,
    sendToTask: async () => {
      taskCalls += 1;
      throw new Error("Codex Desktop IPC thread-follower-start-turn failed: thread-follower-start-turn-timeout");
    },
    readTaskDelivery: async (request) => {
      assert.equal(request.deliveryId, guidance.id);
      reads += 1;
      return reads === 1 ? "in_progress" : "accepted";
    },
    sendToPersona: async (request) => { personaRequests.push(request); }
  });

  assert.equal(result.mode, "bound_task");
  assert.equal(taskCalls, 1);
  assert.equal(reads, 2);
  assert.deepEqual(personaRequests.map((request) => request.kind), ["auto_delivered_notice"]);
});

test("an active readback stays pending without replay or a false failed notice", async () => {
  let taskCalls = 0;
  let reads = 0;
  const personaRequests: PlanApprovalFeedbackPersonaRequest[] = [];

  await assert.rejects(deliverPlanApprovalFeedback({
    roleId: "Rabi",
    managerBaseUrl: "http://127.0.0.1:8790",
    plan: plan({
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000007",
      workspace: "C:\\Data\\CottonProject\\PangHu"
    }),
    feedback: guidance,
    directRetryAttempts: 3,
    directRetryDelayMs: 1,
    sendToTask: async () => {
      taskCalls += 1;
      throw new Error("Codex Desktop IPC thread-follower-start-turn failed: thread-follower-start-turn-timeout");
    },
    readTaskDelivery: async () => {
      reads += 1;
      return "in_progress";
    },
    sendToPersona: async (request) => { personaRequests.push(request); }
  }), (error: unknown) => error instanceof PlanFeedbackDeliveryPendingError);

  assert.equal(taskCalls, 1);
  assert.equal(reads, 3);
  assert.deepEqual(personaRequests, []);
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
