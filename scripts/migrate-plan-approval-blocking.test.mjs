import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve("scripts/migrate-plan-approval-blocking.mjs");

function runMigration(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function createRoleFixture() {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-approval-migration-"));
  const planFile = path.join(roleDir, "plans", "items", "active", "plan-approval.json");
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify({
    id: "plan-approval",
    title: "等待方案审批",
    focus: "确认是否执行当前方案",
    status: "进行中",
    currentStepId: "approve",
    currentStep: "等待负责人决定是否执行。",
    steps: [{ id: "approve", title: "等待方案审批", status: "进行中" }],
    waitingFor: "",
    isBlocked: false,
    blockedBy: "",
    updatedAt: "2026-07-27T00:00:00.000Z",
    keywords: ["审批"]
  }, null, 2)}\n`, "utf8");
  return { roleDir, planFile };
}

test("requires an explicit role directory instead of targeting private runtime data", () => {
  const result = runMigration([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required --role-dir/);
});

test("dry-run reports approval blocking without changing the plan", () => {
  const { roleDir, planFile } = createRoleFixture();
  const before = fs.readFileSync(planFile, "utf8");
  const result = runMigration([`--role-dir=${roleDir}`]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "dry-run");
  assert.equal(output.changedPlanCount, 1);
  assert.equal(output.missingApproverCount, 1);
  assert.equal(output.missingSourceCount, 1);
  assert.equal(fs.readFileSync(planFile, "utf8"), before);
});

test("apply backs up the plan and does not invent approval evidence", () => {
  const { roleDir, planFile } = createRoleFixture();
  const result = runMigration([`--role-dir=${roleDir}`, "--apply"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const migrated = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const approval = migrated.steps[0].approvalRequest;

  assert.equal(migrated.isBlocked, true);
  assert.match(migrated.blockedBy, /审批人待确认/);
  assert.equal(migrated.steps[0].isBlocked, true);
  assert.equal(approval.approver, undefined);
  assert.equal(approval.recommendation, undefined);
  assert.deepEqual(approval.alternatives, []);
  assert.equal(approval.requestedAt, undefined);
  assert.equal(approval.sourceMessageId, undefined);
  assert.equal(approval.feedbackId, undefined);
  assert.equal(approval.responseStatus, "pending");
  assert.equal(typeof output.backupRoot, "string");
  assert.equal(fs.existsSync(path.join(output.backupRoot, "plans", "items", "active", "plan-approval.json")), true);
});
