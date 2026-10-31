import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPlan, getPlan, getPlanAsync, listPlans, listPlansAsync, getPublishedPlan, publishedRolePlans,
  readPlansFromStorageInWorker, readRoleKnowledgeCatalogSnapshot, publishRoleKnowledgeCatalogSnapshot,
  publishedRolePlanPackageRecoverySnapshot, readPlanPageCatalogInWorker, clearPlanCatalogAfterStartupMigration
} from "./roleKnowledge.js";
import { canonicalPlanStorageKey } from "./planStorageIdentity.js";
import { planReadFence } from "./planReadInvalidation.js";

test("known package conflicts fence one plan across physical and published reads while normal plans remain available", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-package-read-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ["normal", "blocked"]) createPlan(root, {
    id, title: id, focus: "Fixture plan", status: "分析中", currentStepId: "inspect",
    steps: [{ id: "inspect", title: "Inspect", status: "进行中" }], keywords: ["fixture"]
  });
  // Warm before the conflict appears, so cached single reads cannot escape the fence.
  readPlansFromStorageInWorker(root);
  const storageId = canonicalPlanStorageKey("blocked");
  const transaction = path.join(root, "plans", "quarantine", "plan-storage-package-transactions", storageId, "fixture-tx");
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(path.join(transaction, "manifest.json"), JSON.stringify({
    schemaVersion: 1, kind: "plan_storage_package_transaction", status: "prepared", planId: "blocked", storageId,
    transactionId: "fixture-tx", bucket: "active", inventoryHash: "a".repeat(64), specHash: "b".repeat(64)
  }));
  clearPlanCatalogAfterStartupMigration(root);
  assert.throws(() => getPlan(root, "blocked"), { code: "PLAN_STORAGE_PACKAGE_RECOVERY_PENDING" },
    "a physical fallback must inspect the transaction even before its recovery snapshot is published");
  // A worker/startup publication carries cross-process recovery state into pure in-memory readers.
  assert.deepEqual(readPlansFromStorageInWorker(root).map(item => item.id), ["normal"]);
  const pending = { code: "PLAN_STORAGE_PACKAGE_RECOVERY_PENDING" };
  assert.throws(() => getPlan(root, "blocked"), pending);
  await assert.rejects(getPlanAsync(root, "blocked"), pending);
  assert.equal(getPlan(root, "normal")?.id, "normal");
  assert.deepEqual(readPlansFromStorageInWorker(root).map(item => item.id), ["normal"]);
  assert.deepEqual((await listPlansAsync(root, { watch: false })).map(item => item.id), ["normal"]);
  assert.deepEqual((await readPlanPageCatalogInWorker(root, planReadFence(root))).map(item => item.id), ["normal"]);
  assert.equal(publishedRolePlanPackageRecoverySnapshot(root)?.conflicts[0].planId, "blocked");
  publishRoleKnowledgeCatalogSnapshot(root, readRoleKnowledgeCatalogSnapshot(root));
  const originalRead = fs.readFileSync;
  const originalList = fs.readdirSync;
  try {
    fs.readFileSync = (() => { throw new Error("hot path touched storage"); }) as typeof fs.readFileSync;
    fs.readdirSync = (() => { throw new Error("hot path enumerated storage"); }) as typeof fs.readdirSync;
    assert.deepEqual(listPlans(root).map(item => item.id), ["normal"]);
    assert.deepEqual(publishedRolePlans(root)?.map(item => item.id), ["normal"]);
    assert.throws(() => getPublishedPlan(root, "blocked"), pending);
    assert.throws(() => getPlan(root, "blocked"), pending);
    assert.equal(getPublishedPlan(root, "normal")?.id, "normal");
    assert.equal(getPlan(root, "normal")?.id, "normal");
  } finally { fs.readFileSync = originalRead; fs.readdirSync = originalList; }
  // Resolve only this fixture's transaction and verify the next authoritative read restores availability.
  fs.rmSync(transaction, { recursive: true });
  assert.deepEqual(readPlansFromStorageInWorker(root).map(item => item.id).sort(), ["blocked", "normal"]);
  assert.equal(getPlan(root, "blocked")?.id, "blocked");
});

test("unattributable package recovery failures reject a catalog instead of reporting a successful empty page", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-package-unknown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "plans", "quarantine", "plan-storage-package-transactions", "unknown", "fixture-tx");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "manifest.json"), "{bad");
  assert.throws(() => readPlansFromStorageInWorker(root), { code: "PLAN_STORAGE_PACKAGE_RECOVERY_PENDING" });
  await assert.rejects(listPlansAsync(root), { code: "PLAN_STORAGE_PACKAGE_RECOVERY_PENDING" });
  assert.equal(publishedRolePlanPackageRecoverySnapshot(root)?.unknown.length, 1);
});
