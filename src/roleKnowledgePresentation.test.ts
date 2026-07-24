import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem, RecentMemoryItem } from "./roleKnowledge.js";
import { planPresentation, presentPlans, sortKnowledgeByUpdatedAt } from "./roleKnowledgePresentation.js";

function plan(patch: Partial<PlanItem> & Pick<PlanItem, "id" | "title">): PlanItem {
  return {
    focus: patch.focus || patch.title,
    status: patch.status || "进行中",
    steps: patch.steps || [],
    createdAt: patch.createdAt || "2026-07-01T00:00:00.000Z",
    updatedAt: patch.updatedAt || "2026-07-01T00:00:00.000Z",
    keywords: patch.keywords || [],
    ...patch,
    id: patch.id,
    title: patch.title
  };
}

test("plan presentation derives blocker and active QA states without rewriting canonical status", () => {
  const blocked = plan({
    id: "blocked",
    title: "Blocked",
    currentStepId: "fix",
    steps: [{ id: "fix", title: "Fix", status: "进行中", blockedBy: "Waiting for evidence" }]
  });
  const qa = plan({
    id: "qa",
    title: "QA",
    currentStepId: "verify",
    steps: [{ id: "verify", title: "等待 QA 验收", status: "进行中" }]
  });
  const completed = plan({
    id: "completed",
    title: "Completed",
    status: "已完成",
    currentStep: "等待 QA 验收"
  });

  assert.equal(planPresentation(blocked).status, "阻塞中");
  assert.equal(planPresentation(blocked).tone, "blocked");
  assert.equal(planPresentation(blocked).approval.enabled, false);
  assert.equal(planPresentation(qa).status, "待QA测试");
  assert.equal(planPresentation(qa).tone, "qa");
  assert.equal(planPresentation(qa).approval.enabled, true);
  assert.equal(planPresentation(qa).approval.stepId, "verify");
  assert.equal(planPresentation(completed).status, "已完成");
  assert.equal(planPresentation(completed).tone, "done");
  assert.equal(planPresentation(completed).approval.enabled, false);
});

test("approval capability is Manager-owned and follows the current human gate", () => {
  const item = plan({
    id: "approval",
    title: "Approval",
    kind: "human-gate",
    currentStepId: "decision",
    steps: [{ id: "decision", title: "等待方案确认", status: "进行中" }]
  });

  assert.deepEqual(planPresentation(item).approval, {
    enabled: true,
    label: "审批建议",
    helper: "意见会由 Rabi Manager 记录并交给 Agent；提交本身不会直接推进计划。",
    stepId: "decision"
  });
});

test("plans are sorted by Manager presentation status and then newest update", () => {
  const sorted = presentPlans([
    plan({ id: "running", title: "Running", updatedAt: "2026-07-24T03:00:00.000Z" }),
    plan({ id: "qa-old", title: "QA old", currentStep: "待 QA 测试", updatedAt: "2026-07-22T03:00:00.000Z" }),
    plan({ id: "blocked-old", title: "Blocked old", blockedBy: "External dependency", updatedAt: "2026-07-20T03:00:00.000Z" }),
    plan({ id: "qa-new", title: "QA new", waitingFor: "等待验收", updatedAt: "2026-07-23T03:00:00.000Z" }),
    plan({ id: "blocked-new", title: "Blocked new", blockedBy: "Missing build", updatedAt: "2026-07-21T03:00:00.000Z" }),
    plan({ id: "pending", title: "Pending", status: "未开始", updatedAt: "2026-07-25T03:00:00.000Z" })
  ]);

  assert.deepEqual(sorted.map((item) => item.id), [
    "blocked-new",
    "blocked-old",
    "qa-new",
    "qa-old",
    "running",
    "pending"
  ]);
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
