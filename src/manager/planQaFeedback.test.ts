import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendPlanFeedback,
  createPlanFeedbackRecord,
  listPlanFeedback
} from "../planFeedback.js";
import { createPlan, listPlans } from "../roleKnowledge.js";
import { planPresentation } from "../roleKnowledgePresentation.js";
import { consumePlanQaFeedback } from "./planQaFeedback.js";

test("QA failure reopens investigation and continues the exact bound task once", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-failure-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const binding = {
    agentType: "codex" as const,
    sessionId: "019f0000-0000-7000-8000-000000000001",
    sessionTitle: "RabiRoute 产品修复",
    workspace: "C:\\workspace\\RabiRoute",
    completionHook: { enabled: true, gatewayId: "Rabi__main" }
  };
  createPlan(roleDir, {
    id: "plan-qa-loop",
    title: "修复产品回归",
    focus: "产品回归",
    status: "进行中",
    currentStepId: "verify-regression",
    currentStep: "等待 QA 验收",
    waitingFor: "QA 回传复测结果",
    steps: [
      { id: "implement", title: "实施修复", status: "已完成" },
      { id: "verify-regression", title: "QA 回归验收", status: "进行中", waitingFor: "QA 回传复测结果" }
    ],
    taskBinding: binding,
    keywords: ["QA", "回归"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-failed-1",
    roleId: "Rabi",
    planId: "plan-qa-loop",
    planTitle: "修复产品回归",
    stepId: "verify-regression",
    stepTitle: "QA 回归验收",
    text: "问题仍存在。复现步骤：打开计划页后点击验收，实际仍显示旧状态，预期显示修复后的状态。",
    attachments: [{
      kind: "image",
      name: "qa-failure.png",
      path: "C:\\private\\qa-failure.png",
      size: 128,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }],
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  const sends: Array<{ threadId: string; title: string; cwd: string; createIfMissing: true; prompt: string }> = [];

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async (request) => { sends.push(request); }
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, "dispatched");
  const plan = listPlans(roleDir)[0];
  assert.equal(plan.status, "进行中");
  assert.equal(plan.currentStepId, "investigate-verify-regression");
  assert.equal(plan.steps.find((step) => step.id === "verify-regression")?.status, "未开始");
  assert.equal(plan.steps.find((step) => step.id === "investigate-verify-regression")?.status, "进行中");
  assert.equal(planPresentation(plan).tone, "running");
  assert.deepEqual(plan.taskBinding, binding);
  assert.equal(sends.length, 1);
  assert.deepEqual(
    { threadId: sends[0].threadId, cwd: sends[0].cwd },
    { threadId: binding.sessionId, cwd: binding.workspace }
  );
  assert.equal(sends[0].title, binding.sessionTitle);
  assert.equal(sends[0].createIfMissing, true);
  assert.match(sends[0].prompt, /绑定任务已归档时创建替代任务/);
  assert.match(sends[0].prompt, /问题仍存在/);
  assert.match(sends[0].prompt, /深化根因分析/);
  assert.equal(listPlanFeedback(roleDir, feedback.planId)[0]?.qaHandling?.status, "dispatched");

  const duplicate = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async (request) => { sends.push(request); }
  });
  assert.equal(duplicate.status, "dispatched");
  assert.equal(sends.length, 1);
  assert.equal(
    listPlans(roleDir)[0].steps.filter((step) => step.id === "investigate-verify-regression").length,
    1
  );
});

test("only an explicit QA pass completes acceptance", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-pass-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-pass",
    title: "完成 QA 验收",
    focus: "QA 验收",
    status: "进行中",
    currentStepId: "qa-acceptance",
    currentStep: "等待 QA 明确通过",
    waitingFor: "QA 回传验收结果",
    steps: [
      { id: "implement", title: "实施修复", status: "已完成" },
      { id: "qa-acceptance", title: "QA 验收", status: "进行中", waitingFor: "QA 回传验收结果" }
    ],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000002",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA", "验收"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-pass-1",
    roleId: "Rabi",
    planId: "plan-qa-pass",
    planTitle: "完成 QA 验收",
    stepId: "qa-acceptance",
    stepTitle: "QA 验收",
    text: "QA明确通过，本轮未再复现，可以验收完成。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  let sendCount = 0;

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async () => { sendCount += 1; }
  });

  assert.equal(result.outcome, "passed");
  assert.equal(result.status, "completed");
  const plan = listPlans(roleDir)[0];
  assert.equal(plan.status, "已完成");
  assert.equal(plan.steps.find((step) => step.id === "qa-acceptance")?.status, "已完成");
  assert.equal(plan.waitingFor, undefined);
  assert.equal(planPresentation(plan).tone, "done");
  assert.equal(sendCount, 0);
  assert.equal(listPlanFeedback(roleDir, feedback.planId)[0]?.qaHandling?.status, "completed");
});

test("insufficient account QA evidence becomes an actionable inquiry and later evidence resumes the original task", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-inquiry-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-account-qa",
    title: "修复玩家状态异常",
    focus: "玩家状态异常",
    status: "进行中",
    currentStepId: "verify-account",
    currentStep: "等待 QA 验收",
    waitingFor: "QA 回传",
    steps: [{ id: "verify-account", title: "QA 验证玩家状态", status: "进行中", waitingFor: "QA 回传" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000003",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["账号", "QA"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-account-missing",
    roleId: "Rabi",
    planId: "plan-account-qa",
    planTitle: "修复玩家状态异常",
    stepId: "verify-account",
    text: "账号问题仍存在，玩家重新登录后状态未变化。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  let sendCount = 0;

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async () => { sendCount += 1; }
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, "waiting_for_evidence");
  assert.deepEqual(result.missingEvidence, ["账号或玩家编号", "北京时间", "前后状态"]);
  const plan = listPlans(roleDir)[0];
  assert.equal(plan.status, "进行中");
  assert.equal(plan.isBlocked, undefined);
  assert.equal(plan.blockedBy, undefined);
  assert.match(plan.waitingFor || "", /账号或玩家编号/);
  assert.match(plan.waitingFor || "", /北京时间/);
  assert.match(plan.waitingFor || "", /前后状态/);
  assert.doesNotMatch(plan.waitingFor || "", /版本|渠道|截图|视频|日志/);
  assert.equal(planPresentation(plan).tone, "paused");
  assert.equal(planPresentation(plan).status, "暂停");
  assert.equal(sendCount, 0);

  const evidence = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-account-evidence",
    roleId: "Rabi",
    planId: "plan-account-qa",
    planTitle: "修复玩家状态异常",
    stepId: "investigate-verify-account",
    text: "玩家编号：P12345。北京时间 2026-07-28 14:30。修复前状态为未解锁，重新登录后状态仍为未解锁。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  const sends: Array<{ threadId: string; cwd: string; prompt: string }> = [];
  const continued = await consumePlanQaFeedback({
    roleDir,
    feedback: evidence,
    sendToTask: async (request) => { sends.push(request); }
  });

  assert.equal(continued.outcome, "failed");
  assert.equal(continued.status, "dispatched");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].threadId, "019f0000-0000-7000-8000-000000000003");
  assert.equal(sends[0].cwd, "C:\\workspace\\RabiRoute");
  assert.match(sends[0].prompt, /账号问题仍存在/);
  assert.match(sends[0].prompt, /玩家编号：P12345/);
  assert.equal(listPlans(roleDir)[0].waitingFor, undefined);
});

test("a failed task continuation can retry the same feedback without duplicating the investigation step", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-retry-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-retry",
    title: "修复界面显示",
    focus: "界面显示",
    status: "进行中",
    currentStepId: "qa-retry",
    steps: [
      { id: "implement", title: "实施", status: "已完成" },
      { id: "qa-retry", title: "QA 验收", status: "进行中" }
    ],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000004",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA", "界面"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-retry",
    roleId: "Rabi",
    planId: "plan-qa-retry",
    planTitle: "修复界面显示",
    stepId: "qa-retry",
    text: "问题仍存在。复现步骤：打开页面；实际仍是旧显示，预期显示新状态。",
    attachments: [{
      kind: "image",
      name: "retry.png",
      path: "C:\\private\\retry.png",
      size: 64,
      mimeType: "image/png",
      sha256: "b".repeat(64)
    }],
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  let attempts = 0;

  await assert.rejects(
    consumePlanQaFeedback({
      roleDir,
      feedback,
      sendToTask: async () => {
        attempts += 1;
        throw new Error("Desktop owner unavailable");
      }
    }),
    /Desktop owner unavailable/
  );
  assert.equal(listPlanFeedback(roleDir, feedback.planId)[0]?.qaHandling?.status, "dispatch_failed");

  const retried = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async () => { attempts += 1; }
  });
  assert.equal(retried.status, "dispatched");
  assert.equal(attempts, 2);
  assert.equal(
    listPlans(roleDir)[0].steps.filter((step) => step.id === "investigate-qa-retry").length,
    1
  );
});

test("QA wording does not close a plan when its structured current step is implementation", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-ignore-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-ignore",
    title: "继续实施",
    focus: "继续实施",
    status: "进行中",
    currentStepId: "implement",
    steps: [
      { id: "implement", title: "实施", status: "进行中", detail: "完成后再通知 QA" },
      { id: "qa-later", title: "QA 验收", status: "未开始" }
    ],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000005",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-feedback-unrelated-pass",
    roleId: "Rabi",
    planId: "plan-qa-ignore",
    planTitle: "继续实施",
    text: "另一个检查项 QA 通过。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async () => { throw new Error("must not send"); }
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(listPlans(roleDir)[0].currentStepId, "implement");
});

test("plan guidance cannot act as a QA verdict even on a structured QA step", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-guidance-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-guidance",
    title: "继续验证产品修复",
    focus: "产品验证",
    status: "进行中",
    currentStepId: "verify-guidance",
    steps: [{ id: "verify-guidance", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000006",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-guidance-explicit-pass",
    roleId: "Rabi",
    planId: "plan-qa-guidance",
    planTitle: "继续验证产品修复",
    stepId: "verify-guidance",
    kind: "guidance_response",
    text: "QA 明确通过，后续继续整理文档。",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async () => { throw new Error("must not send"); }
  });

  assert.equal(result.outcome, "ignored");
  assert.equal(listPlans(roleDir)[0].status, "进行中");
  assert.equal(listPlans(roleDir)[0].currentStepId, "verify-guidance");
  assert.equal(listPlanFeedback(roleDir, feedback.planId)[0]?.qaHandling, undefined);
});

test("agent test summaries and bare English pass words are not QA verdicts", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-agent-summary-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-agent-summary",
    title: "验证测试结果",
    focus: "测试结果",
    status: "进行中",
    currentStepId: "verify-runtime",
    steps: [{ id: "verify-runtime", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000007",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const agentSummary = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-agent-summary",
    roleId: "Rabi",
    planId: "plan-qa-agent-summary",
    planTitle: "验证测试结果",
    stepId: "verify-runtime",
    text: "定向测试 matched=10 passed=10 failed=0；运行时验收仍待执行。",
    author: "agent",
    source: "agent",
    notifyAgent: false
  }));
  const barePassed = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-bare-passed",
    roleId: "Rabi",
    planId: "plan-qa-agent-summary",
    planTitle: "验证测试结果",
    stepId: "verify-runtime",
    text: "passed",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  const bareVerified = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-bare-verified",
    roleId: "Rabi",
    planId: "plan-qa-agent-summary",
    planTitle: "验证测试结果",
    stepId: "verify-runtime",
    text: "verified",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));

  for (const feedback of [agentSummary, barePassed, bareVerified]) {
    const result = await consumePlanQaFeedback({
      roleDir,
      feedback,
      sendToTask: async () => { throw new Error("must not send"); }
    });
    assert.equal(result.outcome, "ignored");
  }
  assert.equal(listPlans(roleDir)[0].status, "进行中");
  assert.equal(listPlans(roleDir)[0].currentStepId, "verify-runtime");
});

test("approval responses are audit records and cannot reopen or complete QA", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-approval-response-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-approval-response",
    title: "验证审批回执隔离",
    focus: "QA 验收",
    status: "进行中",
    currentStepId: "qa-approval-response",
    steps: [{ id: "qa-approval-response", title: "QA 验收", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000009",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  for (const [id, kind, text] of [
    ["qa-guidance", "guidance", "QA 明确通过。"],
    ["qa-approval-response", "approval_response", "问题仍存在，验收失败。"]
  ] as const) {
    const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
      id,
      roleId: "Rabi",
      planId: "plan-qa-approval-response",
      planTitle: "验证审批回执隔离",
      stepId: "qa-approval-response",
      kind,
      text,
      author: kind === "approval_response" ? "agent" : "user",
      source: kind === "approval_response" ? "agent" : "webgui",
      notifyAgent: false
    }));
    const result = await consumePlanQaFeedback({
      roleDir,
      feedback,
      sendToTask: async () => { throw new Error("must not send"); }
    });
    assert.equal(result.outcome, "ignored");
  }
  assert.equal(listPlans(roleDir)[0].status, "进行中");
  assert.equal(listPlans(roleDir)[0].currentStepId, "qa-approval-response");
});

test("an explicit English QA failure is consumed", async (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-plan-qa-english-failure-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  createPlan(roleDir, {
    id: "plan-qa-english-failure",
    title: "Verify the QA verdict gate",
    focus: "QA acceptance",
    status: "进行中",
    currentStepId: "qa-english-failure",
    steps: [{ id: "qa-english-failure", title: "QA acceptance", status: "进行中" }],
    taskBinding: {
      agentType: "codex",
      sessionId: "019f0000-0000-7000-8000-000000000010",
      workspace: "C:\\workspace\\RabiRoute"
    },
    keywords: ["QA"]
  });
  const feedback = appendPlanFeedback(roleDir, createPlanFeedbackRecord({
    id: "qa-explicit-english-failure",
    roleId: "Rabi",
    planId: "plan-qa-english-failure",
    planTitle: "Verify the QA verdict gate",
    stepId: "qa-english-failure",
    kind: "approval_suggestion",
    text: "QA failed. Reproduction steps: open the plan page. Actual: old status. Expected: new status.",
    author: "user",
    source: "webgui",
    notifyAgent: false
  }));
  const sends: Array<{ threadId: string; cwd: string; prompt: string }> = [];

  const result = await consumePlanQaFeedback({
    roleDir,
    feedback,
    sendToTask: async (request) => { sends.push(request); }
  });

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, "dispatched");
  assert.equal(sends.length, 1);
  assert.equal(listPlans(roleDir)[0].currentStepId, "investigate-qa-english-failure");
});
