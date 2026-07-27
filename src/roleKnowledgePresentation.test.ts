import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, RecentMemoryItem } from "./roleKnowledge.js";
import { planPresentation, presentPlan, presentPlans, sortKnowledgeByUpdatedAt } from "./roleKnowledgePresentation.js";

function approvalRequest() {
  return {
    request: "批准执行列出的改动。",
    reason: "需要人工确认范围。",
    files: [{ path: "src/example.ts", action: "modify" as const, change: "更新示例逻辑。" }],
    commands: [],
    changes: [],
    validation: ["运行 npm test 并确认通过。"],
    rollback: ["验证失败时回退 src/example.ts。"],
    outOfScope: ["不提交、不推送。"]
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

test("plan presentation only marks explicitly non-actionable steps as blocked", () => {
  const executableFailure = plan({
    id: "executable-failure",
    title: "Executable failure",
    currentStepId: "fix",
    steps: [{ id: "fix", title: "继续修复", status: "进行中", blockedBy: "Unity 自动化接口曾超时" }]
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
    blockedBy: "负责人尚未确认",
    steps: [{
      id: "ask-owner",
      title: "询问负责人并取得明确结果",
      status: "进行中",
      waitingFor: "负责人回复",
      blockedBy: "负责人尚未确认",
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
  assert.equal(planPresentation(awaitingOwnerAnswer).status, "进行中");
  assert.equal(planPresentation(awaitingOwnerAnswer).tone, "running");
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
    currentStepId: "decision",
    steps: [{ id: "decision", title: "等待方案确认", status: "进行中", approvalRequest: approvalRequest() }]
  });

  assert.deepEqual(planPresentation(item).approval, {
    state: "ready",
    enabled: true,
    label: "审批执行合同",
    helper: "请先核对具体文件、命令、变更、验证和回退范围，再决定是否批准。",
    stepId: "decision",
    missing: [],
    contract: approvalRequest()
  });
  assert.equal(planPresentation(item).status, "进行中");
  assert.equal(planPresentation(item).tone, "running");
});

test("plans awaiting approval sort first, then by Manager presentation status and newest update", () => {
  const sorted = presentPlans([
    plan({ id: "running", title: "Running", updatedAt: "2026-07-24T03:00:00.000Z" }),
    plan({
      id: "qa-old",
      title: "QA old",
      currentStepId: "verify",
      currentStep: "待 QA 测试",
      steps: [{ id: "verify", title: "待 QA 测试", status: "进行中", approvalRequest: approvalRequest() }],
      updatedAt: "2026-07-22T03:00:00.000Z"
    }),
    plan({ id: "blocked-old", title: "Blocked old", isBlocked: true, blockedBy: "External dependency", updatedAt: "2026-07-20T03:00:00.000Z" }),
    plan({ id: "qa-new", title: "QA new", waitingFor: "等待验收", updatedAt: "2026-07-23T03:00:00.000Z" }),
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
    "blocked-new",
    "blocked-old",
    "qa-new",
    "running",
    "pending",
    "completed",
    "archived",
    "paused-ready"
  ]);
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
