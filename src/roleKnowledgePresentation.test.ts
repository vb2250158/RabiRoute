import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, PlanStatus, RecentMemoryItem } from "./roleKnowledge.js";
import {
  normalizeRoleMemoryPageLimit,
  normalizeRolePlanPageLimit,
  paginateRoleMemory,
  paginateRolePlans,
  previewRolePlan,
  summarizeRolePlan
} from "./roleKnowledgePagination.js";
import { planPresentation, presentPlan, presentPlans, sortKnowledgeByUpdatedAt } from "./roleKnowledgePresentation.js";

function plan(status: PlanStatus, patch: Partial<PlanItem> = {}): PlanItem {
  const terminal = status === "完成";
  return {
    id: `plan-${status}`,
    title: status,
    focus: `${status}计划`,
    status,
    archiveStatus: "未归档",
    attachments: [],
    steps: terminal
      ? [{ id: "work", title: "Work", status: "已完成" }]
      : [{ id: "work", title: "Work", status: "进行中" }],
    currentStepId: terminal || status === "关闭" ? undefined : "work",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    keywords: [status],
    ...patch
  };
}

const approvalRequest = {
  approver: "秋雨",
  request: "批准执行列出的改动。",
  recommendation: "批准当前最小改动方案。",
  alternatives: ["缩小范围后重新申请"],
  reason: "需要人工确认范围。",
  files: [{ path: "src/example.ts", action: "modify" as const, change: "更新示例逻辑。" }],
  commands: [],
  changes: [],
  validation: ["运行测试。"],
  rollback: ["回退改动。"],
  outOfScope: ["不发布。"],
  requestedAt: "2026-09-03T00:00:00.000Z",
  sourceMessageId: "message-1",
  responseStatus: "pending" as const
};

test("presentation status is always the exact plan.status", () => {
  const cases: Array<[PlanStatus, string]> = [
    ["分析中", "analyzing"],
    ["待审批", "blocked"],
    ["执行中", "executing"],
    ["等待打包", "waiting_package"],
    ["等待 QA", "qa"],
    ["待讨论", "discussion"],
    ["暂停", "paused"],
    ["完成", "done"],
    ["关闭", "closed"]
  ];
  for (const [status, tone] of cases) {
    const item = status === "待审批"
      ? plan(status, { steps: [{ id: "work", title: "Approve", status: "进行中", approvalRequest }] })
      : plan(status);
    const presentation = planPresentation(item);
    assert.equal(presentation.status, status);
    assert.equal(presentation.tone, tone);
    assert.equal("stage" in presentation, false);
  }
});

test("waiting text and step ids never override plan.status", () => {
  const item = plan("执行中", {
    currentStepId: "manual-verify-package-qa",
    waitingFor: "等待打包、等待 QA、待讨论、待审批",
    steps: [{ id: "manual-verify-package-qa", title: "等待 QA", status: "进行中", waitingFor: "暂停" }]
  });
  assert.equal(planPresentation(item).status, "执行中");
  assert.equal(planPresentation(item).tone, "executing");
});

test("archiveStatus controls archive visibility without replacing status", () => {
  const archivedCompleted = plan("完成", { archiveStatus: "已归档", archivedAt: "2026-09-03T01:00:00.000Z" });
  const closed = plan("关闭", { archiveStatus: "未归档" });
  assert.deepEqual(planPresentation(archivedCompleted).views, ["archived"]);
  assert.equal(planPresentation(archivedCompleted).status, "完成");
  assert.deepEqual(planPresentation(closed).views, ["plans"]);
  assert.equal(planPresentation(closed).status, "关闭");
});

test("pending approval remains metadata under the explicit 待审批 status", () => {
  const item = plan("待审批", {
    steps: [{ id: "work", title: "Approve", status: "进行中", approvalRequest }]
  });
  const presentation = planPresentation(item);
  assert.equal(presentation.status, "待审批");
  assert.equal(presentation.approval.state, "ready");
  assert.equal(presentation.approval.enabled, true);
});

test("status ordering follows the canonical status vocabulary", () => {
  const statuses: PlanStatus[] = ["关闭", "完成", "暂停", "待讨论", "等待 QA", "等待打包", "执行中", "待审批", "分析中"];
  const ordered = presentPlans(statuses.map((status, index) => plan(status, {
    id: `p-${index}`,
    ...(status === "待审批" ? { steps: [{ id: "work", title: "Approve", status: "进行中", approvalRequest }] } : {})
  })));
  assert.deepEqual(ordered.map((item) => item.status), ["分析中", "待审批", "执行中", "等待打包", "等待 QA", "待讨论", "暂停", "完成", "关闭"]);
});

test("pagination facets and filters use plan.status and exclude archived plans from current view", () => {
  const items = [
    presentPlan(plan("分析中", { id: "analysis", keywords: ["recall-target"] })),
    presentPlan(plan("执行中", { id: "execution", keywords: ["recall-target"] })),
    presentPlan(plan("完成", {
      id: "archived",
      archiveStatus: "已归档",
      archivedAt: "2026-09-03T01:00:00.000Z",
      keywords: ["recall-target"]
    }))
  ];
  const page = paginateRolePlans(items, "", 20, { includeFacets: true });
  assert.equal(page.counts.current, 2);
  assert.equal(page.counts.archived, 1);
  assert.deepEqual(page.facets.statuses.map((item) => item.status), ["分析中", "执行中", "完成"]);
  assert.deepEqual(paginateRolePlans(items, "", 20, { statuses: ["执行中"] }).items.map((item) => item.id), ["execution"]);
  assert.deepEqual(paginateRolePlans(items, "", 20, { query: "recall-target" }).items.map((item) => item.id), ["analysis", "execution"]);
  assert.deepEqual(paginateRolePlans(items, "", 20, { view: "archived", query: "recall-target" }).items.map((item) => item.id), ["archived"]);
});

test("summary and preview keep the canonical status and omit attachment paths", () => {
  const item = presentPlan(plan("执行中", {
    attachments: [{
      id: "a1",
      kind: "file",
      name: "report.md",
      mimeType: "text/markdown",
      size: 3,
      sha256: "abc",
      path: "C:/private/report.md"
    }]
  }));
  const summary = summarizeRolePlan(item);
  const preview = previewRolePlan(item);
  assert.equal(summary.status, "执行中");
  assert.equal(summary.presentation.status, "执行中");
  assert.equal(preview.status, "执行中");
  assert.equal(preview.attachments[0]?.name, "report.md");
  assert.equal("path" in preview.attachments[0]!, false);
});

test("pagination limits and memory ordering retain their contracts", () => {
  assert.equal(normalizeRolePlanPageLimit(null), 12);
  assert.equal(normalizeRolePlanPageLimit("999"), 250);
  assert.equal(normalizeRoleMemoryPageLimit(null), 24);
  const memories: RecentMemoryItem[] = [
    { id: "old", title: "Old", focus: "Old", content: "Old", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", keywords: [] },
    { id: "new", title: "New", focus: "New", content: "New", createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", keywords: [] }
  ];
  assert.deepEqual(sortKnowledgeByUpdatedAt(memories).map((item) => item.id), ["new", "old"]);
  assert.deepEqual(paginateRoleMemory(memories, "", 1, "", { recent: 2, consolidated: 0, archived: 0, consolidationRuns: 0 }).items.map((item) => item.id), ["old"]);
});
