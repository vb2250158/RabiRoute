import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitPlanLifecycleTransitionUnderLease,
  readCanonicalPlanStoragePackageUnderLease,
  recoverPlanLifecycleTransitions,
  withPlanStorageLease,
  type PlanStoragePackageFile
} from "./planStorageRepository.js";

function packageFile(filePath: string, content: string): PlanStoragePackageFile {
  const bytes = Buffer.from(content, "utf8");
  return {
    path: filePath,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content: bytes
  };
}

function revision(planId: string, status: "进行中" | "已完成" | "已归档", sequence: number): PlanStoragePackageFile[] {
  const plan = {
    id: planId,
    title: "Lifecycle snapshot",
    focus: "Publish one complete plan revision",
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `2026-09-01T00:0${sequence}:00.000Z`,
    ...(status === "已完成" || status === "已归档"
      ? { completedAt: "2026-09-01T00:01:00.000Z" }
      : {}),
    ...(status === "已归档" ? { archivedAt: "2026-09-01T00:02:00.000Z" } : {})
  };
  const history = Array.from({ length: sequence }, (_, index) => JSON.stringify({
    id: `${planId}-history-${index + 1}`,
    planId,
    kind: index === sequence - 1 && status === "已归档" ? "archived" : index ? "updated" : "created",
    recordedAt: plan.updatedAt,
    after: plan
  })).join("\n") + "\n";
  return [
    packageFile("attachments/manifest.json", `${JSON.stringify({ kind: "business_attachment_manifest", planId })}\n`),
    packageFile("history.jsonl", history),
    packageFile("plan.json", `${JSON.stringify(plan, null, 2)}\n`)
  ];
}

test("lifecycle repository publishes complete create, update, and archive snapshots and recovers a missing receipt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-lifecycle-repository-"));
  const roleDir = path.join(root, "roles", "YeYu");
  const planId = "lifecycle-final-snapshot";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const created = withPlanStorageLease(roleDir, planId, lease =>
    commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: "create_revision_1",
      kind: "plan-create",
      fromBucket: null,
      toBucket: "active",
      files: revision(planId, "进行中", 1)
    })
  );
  assert.equal(created.status, "committed");

  const active = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const updated = withPlanStorageLease(roleDir, planId, lease =>
    commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: "update_revision_2",
      kind: "plan-update",
      fromBucket: "active",
      toBucket: "active",
      expectedSourceInventoryHash: active.inventoryHash,
      files: revision(planId, "已完成", 2)
    })
  );
  assert.equal(updated.status, "committed");

  const completed = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const archived = withPlanStorageLease(roleDir, planId, lease =>
    commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: "archive_revision_3",
      kind: "plan-archive",
      fromBucket: "active",
      toBucket: "archive",
      expectedSourceInventoryHash: completed.inventoryHash,
      files: revision(planId, "已归档", 3)
    })
  );
  assert.equal(archived.status, "committed");
  assert.equal(fs.existsSync(path.join(roleDir, "plans", "active", planId)), false);
  assert.equal(fs.existsSync(path.join(roleDir, "plans", "archive", planId, "plan.json")), true);

  fs.unlinkSync(archived.receiptPath);
  const recovery = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(recovery.failures, []);
  assert.equal(recovery.results.length, 1);
  assert.equal(recovery.results[0]?.status, "committed");
  assert.equal(fs.existsSync(archived.receiptPath), true);
});
