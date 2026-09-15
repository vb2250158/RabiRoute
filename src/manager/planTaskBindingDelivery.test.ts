import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "../roleKnowledge.js";
import {
  planTaskDeliveryTarget,
  replacementPlanTaskBinding
} from "./planTaskBindingDelivery.js";

function plan(taskBinding: PlanItem["taskBinding"]): PlanItem {
  return {
    id: "plan-task-binding-delivery",
    title: "计划默认任务标题",
    focus: "验证归档绑定的替代投递",
    status: "执行中",
    archiveStatus: "未归档",
    attachments: [],
    steps: [],
    keywords: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    taskBinding
  };
}

test("plan task delivery prefers the binding title and creates when the bound task is unavailable", () => {
  const target = planTaskDeliveryTarget(plan({
    agentType: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000001",
    sessionTitle: "保存的业务任务标题",
    workspace: "C:\\work\\example"
  }));

  assert.deepEqual(target, {
    agentAdapter: "codex",
    threadId: "019f0000-0000-7000-8000-000000000001",
    title: "保存的业务任务标题",
    cwd: "C:\\work\\example",
    createIfMissing: true
  });
});

test("plan task delivery falls back to the plan title", () => {
  const target = planTaskDeliveryTarget(plan({
    agentType: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000002",
    workspace: "C:\\work\\example"
  }));

  assert.equal(target?.title, "计划默认任务标题");
});

test("replacement plan binding retains the completion hook", () => {
  const source = plan({
    agentType: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000003",
    sessionTitle: "原业务任务",
    workspace: "C:\\work\\example",
    completionHook: { enabled: true, gatewayId: "Rabi__main" }
  });

  assert.deepEqual(replacementPlanTaskBinding(source, {
    id: "019f0000-0000-7000-8000-000000000004",
    title: "归档后的替代任务",
    cwd: "C:\\work\\example"
  }), {
    ...source.taskBinding,
    sessionId: "019f0000-0000-7000-8000-000000000004",
    sessionTitle: "归档后的替代任务"
  });
});

test("replacement plan binding does not write when the task ID is unchanged", () => {
  const source = plan({
    agentType: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000005",
    workspace: "C:\\work\\example"
  });

  assert.equal(replacementPlanTaskBinding(source, {
    id: "019f0000-0000-7000-8000-000000000005",
    cwd: "C:\\work\\example"
  }), null);
});

test("replacement plan binding rejects a task in a different workspace", () => {
  const source = plan({
    agentType: "codex",
    sessionId: "019f0000-0000-7000-8000-000000000006",
    workspace: "C:\\work\\example"
  });

  assert.throws(() => replacementPlanTaskBinding(source, {
    id: "019f0000-0000-7000-8000-000000000007",
    cwd: "C:\\work\\other"
  }), /belongs to another workspace/);
});
