import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migratePackageWaitingPlans } from "./planPackageMigration.js";

function writePlan(roleDir: string, fileName: string, plan: Record<string, unknown>): string {
  const file = path.join(roleDir, "plans", "items", "active", fileName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
  return file;
}

function packageSteps(currentId = "package") {
  return [
    {
      id: "implement",
      title: "完成 Main / Release 实现",
      ...(currentId === "implement" ? {} : { completedAt: "2026-07-28T00:00:00.000Z" })
    },
    {
      id: "matching-tests",
      title: "完成双分支目标测试 3/3",
      detail: "Main→Release 已同步，Art 不适用；SVN 提交 r224818；无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *。",
      ...(currentId === "implement" ? {} : { completedAt: "2026-07-28T00:00:00.000Z" })
    },
    { id: "package", title: "等待目标包产物", waitingFor: currentId === "package" ? "等待目标包身份与进包结果" : "" }
  ];
}

test("bulk package-gate migration is dry-run by default, preserves task bindings, and is idempotent", (t) => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-package-migration-"));
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  const roleDir = path.join(rolesRoot, "Rabi");
  const legacyBlocker = "等待正式打包任务恢复 Main/Release/Art 现场；当前禁止任何 Unity、SVN、测试、构建、上传、发布或 QA 推进。";
  const readyFile = writePlan(roleDir, "ready.json", {
    id: "ready",
    title: "Ready for package",
    focus: "Ready for package",
    status: "进行中",
    currentStepId: "package",
    waitingFor: "等待目标包身份",
    isBlocked: true,
    blockedBy: legacyBlocker,
    attachments: [],
    steps: packageSteps(),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    keywords: []
  });
  const taskBinding = {
    agentType: "codex",
    sessionId: "019fa319-25c6-78a0-9364-b0a4ffe8dc4c",
    sessionTitle: "Original business task",
    workspace: "C:/Projects/Example"
  };
  const unfinishedFile = writePlan(roleDir, "unfinished.json", {
    id: "unfinished",
    title: "Unfinished",
    focus: "Unfinished",
    status: "进行中",
    currentStepId: "implement",
    currentStep: "继续实现并完成匹配测试",
    waitingFor: "等待正式打包任务恢复现场",
    isBlocked: true,
    blockedBy: legacyBlocker,
    taskBinding,
    attachments: [],
    steps: packageSteps("implement"),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    keywords: []
  });
  writePlan(roleDir, "plan-1784037085080.json", {
    id: "plan-1784037085080",
    title: "Main r224817 / Release r224818",
    focus: "Target package acceptance",
    status: "进行中",
    currentStepId: "package",
    waitingFor: "用户今晚开始打包并由原统一打包任务返回含 r224818 与目标包身份。",
    isBlocked: false,
    blockedBy: "",
    attachments: [],
    steps: packageSteps(),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    keywords: []
  });

  const readyBefore = fs.readFileSync(readyFile, "utf8");
  const dryRun = migratePackageWaitingPlans({ rolesRoot, apply: false, now: "2026-07-28T10:00:00.000Z" });
  assert.equal(dryRun.changedPlanCount, 2);
  assert.equal(dryRun.waitingPackagePlanCount, 1);
  assert.equal(fs.readFileSync(readyFile, "utf8"), readyBefore);

  const applied = migratePackageWaitingPlans({ rolesRoot, apply: true, now: "2026-07-28T10:00:00.000Z" });
  assert.equal(applied.changedPlanCount, 2);
  assert.equal(applied.waitingPackagePlanCount, 1);
  assert.equal(typeof applied.backupRoot, "string");
  const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
  const unfinished = JSON.parse(fs.readFileSync(unfinishedFile, "utf8"));
  assert.equal(ready.isBlocked, false);
  assert.equal(unfinished.isBlocked, false);
  assert.equal(unfinished.waitingFor, "");
  assert.deepEqual(unfinished.taskBinding, taskBinding);

  const secondApply = migratePackageWaitingPlans({ rolesRoot, apply: true, now: "2026-07-28T11:00:00.000Z" });
  assert.equal(secondApply.changedPlanCount, 0);
  assert.equal(secondApply.waitingPackagePlanCount, 1);
  assert.equal(secondApply.backupRoot, null);
});
