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

function revision(planId: string, status: "执行中" | "完成", sequence: number): PlanStoragePackageFile[] {
  const archived = sequence === 3;
  const plan = {
    id: planId,
    title: "Lifecycle snapshot",
    focus: "Publish one complete plan revision",
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: `2026-09-01T00:0${sequence}:00.000Z`,
    ...(status === "完成"
      ? { completedAt: "2026-09-01T00:01:00.000Z" }
      : {}),
    ...(archived ? { archiveStatus: "已归档", archivedAt: "2026-09-01T00:02:00.000Z" } : {})
  };
  const history = Array.from({ length: sequence }, (_, index) => JSON.stringify({
    id: `${planId}-history-${index + 1}`,
    planId,
    kind: index === sequence - 1 && archived ? "archived" : index ? "updated" : "created",
    recordedAt: plan.updatedAt,
    after: plan
  })).join("\n") + "\n";
  return [
    packageFile("attachments/manifest.json", `${JSON.stringify({ kind: "business_attachment_manifest", planId })}\n`),
    packageFile("history.jsonl", history),
    packageFile("plan.json", `${JSON.stringify(plan, null, 2)}\n`)
  ];
}

test("scoped lifecycle recovery leaves another plan's incomplete and corrupt transactions untouched", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-scope-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const planId = "other-plan";
  const created = withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "scope_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision(planId, "执行中", 1)
  }));
  fs.unlinkSync(created.receiptPath);
  const manifestPath = path.join(path.dirname(created.receiptPath), "manifest.json");
  const manifest = fs.readFileSync(manifestPath);
  assert.deepEqual(recoverPlanLifecycleTransitions(roleDir, { planId: "request-plan" }), { results: [], abandoned: [], failures: [] });
  assert.equal(fs.existsSync(created.receiptPath), false);
  fs.writeFileSync(manifestPath, "invalid-json");
  assert.deepEqual(recoverPlanLifecycleTransitions(roleDir, { planId: "request-plan" }), { results: [], abandoned: [], failures: [] });
  assert.equal(recoverPlanLifecycleTransitions(roleDir).failures.length, 1);
  fs.writeFileSync(manifestPath, manifest);
  const recovery = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(recovery.failures, []);
  assert.equal(recovery.results.length, 1);
  assert.equal(fs.existsSync(created.receiptPath), true);
});

test("scoped lifecycle recovery rejects another plan manifest inside the request plan directory", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-scope-mismatch-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const created = withPlanStorageLease(roleDir, "other-plan", lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "scope_mismatch", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision("other-plan", "执行中", 1)
  }));
  const otherTransaction = path.dirname(created.receiptPath);
  const misplaced = path.join(path.dirname(path.dirname(otherTransaction)), "request-plan", "scope_mismatch");
  fs.mkdirSync(misplaced, { recursive: true });
  fs.cpSync(otherTransaction, misplaced, { recursive: true });
  fs.unlinkSync(path.join(misplaced, "receipt.json"));
  const before = withPlanStorageLease(roleDir, "other-plan", lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const recovered = recoverPlanLifecycleTransitions(roleDir, { planId: "request-plan" });
  assert.equal(recovered.results.length, 0);
  assert.equal(recovered.failures.length, 1);
  assert.match(recovered.failures[0]!.error, /scope mismatch/);
  assert.equal(fs.existsSync(path.join(misplaced, "receipt.json")), false);
  assert.deepEqual(withPlanStorageLease(roleDir, "other-plan", lease => readCanonicalPlanStoragePackageUnderLease(lease)), before);
});

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
      files: revision(planId, "执行中", 1)
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
      files: revision(planId, "完成", 2)
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
      files: revision(planId, "完成", 3)
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

test("lifecycle recovery retires a prepared transition the plan has advanced past, keeping its evidence", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-superseded-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const planId = "superseded-transition";

  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "superseded_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision(planId, "执行中", 1)
  }));

  // Prepare the update, then drop its receipt so it reads as an interrupted transition.
  const first = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const interrupted = withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "superseded_update", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: first.inventoryHash, files: revision(planId, "完成", 2)
  }));
  // Drop the receipt and any published rollback copy so the transaction reads as
  // prepared-but-interrupted: payload staged, source never moved aside.
  fs.unlinkSync(interrupted.receiptPath);
  const transactionRoot = path.dirname(interrupted.receiptPath);
  fs.rmSync(path.join(transactionRoot, "previous"), { recursive: true, force: true });
  const manifestBefore = fs.readFileSync(path.join(transactionRoot, "manifest.json"), "utf8");

  // A later committed write moves the same bucket past both recorded snapshots.
  const second = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "superseded_update_2", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: second.inventoryHash, files: revision(planId, "执行中", 2)
  }));

  const recovery = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(recovery.failures, []);
  assert.deepEqual(recovery.results, []);
  assert.equal(recovery.abandoned.length, 1);
  assert.equal(recovery.abandoned[0]?.transactionId, "superseded_update");
  assert.match(String(recovery.abandoned[0]?.observedInventoryHash), /^[a-f0-9]{64}$/);

  // Retirement never rewrites the prepared evidence: the manifest stays byte-identical
  // and the receipt records both snapshots plus what was actually observed.
  assert.equal(fs.readFileSync(path.join(transactionRoot, "manifest.json"), "utf8"), manifestBefore);
  const receipt = JSON.parse(fs.readFileSync(interrupted.receiptPath, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.status, "abandoned");
  assert.equal(receipt.expectedSourceInventoryHash, first.inventoryHash);
  assert.equal(receipt.finalInventoryHash, interrupted.inventoryHash);
  // Retirement only happens when the observed content matches neither snapshot.
  assert.notEqual(receipt.observedInventoryHash, receipt.finalInventoryHash);
  assert.notEqual(receipt.observedInventoryHash, receipt.expectedSourceInventoryHash);
  assert.match(String(receipt.reason), /neither be replayed nor rolled back/);

  // The retirement receipt short-circuits later recoveries instead of failing again.
  const repeated = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(repeated.abandoned, []);
  assert.deepEqual(repeated.failures, []);
  assert.deepEqual(repeated.results, []);
});

test("lifecycle recovery retires a superseded transition that had already published its source aside", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-superseded-published-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const planId = "superseded-published";

  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "published_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision(planId, "执行中", 1)
  }));

  const first = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const interrupted = withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "published_update", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: first.inventoryHash, files: revision(planId, "完成", 2)
  }));
  // Keep the published rollback copy: this is the shape where the interrupted
  // transition had already moved its source aside, so the target is occupied.
  fs.unlinkSync(interrupted.receiptPath);
  const transactionRoot = path.dirname(interrupted.receiptPath);
  assert.equal(fs.existsSync(path.join(transactionRoot, "previous")), true);

  const second = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "published_update_2", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: second.inventoryHash, files: revision(planId, "执行中", 2)
  }));

  const recovery = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(recovery.failures, []);
  assert.equal(recovery.abandoned.length, 1);
  assert.equal(recovery.abandoned[0]?.transactionId, "published_update");
  const receipt = JSON.parse(fs.readFileSync(interrupted.receiptPath, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.status, "abandoned");
  assert.notEqual(receipt.observedInventoryHash, receipt.finalInventoryHash);
  assert.notEqual(receipt.observedInventoryHash, receipt.expectedSourceInventoryHash);
});

test("lifecycle recovery still commits an interrupted transition whose source snapshot is unchanged", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-replayable-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const planId = "replayable-transition";

  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "replayable_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision(planId, "执行中", 1)
  }));
  const first = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const interrupted = withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "replayable_update", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: first.inventoryHash, files: revision(planId, "完成", 2)
  }));
  fs.unlinkSync(interrupted.receiptPath);

  const recovery = recoverPlanLifecycleTransitions(roleDir);
  assert.deepEqual(recovery.failures, []);
  assert.deepEqual(recovery.abandoned, []);
  assert.equal(recovery.results.length, 1);
  assert.equal(recovery.results[0]?.status, "committed");
  assert.equal(recovery.results[0]?.inventoryHash, interrupted.inventoryHash);
  const current = withPlanStorageLease(roleDir, planId, lease => readCanonicalPlanStoragePackageUnderLease(lease));
  assert.equal(current.inventoryHash, interrupted.inventoryHash);
});
