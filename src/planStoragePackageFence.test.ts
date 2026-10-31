import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePlanStoragePackageRecoveryConflicts, capturePlanStoragePackageRecoveryConflictsAsync } from "./planStoragePackageFence.js";

function fixture(t: test.TestContext) {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-package-fence-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  return roleDir;
}

test("batch fence reuses unchanged metadata bytes and detects an edited receipt", { concurrency: false }, t => {
  const roleDir = fixture(t);
  const receiptPaths: string[] = [];
  for (let index = 0; index < 50; index++) {
    const planId = `plan-${index}`;
    const transactionId = "tx";
    const identity = { planId, storageId: planId, transactionId, bucket: "active", inventoryHash: "a".repeat(64), specHash: "b".repeat(64) };
    const manifestPath = path.join(roleDir, "plans/quarantine/plan-storage-package-transactions", planId, transactionId, "manifest.json");
    const receipt = path.join(roleDir, "plans/quarantine/plan-storage-package-receipts", planId, `${transactionId}.json`);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, kind: "plan_storage_package_transaction", status: "prepared", ...identity }));
    fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, kind: "plan_storage_package_commit", status: "applied", ...identity }));
    receiptPaths.push(receipt);
  }
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { reads++; return original(...args); }) as typeof fs.readFileSync;
  try {
    assert.deepEqual(capturePlanStoragePackageRecoveryConflicts(roleDir), { conflicts: [], unknown: [] });
    assert.equal(reads, 100);
    assert.deepEqual(capturePlanStoragePackageRecoveryConflicts(roleDir), { conflicts: [], unknown: [] });
    assert.equal(reads, 100);
    fs.writeFileSync(receiptPaths[25], "{}");
    const changed = capturePlanStoragePackageRecoveryConflicts(roleDir);
    assert.equal(changed.conflicts.length, 1);
    assert.equal(changed.conflicts[0].planId, "plan-25");
    assert.equal(reads, 101);
  } finally { fs.readFileSync = original; }
});

test("async fence cancellation does not wait for a hung directory read", { concurrency: false }, async t => {
  const roleDir = fixture(t);
  const original = fs.promises.readdir;
  const controller = new AbortController();
  fs.promises.readdir = (() => new Promise<never>(() => {})) as typeof fs.promises.readdir;
  try {
    const pending = capturePlanStoragePackageRecoveryConflictsAsync(roleDir, undefined, controller.signal);
    controller.abort(new Error("fence request cancelled"));
    await assert.rejects(pending, /fence request cancelled/);
  } finally { fs.promises.readdir = original; }
});
