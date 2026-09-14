import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLAN_ACTIVATION_STATUSES, planActivationStatus, planCanAutoAdvance, planStateForWrite } from "./planState.js";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { createPlan, getPlan, updatePlan, migratePersonaPlanStatusesAtStartup, readPlansFromStorageInWorker, planApprovalGate } from "./roleKnowledge.js";
import { planJsonFile } from "./planStorageLayout.js";
import { presentPlan } from "./roleKnowledgePresentation.js";
import { summarizeRolePlan } from "./roleKnowledgePagination.js";

const input = { title: "状态分离", focus: "验证状态边界", keywords: ["state"], currentStepId: "check", steps: [{ id: "check", title: "验证", detail: "保留步骤" }] };

test("激活状态固定三项；暂停只属于标记，正文不参与自动推进判定", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = ensurePersonaPlanWorkflow(dir).workflow;
  assert.deepEqual(PLAN_ACTIVATION_STATUSES, ["进行中", "已完成", "已归档"]);
  assert.throws(() => planActivationStatus({ activationStatus: "暂停" }), /activationStatus/);
  assert.equal(planCanAutoAdvance({ activationStatus: "进行中", markerStatus: workflow.roles.paused }, workflow), false);
  assert.equal(planCanAutoAdvance({ activationStatus: "已完成", markerStatus: workflow.roles.analysis }, workflow), false);
  const plan = createPlan(dir, { ...input, activationStatus: "进行中", markerStatus: workflow.roles.analysis, currentStep: "历史正文提过暂停" });
  assert.equal(planCanAutoAdvance(plan, workflow), true);
  assert.equal(updatePlan(dir, plan.id, { markerStatus: workflow.roles.paused }).activationStatus, "进行中");
  const completed = updatePlan(dir, plan.id, { activationStatus: "已完成" });
  assert.equal(completed.markerStatus, workflow.roles.paused);
  assert.ok(completed.completedAt);
  assert.deepEqual(completed.steps, plan.steps);
  assert.equal(planApprovalGate(completed).state, "none");
  const remarked = updatePlan(dir, plan.id, { markerStatus: workflow.roles.analysis });
  assert.equal(remarked.activationStatus, "已完成");
  const summary = summarizeRolePlan(presentPlan(remarked, workflow));
  assert.equal(summary.activationStatus, "已完成");
  assert.equal(summary.markerStatus, workflow.roles.analysis);
  assert.deepEqual(summary.presentation.views, ["plans"]);
  const archived = updatePlan(dir, plan.id, { activationStatus: "已归档" });
  assert.equal(archived.markerStatus, workflow.roles.analysis);
  assert.equal(archived.archiveStatus, "已归档");
  assert.ok(archived.archivedAt);
  assert.equal(getPlan(dir, plan.id)?.activationStatus, "已归档");
  assert.throws(() => updatePlan(dir, plan.id, { activationStatus: "进行中" }), /immutable/);
});

test("新字段冲突拒绝；旧写入只经入口适配", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = ensurePersonaPlanWorkflow(dir).workflow;
  assert.throws(() => planStateForWrite({ markerStatus: "暂停", status: "分析中" }, undefined, workflow), /Conflicting/);
  assert.throws(() => planStateForWrite({ activationStatus: "进行中", archiveStatus: "已归档" }, undefined, workflow), /Conflicting/);
  assert.equal(planStateForWrite({ status: workflow.roles.completed }, undefined, workflow).activationStatus, "已完成");
  assert.equal(planStateForWrite({ markerStatus: workflow.roles.completed }, undefined, workflow).activationStatus, "进行中");
  assert.equal(planStateForWrite({ markerStatus: workflow.roles.completed, activationStatus: "进行中" }, undefined, workflow).activationStatus, "进行中");
});

test("旧状态一次迁移，保留暂停、任务绑定、附件与历史", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workflow = ensurePersonaPlanWorkflow(dir).workflow;
  const originals = [workflow.roles.paused, workflow.roles.completed, workflow.roles.closed].map((status, i) => {
    const p = createPlan(dir, { ...input, id: `legacy-${i}`, markerStatus: workflow.roles.paused,
      taskBinding: { agentType: "codex", sessionId: `task-${i}`, workspace: dir },
      attachments: [{ name: "evidence.txt", kind: "text", contentBase64: Buffer.from("保留附件").toString("base64") }] });
    const file = planJsonFile(dir, p.id, "active");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.activationStatus; delete raw.markerStatus;
    raw.status = status;
    fs.writeFileSync(file, JSON.stringify(raw));
    return p;
  });
  assert.deepEqual(migratePersonaPlanStatusesAtStartup(dir), { migrated: 3, failures: [] });
  assert.deepEqual(migratePersonaPlanStatusesAtStartup(dir), { migrated: 0, failures: [] });
  const plans = readPlansFromStorageInWorker(dir);
  for (let i = 0; i < originals.length; i++) {
    const p = plans.find(p => p.id === originals[i].id)!;
    assert.equal(p.activationStatus, PLAN_ACTIVATION_STATUSES[i]);
    assert.deepEqual(p.taskBinding, originals[i].taskBinding);
    assert.deepEqual(p.steps, originals[i].steps);
    assert.equal(p.attachments.length, originals[i].attachments.length);
    assert.equal(fs.readFileSync(p.attachments[0].path, "utf8"), "保留附件");
    assert.equal(p.markerStatus, [workflow.roles.paused, workflow.roles.completed, workflow.roles.closed][i]);
  }
});
