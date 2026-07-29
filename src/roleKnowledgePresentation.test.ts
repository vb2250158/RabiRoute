import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, RecentMemoryItem } from "./roleKnowledge.js";
import { normalizeRolePlanPageLimit, paginateRolePlans, summarizeRolePlan } from "./roleKnowledgePagination.js";
import { planPresentation, presentPlan, presentPlans, sortKnowledgeByUpdatedAt } from "./roleKnowledgePresentation.js";

function approvalRequest() {
  return {
    approver: "秋雨",
    request: "批准执行列出的改动。",
    recommendation: "批准当前最小改动方案。",
    alternatives: ["要求缩小范围后重新申请", "否决并回到方案设计"],
    reason: "需要人工确认范围。",
    files: [{ path: "src/example.ts", action: "modify" as const, change: "更新示例逻辑。" }],
    commands: [],
    changes: [],
    validation: ["运行 npm test 并确认通过。"],
    rollback: ["验证失败时回退 src/example.ts。"],
    outOfScope: ["不提交、不推送。"],
    requestedAt: "2026-07-28T00:00:00.000Z",
    sourceMessageId: "qq-message-1",
    responseStatus: "pending" as const
  };
}

function plan(patch: Partial<PlanItem> & Pick<PlanItem, "id" | "title">): PlanItem {
  return {
    focus: patch.focus || patch.title,
    status: patch.status || "进行中",
    attachments: patch.attachments || [],
    steps: patch.steps || [],
    createdAt: patch.createdAt || "2026-07-01T00:00:00.000Z",
    updatedAt: patch.updatedAt || "2026-07-01T00:00:00.000Z",
    keywords: patch.keywords || [],
    ...patch,
    id: patch.id,
    title: patch.title
  };
}

test("plan presentation blocks only complete pending approvals and keeps other obstacles running", () => {
  const executableFailure = plan({
    id: "executable-failure",
    title: "Executable failure",
    isBlocked: true,
    blockedBy: "Unity 自动化接口曾超时",
    currentStepId: "fix",
    steps: [{ id: "fix", title: "继续修复", status: "进行中", isBlocked: true, blockedBy: "Unity 自动化接口曾超时" }]
  });
  const blocked = plan({
    id: "blocked",
    title: "Blocked",
    currentStepId: "approve",
    steps: [{
      id: "approve",
      title: "等待批准修改生产文件",
      status: "进行中",
      isBlocked: true,
      blockedBy: "未经批准不得修改",
      approvalRequest: approvalRequest()
    }]
  });
  const awaitingOwnerAnswer = plan({
    id: "awaiting-owner-answer",
    title: "Awaiting owner answer",
    currentStepId: "ask-owner",
    waitingFor: "负责人回复",
    isBlocked: true,
    blockedBy: "负责人尚未批准是否采用当前方案",
    steps: [{
      id: "ask-owner",
      title: "询问负责人并取得明确结果",
      status: "进行中",
      waitingFor: "负责人回复",
      isBlocked: true,
      blockedBy: "负责人尚未批准是否采用当前方案",
      approvalRequest: approvalRequest()
    }]
  });
  const qa = plan({
    id: "qa",
    title: "QA",
    currentStepId: "verify",
    steps: [{ id: "verify", title: "等待 QA 验收", status: "进行中" }]
  });
  const qaWithLegacyBlocker = plan({
    id: "qa-with-legacy-blocker",
    title: "QA with legacy blocker",
    currentStepId: "verify",
    currentStep: "专项 QA 已真实发送，等待实机结果。",
    waitingFor: "QA 回传专项结果",
    blockedBy: "QA 尚未回传",
    steps: [{
      id: "verify",
      title: "完成QA并确认剩余决策",
      status: "进行中",
      waitingFor: "QA 专项结果",
      blockedBy: "QA 尚未回传"
    }]
  });
  const approvedImplementation = plan({
    id: "approved-implementation",
    title: "Approved implementation",
    currentStep: "方案已批准，继续执行编译与测试",
    currentStepId: "implement",
    steps: [{ id: "implement", title: "执行编译与测试", status: "进行中" }]
  });
  const implementationMentioningQa = plan({
    id: "implementation-mentioning-qa",
    title: "Implementation mentioning QA",
    currentStepId: "implement-regression-fix",
    currentStep: "修复回归；QA 门禁仍未满足，尚未通知 QA。",
    nextAction: "完成开发验证后再进入 QA。",
    waitingFor: "实现完成后安排 QA",
    steps: [{
      id: "implement-regression-fix",
      title: "修复包含 QA 门禁说明的回归",
      status: "进行中",
      detail: "当前仍是实现与开发验证，尚未通知 QA。",
      waitingFor: "实现完成后安排 QA"
    }]
  });
  const developmentValidation = plan({
    id: "development-validation",
    title: "Development validation",
    currentStepId: "validation-regression",
    currentStep: "开发侧回归验证，完成后再通知 QA。",
    steps: [{ id: "validation-regression", title: "开发验证", status: "进行中", detail: "尚未进入 QA。" }]
  });
  const awaitingPackage = plan({
    id: "plan-1784037085080",
    title: "Main r224817 / Release r224818 package acceptance",
    currentStepId: "package",
    waitingFor: "用户今晚开始打包并由原统一打包任务返回含 r224818 与目标包身份。",
    isBlocked: false,
    blockedBy: "",
    steps: [
      { id: "implement", title: "完成 Main / Release 实现", status: "已完成" },
      { id: "matching-tests", title: "完成双分支目标测试 3/3", status: "已完成" },
      { id: "package", title: "等待目标包产物", status: "进行中", waitingFor: "等待目标包身份与进包结果" }
    ]
  });
  const completed = plan({
    id: "completed",
    title: "Completed",
    status: "已完成",
    currentStep: "等待 QA 验收"
  });
  const paused = plan({
    id: "paused",
    title: "Paused",
    status: "暂停",
    currentStepId: "hold",
    isBlocked: true,
    blockedBy: "用户要求暂时跳过",
    steps: [{ id: "hold", title: "保留恢复位置", status: "进行中", isBlocked: true, blockedBy: "用户要求暂时跳过" }]
  });

  assert.equal(planPresentation(blocked).status, "阻塞中");
  assert.equal(planPresentation(blocked).tone, "blocked");
  assert.deepEqual(planPresentation(blocked).views, ["current", "plans"]);
  assert.deepEqual(planPresentation(blocked).palette, {
    accent: "#ef6c52",
    background: "#fff1ed",
    foreground: "#b42318"
  });
  assert.equal(planPresentation(blocked).approval.enabled, true);
  assert.equal(planPresentation(executableFailure).status, "进行中");
  assert.equal(planPresentation(executableFailure).tone, "running");
  assert.equal(planPresentation(executableFailure).approval.enabled, false);
  assert.equal(planPresentation(awaitingOwnerAnswer).status, "阻塞中");
  assert.equal(planPresentation(awaitingOwnerAnswer).tone, "blocked");
  assert.equal(planPresentation(awaitingOwnerAnswer).approval.state, "ready");
  assert.equal(planPresentation(qa).status, "待QA测试");
  assert.equal(planPresentation(qa).tone, "qa");
  assert.deepEqual(planPresentation(qa).palette, {
    accent: "#8e63c7",
    background: "#f3e8ff",
    foreground: "#7e22ce"
  });
  assert.equal(planPresentation(qa).approval.state, "none");
  assert.equal(planPresentation(qa).approval.enabled, false);
  assert.equal(planPresentation(qaWithLegacyBlocker).status, "待QA测试");
  assert.equal(planPresentation(qaWithLegacyBlocker).tone, "qa");
  assert.equal(planPresentation(qaWithLegacyBlocker).approval.enabled, false);
  assert.equal(planPresentation(approvedImplementation).status, "进行中");
  assert.equal(planPresentation(approvedImplementation).approval.state, "none");
  assert.equal(planPresentation(implementationMentioningQa).status, "进行中");
  assert.equal(planPresentation(implementationMentioningQa).tone, "running");
  assert.equal(planPresentation(developmentValidation).status, "进行中");
  assert.equal(planPresentation(developmentValidation).tone, "running");
  assert.equal(planPresentation(awaitingPackage).status, "等待打包");
  assert.equal(planPresentation(awaitingPackage).tone, "waiting_package");
  assert.equal(planPresentation(awaitingPackage).sortBucket, 3);
  assert.deepEqual(planPresentation(awaitingPackage).palette, {
    accent: "#2563eb",
    background: "#eff6ff",
    foreground: "#1d4ed8"
  });
  assert.equal(planPresentation(completed).status, "已完成");
  assert.equal(planPresentation(completed).tone, "done");
  assert.deepEqual(planPresentation(completed).views, ["plans"]);
  assert.deepEqual(planPresentation(completed).palette, {
    accent: "#607d8b",
    background: "#eaf4f7",
    foreground: "#52677a"
  });
  assert.equal(planPresentation(completed).approval.enabled, false);
  assert.equal(planPresentation(paused).status, "暂停");
  assert.equal(planPresentation(paused).tone, "paused");
  assert.deepEqual(planPresentation(paused).views, ["plans"]);
  assert.deepEqual(planPresentation(paused).palette, {
    accent: "#64748b",
    background: "#f1f5f9",
    foreground: "#475569"
  });
  assert.equal(planPresentation(paused).approval.enabled, false);
});

test("approval capability is Manager-owned and follows the current human gate", () => {
  const item = plan({
    id: "approval",
    title: "Approval",
    kind: "human-gate",
    isBlocked: true,
    blockedBy: "秋雨尚未批准当前最小改动方案",
    currentStepId: "decision",
    steps: [{ id: "decision", title: "等待方案确认", status: "进行中", isBlocked: true, blockedBy: "秋雨尚未批准当前最小改动方案", approvalRequest: approvalRequest() }]
  });

  assert.deepEqual(planPresentation(item).approval, {
    state: "ready",
    enabled: true,
    label: "审批执行合同",
    helper: "请先核对审批人、具体决定、推荐与备选、文件、命令、外部变更、验证、回退、排除范围、附件和回执状态，再决定是否批准。",
    stepId: "decision",
    missing: [],
    contract: approvalRequest()
  });
  assert.equal(planPresentation(item).status, "阻塞中");
  assert.equal(planPresentation(item).tone, "blocked");
});

test("incomplete approvals stay running and disabled until the contract becomes approvable", () => {
  const incomplete = plan({
    id: "approval-incomplete",
    title: "Incomplete approval",
    isBlocked: true,
    blockedBy: "秋雨尚未批准是否执行当前改动",
    currentStepId: "approve",
    steps: [{
      id: "approve",
      title: "等待秋雨审批",
      status: "进行中",
      isBlocked: true,
      blockedBy: "秋雨尚未批准是否执行当前改动",
      approvalRequest: {
        request: "批准当前改动。",
        reason: "需要人工授权。",
        files: [],
        commands: [],
        changes: [],
        validation: [],
        rollback: [],
        outOfScope: []
      }
    }]
  });
  const incompletePresentation = planPresentation(incomplete);
  assert.equal(incompletePresentation.status, "进行中");
  assert.equal(incompletePresentation.tone, "running");
  assert.equal(incompletePresentation.approval.state, "incomplete");
  assert.equal(incompletePresentation.approval.enabled, false);
  assert.ok(incompletePresentation.approval.missing.includes("approver"));
  assert.ok(incompletePresentation.approval.missing.includes("source"));

  const resolved = plan({
    id: "approval-resolved",
    title: "Resolved approval",
    currentStepId: "implement",
    steps: [{ id: "implement", title: "执行已批准方案", status: "进行中" }]
  });
  assert.equal(planPresentation(resolved).status, "进行中");
  assert.equal(planPresentation(resolved).approval.state, "none");
});

test("plans awaiting approval sort first, then by Manager presentation status and newest update", () => {
  const sorted = presentPlans([
    plan({ id: "running", title: "Running", updatedAt: "2026-07-24T03:00:00.000Z" }),
    plan({
      id: "waiting-package",
      title: "Waiting package",
      currentStepId: "package",
      waitingFor: "等待目标包身份",
      steps: [
        { id: "implement", title: "完成实现", status: "已完成" },
        { id: "matching-tests", title: "完成匹配测试", status: "已完成" },
        { id: "package", title: "等待目标包", status: "进行中" }
      ],
      updatedAt: "2026-07-28T03:00:00.000Z"
    }),
    plan({
      id: "qa-old",
      title: "QA old",
      currentStepId: "verify",
      currentStep: "待 QA 测试",
      steps: [{ id: "verify", title: "待 QA 测试", status: "进行中", approvalRequest: approvalRequest() }],
      updatedAt: "2026-07-22T03:00:00.000Z"
    }),
    plan({ id: "blocked-old", title: "Blocked old", isBlocked: true, blockedBy: "External dependency", updatedAt: "2026-07-20T03:00:00.000Z" }),
    plan({
      id: "qa-new",
      title: "QA new",
      currentStepId: "qa-regression",
      waitingFor: "等待验收",
      steps: [{ id: "qa-regression", title: "等待验收", status: "进行中" }],
      updatedAt: "2026-07-23T03:00:00.000Z"
    }),
    plan({ id: "blocked-new", title: "Blocked new", isBlocked: true, blockedBy: "Missing build", updatedAt: "2026-07-21T03:00:00.000Z" }),
    plan({ id: "pending", title: "Pending", status: "未开始", updatedAt: "2026-07-25T03:00:00.000Z" }),
    plan({ id: "completed", title: "Completed", status: "已完成", updatedAt: "2026-07-27T03:00:00.000Z" }),
    plan({ id: "archived", title: "Archived", status: "已归档", updatedAt: "2026-07-27T04:00:00.000Z" }),
    plan({
      id: "paused-ready",
      title: "Paused approval",
      status: "暂停",
      currentStepId: "approve",
      steps: [{ id: "approve", title: "等待审批", status: "进行中", approvalRequest: approvalRequest() }],
      updatedAt: "2026-07-26T03:00:00.000Z"
    })
  ]);

  assert.deepEqual(sorted.map((item) => item.id), [
    "qa-old",
    "qa-new",
    "running",
    "blocked-new",
    "blocked-old",
    "waiting-package",
    "pending",
    "completed",
    "archived",
    "paused-ready"
  ]);
  assert.deepEqual(
    sorted.map((item) => item.presentation.sortBucket),
    [0, 1, 2, 2, 2, 3, 4, 5, 6, 8]
  );
});

test("presented plans expose attachment metadata without local filesystem paths", () => {
  const presented = presentPlan(plan({
    id: "attachment-plan",
    title: "Attachment plan",
    attachments: [{
      id: "attachment-one",
      kind: "image",
      name: "preview.png",
      path: "C:\\private\\preview.png",
      size: 8,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }]
  }));

  assert.equal(presented.attachments[0]?.name, "preview.png");
  assert.equal("path" in presented.attachments[0]!, false);
});

test("plan pages preserve Manager ordering and expose stable counts while advancing the cursor", () => {
  const presented = presentPlans([
    plan({ id: "running", title: "Running" }),
    plan({ id: "qa", title: "QA", currentStepId: "qa", steps: [{ id: "qa", title: "等待 QA 验收", status: "进行中" }] }),
    plan({ id: "done", title: "Done", status: "已完成" }),
    plan({ id: "archived", title: "Archived", status: "已归档" })
  ]);

  const first = paginateRolePlans(presented, "", 2);
  const second = paginateRolePlans(presented, first.nextCursor, 2);

  assert.deepEqual(first.items.map((item) => item.id), presented.slice(0, 2).map((item) => item.id));
  assert.deepEqual(second.items.map((item) => item.id), presented.slice(2).map((item) => item.id));
  assert.equal(first.nextCursor, "2");
  assert.equal(second.nextCursor, "");
  assert.deepEqual(first.counts, {
    total: 4,
    current: 2,
    plans: 3,
    archived: 1,
    blocked: 0,
    qa: 1,
    active: 2
  });
  assert.deepEqual(second.counts, first.counts);
});

test("plan page inputs reject invalid cursors and clamp oversized limits", () => {
  assert.equal(normalizeRolePlanPageLimit(null), 12);
  assert.equal(normalizeRolePlanPageLimit("0"), 1);
  assert.equal(normalizeRolePlanPageLimit("999"), 50);
  assert.throws(() => normalizeRolePlanPageLimit("many"), /Invalid plan page limit/);
  assert.throws(() => paginateRolePlans([], "next", 12), /Invalid plan page cursor/);
});

test("plan summaries keep title, type, status and ordering metadata without formal content", () => {
  const presented = presentPlan(plan({
    id: "summary",
    title: "Summary first",
    kind: "design",
    focus: "Full focus content",
    attachments: [{
      id: "image",
      kind: "image",
      name: "large.png",
      path: "C:\\private\\large.png",
      size: 1024,
      mimeType: "image/png",
      sha256: "a".repeat(64)
    }],
    steps: [{ id: "implementation", title: "Formal step content", status: "进行中" }]
  }));
  const summary = summarizeRolePlan(presented);

  assert.equal(summary.title, "Summary first");
  assert.equal(summary.kind, "design");
  assert.equal(summary.presentation.status, presented.presentation.status);
  assert.equal(summary.attachmentCount, 1);
  assert.equal(summary.stepCount, 1);
  assert.equal("focus" in summary, false);
  assert.equal("attachments" in summary, false);
  assert.equal("steps" in summary, false);
  assert.equal("contract" in summary.presentation.approval, false);
});

test("memory lists are sorted by updatedAt without mutating the source array", () => {
  const items: RecentMemoryItem[] = [
    {
      id: "older",
      title: "Older",
      focus: "Older",
      content: "Older",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      keywords: []
    },
    {
      id: "newer",
      title: "Newer",
      focus: "Newer",
      content: "Newer",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      keywords: []
    }
  ];

  assert.deepEqual(sortKnowledgeByUpdatedAt(items).map((item) => item.id), ["newer", "older"]);
  assert.deepEqual(items.map((item) => item.id), ["older", "newer"]);
});
