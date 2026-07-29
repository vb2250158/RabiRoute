import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "./roleKnowledge.js";
import { migrateLegacyPackageGatePlan, planIsWaitingForPackage } from "./planPackageWaiting.js";

function plan(patch: Partial<PlanItem>): PlanItem {
  return {
    id: "package-plan",
    title: "Package plan",
    focus: "Package plan",
    status: "进行中",
    currentStepId: "package",
    attachments: [],
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      { id: "matching-tests", title: "完成匹配测试", status: "已完成" },
      { id: "package", title: "等待打包", status: "进行中" }
    ],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    keywords: [],
    ...patch
  };
}

test("package waiting uses the structured package step and excludes QA, approval, material, and unfinished work", () => {
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待合包并返回目标包身份" })), true);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待构建完成并返回包产物" })), true);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待确认 r224818 已进包" })), true);

  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "package-next-client-build",
    waitingFor: "等待用户今晚明确说‘开始打包’",
    steps: [
      { id: "scope-audit", title: "核对范围", status: "已完成" },
      { id: "reverify", title: "回读上一目标包", status: "已完成" },
      { id: "package-next-client-build", title: "等待下一次打包", status: "进行中" },
      { id: "close", title: "收口", status: "未开始" }
    ]
  })), true);

  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "verify-package",
    waitingFor: "等待目标包后由 QA 验收",
    steps: [
      { id: "implement", title: "完成实现", status: "已完成" },
      { id: "verify-package", title: "QA 验收目标包", status: "进行中" }
    ]
  })), false);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待用户批准打包方案" })), false);
  assert.equal(planIsWaitingForPackage(plan({ waitingFor: "等待补充打包说明资料" })), false);
  assert.equal(planIsWaitingForPackage(plan({
    currentStepId: "implement",
    waitingFor: "等待正式打包任务恢复现场",
    steps: [
      { id: "implement", title: "继续实现", status: "进行中" },
      { id: "matching-tests", title: "完成匹配测试", status: "未开始" },
      { id: "package", title: "等待目标包", status: "未开始" }
    ]
  })), false);
});

test("legacy global packaging blockers migrate to non-blocked package waiting only after prior steps complete", () => {
  const source = plan({
    isBlocked: true,
    blockedBy: "等待正式打包任务恢复 Main/Release/Art 现场；当前禁止任何 Unity、SVN、测试、构建、上传、发布或 QA 推进。",
    waitingFor: "等待正式打包任务返回含 r224818 与目标包身份。",
    steps: [
      { id: "implement", title: "完成 Main / Release 实现", status: "已完成" },
      { id: "matching-tests", title: "完成双分支目标测试 3/3", status: "已完成" },
      {
        id: "package",
        title: "等待目标包产物",
        status: "进行中",
        waitingFor: "等待目标包身份与进包结果",
        isBlocked: true,
        blockedBy: "等待正式打包任务恢复现场"
      }
    ]
  });

  const migrated = migrateLegacyPackageGatePlan(source, "2026-07-28T10:00:00.000Z");
  assert.equal(migrated?.action, "waiting_package");
  assert.equal(migrated?.plan.isBlocked, false);
  assert.equal(migrated?.plan.blockedBy, "");
  assert.equal(migrated?.plan.steps[2]?.isBlocked, false);
  assert.equal(migrated?.plan.steps[2]?.blockedBy, "");
  assert.equal(migrated?.plan.waitingFor, source.waitingFor);
  assert.equal(planIsWaitingForPackage(migrated!.plan), true);
});

test("legacy packaging gates resume unfinished work without changing its business task binding", () => {
  const taskBinding: PlanItem["taskBinding"] = {
    agentType: "codex",
    sessionId: "019fa319-25c6-78a0-9364-b0a4ffe8dc4c",
    sessionTitle: "Original business task",
    workspace: "C:/Projects/Example"
  };
  const source = plan({
    currentStepId: "implement",
    currentStep: "继续实现并完成匹配测试",
    waitingFor: "等待正式打包任务恢复现场",
    isBlocked: true,
    blockedBy: "等待正式打包任务恢复 Main/Release/Art 现场；当前禁止任何 Unity、SVN、测试、构建、上传、发布或 QA 推进。",
    taskBinding,
    steps: [
      {
        id: "implement",
        title: "继续实现",
        status: "进行中",
        waitingFor: "等待正式打包任务恢复现场",
        isBlocked: true,
        blockedBy: "等待正式打包任务恢复现场"
      },
      { id: "matching-tests", title: "完成匹配测试", status: "未开始" },
      { id: "package", title: "等待目标包", status: "未开始" }
    ]
  });

  const migrated = migrateLegacyPackageGatePlan(source, "2026-07-28T10:00:00.000Z");
  assert.equal(migrated?.action, "resume_running");
  assert.equal(migrated?.plan.status, "进行中");
  assert.equal(migrated?.plan.isBlocked, false);
  assert.equal(migrated?.plan.blockedBy, "");
  assert.equal(migrated?.plan.waitingFor, "");
  assert.equal(migrated?.plan.steps[0]?.waitingFor, "");
  assert.deepEqual(migrated?.plan.taskBinding, taskBinding);
  assert.equal(planIsWaitingForPackage(migrated!.plan), false);
});
