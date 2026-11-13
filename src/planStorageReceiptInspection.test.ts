import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitPlanLifecycleTransitionUnderLease,
  commitPlanStoragePackage,
  commitPlanStorageTransactionUnderLease,
  inspectPlanStorageMutationReceiptUnderLease,
  readCanonicalPlanStoragePackageUnderLease,
  withPlanStorageLease,
  type PlanStoragePackageFile
} from "./planStorageRepository.js";

function files(planId: string, requestId?: string, previousHistory?: Buffer): PlanStoragePackageFile[] {
  const plan = { id: planId, title: requestId ?? "original", status: "执行中", ...(requestId ? { storageMutationRequestId: requestId } : {}) };
  const history = Buffer.concat([previousHistory ?? Buffer.alloc(0), Buffer.from(JSON.stringify({ id: `history-${requestId ?? "create"}`, planId, after: plan }) + "\n")]);
  return [
    { path: "plan.json", content: Buffer.from(JSON.stringify(plan) + "\n") },
    { path: "history.jsonl", content: history }
  ].map(file => ({ ...file, size: file.content.length, sha256: createHash("sha256").update(file.content).digest("hex") }));
}
function fixture(t: test.TestContext) {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-receipt-inspect-")), planId = "receipt-plan";
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "original-create", kind: "plan-create", fromBucket: null, toBucket: "active", files: files(planId)
  }));
  const read = () => withPlanStorageLease(roleDir, planId, readCanonicalPlanStoragePackageUnderLease);
  const original = read();
  const inspect = (requestId = "original-request", expectedInventoryHash = original.inventoryHash) => withPlanStorageLease(roleDir, planId,
    lease => inspectPlanStorageMutationReceiptUnderLease(lease, { requestId, expectedInventoryHash }));
  const update = (requestId: string) => {
    const current = read(), history = current.files.find(file => file.path === "history.jsonl")!.content;
    return withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
      transactionId: "update-" + requestId, kind: "plan-update", fromBucket: "active", toBucket: "active", expectedSourceInventoryHash: current.inventoryHash,
      files: files(planId, requestId, history)
    }));
  };
  return { roleDir, planId, original, inspect, update, read };
}
function bytesBelow(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && !target.includes(`${path.sep}.locks${path.sep}`) && !target.endsWith(".lock")) result[path.relative(root, target)] = fs.readFileSync(target).toString("base64");
    }
  }
  visit(root); return result;
}
function inspectUnchanged(f: ReturnType<typeof fixture>, requestId = "original-request", expected = f.original.inventoryHash) {
  return withPlanStorageLease(f.roleDir, f.planId, lease => {
    const before = bytesBelow(f.roleDir);
    const result = inspectPlanStorageMutationReceiptUnderLease(lease, { requestId, expectedInventoryHash: expected });
    assert.deepEqual(bytesBelow(f.roleDir), before, "inspection must not publish, recover, delete or rewrite any file while holding the same lease");
    return result;
  });
}

test("unchanged original inventory with no prepared request proves precommit staging without writes", t => {
  const f = fixture(t);
  assert.deepEqual(inspectUnchanged(f), { state: "not_committed", stage: "precommit_staging", inventoryHash: f.original.inventoryHash });
});
test("the original history after result wins after a later legal plan revision", t => {
  const f = fixture(t); f.update("original-request"); f.update("later-request");
  const result = inspectUnchanged(f);
  assert.equal(result.state, "committed");
  if (result.state === "committed") { assert.equal(result.value.title, "original-request"); assert.equal(result.value.storageMutationRequestId, "original-request"); }
});
test("complete original history proves commit without an inventory anchor, while absence never proves failure", t => {
  const f = fixture(t);
  assert.equal(inspectUnchanged(f, "original-request", "").state, "unknown");
  assert.equal(inspectUnchanged(f, "original-request", "invalid-hash").state, "unknown");
  f.update("original-request");
  for (const expected of ["", "invalid-hash"]) {
    const result = inspectUnchanged(f, "original-request", expected);
    assert.equal(result.state, "committed");
    if (result.state === "committed") assert.equal(result.value.storageMutationRequestId, "original-request");
  }
});
test("a real prepared lifecycle WAL remains unknown and its source/payload are preserved", t => {
  const f = fixture(t), rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (String(source) === path.join(f.roleDir, "plans/active", f.planId) && path.basename(String(target)) === "previous") throw Object.assign(new Error("fixture before source publication"), { code: "EIO" });
    return rename(source, target);
  }) as typeof fs.renameSync);
  assert.throws(() => f.update("original-request"), /before source publication/);
  const result = inspectUnchanged(f); assert.equal(result.state, "unknown");
  if (result.state === "unknown") assert.match(result.reason, /Prepared lifecycle/);
});
test("an original unprepared candidate from the real staging path cannot publish and is preserved", t => {
  const f = fixture(t), rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (String(source).endsWith(".candidate") && path.basename(String(target)) === "payload") throw Object.assign(new Error("fixture incomplete payload publication"), { code: "EIO" });
    return rename(source, target);
  }) as typeof fs.renameSync);
  assert.throws(() => f.update("original-request"), /incomplete payload publication/);
  const result = inspectUnchanged(f); assert.equal(result.state, "not_committed");
  const root = path.join(f.roleDir, "plans/quarantine/plan-storage-lifecycle-transactions", f.planId, "update-original-request");
  assert.equal(fs.existsSync(path.join(root, "manifest.json")), false);
  assert.ok(fs.readdirSync(root).some(name => name.endsWith(".candidate")));
});
test("unreadable own WAL and changed inventory stay unknown, while a corrupt neighboring plan stays local", t => {
  const f = fixture(t), own = path.join(f.roleDir, "plans/quarantine/plan-storage-lifecycle-transactions", f.planId, "bad");
  const neighbor = path.join(f.roleDir, "plans/quarantine/plan-storage-lifecycle-transactions/neighbor/bad");
  fs.mkdirSync(neighbor, { recursive: true }); fs.writeFileSync(path.join(neighbor, "manifest.json"), "{invalid");
  assert.equal(inspectUnchanged(f).state, "not_committed");
  fs.mkdirSync(own, { recursive: true }); fs.writeFileSync(path.join(own, "manifest.json"), "{invalid");
  assert.equal(inspectUnchanged(f).state, "unknown"); fs.unlinkSync(path.join(own, "manifest.json"));
  f.update("different-request"); assert.equal(inspectUnchanged(f).state, "unknown");
});
test("bad canonical history and a mismatched lifecycle terminal receipt cannot prove failure", t => {
  const f = fixture(t), root = path.join(f.roleDir, "plans/quarantine/plan-storage-lifecycle-transactions", f.planId, "original-create");
  const file = path.join(root, "receipt.json"), original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original.toString()), planId: "different-plan" }));
  assert.equal(inspectUnchanged(f).state, "unknown"); fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.roleDir, "plans/active", f.planId, "history.jsonl"), "{invalid\n");
  assert.equal(inspectUnchanged(f).state, "unknown");
});

test("real repository manifests and terminal receipts are inspected without completing a prepared write", t => {
  const f = fixture(t), history = f.original.files.find(file => file.path === "history.jsonl")!.content;
  const commit = (transactionId: string) => withPlanStorageLease(f.roleDir, f.planId, lease => commitPlanStorageTransactionUnderLease(lease, {
    transactionId, kind: "plan-feedback", operations: [{ type: "replace-file", relativePath: "history.jsonl", content: history }],
  }));
  commit("terminal-repository"); assert.equal(inspectUnchanged(f).state, "not_committed");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (path.basename(String(target)) === "receipt.json" && path.basename(path.dirname(String(target))) === "prepared-repository") throw Object.assign(new Error("fixture terminal publication interrupted"), { code: "EIO" });
    return rename(source, target);
  }) as typeof fs.renameSync);
  assert.throws(() => commit("prepared-repository"), /terminal publication interrupted/);
  const result = inspectUnchanged(f); assert.equal(result.state, "unknown");
  if (result.state === "unknown") assert.match(result.reason, /Prepared repository/);
});

test("real package manifest/receipt identity stays local and orphan receipts remain unknown", t => {
  const f = fixture(t);
  const outcome = commitPlanStoragePackage({ roleDir: f.roleDir, planId: f.planId, storageId: f.planId, bucket: "active", transactionId: "terminal-package", inventoryHash: f.original.inventoryHash, files: f.original.files });
  assert.ok(outcome.receiptPath); assert.equal(inspectUnchanged(f).state, "not_committed");
  const receipt = outcome.receiptPath!, before = fs.readFileSync(receipt);
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(before.toString()), planId: "foreign" }));
  assert.equal(inspectUnchanged(f).state, "unknown"); fs.writeFileSync(receipt, before);
  const manifest = path.join(f.roleDir, "plans/quarantine/plan-storage-package-transactions", f.planId, "terminal-package", "manifest.json");
  fs.renameSync(manifest, manifest + ".evidence"); assert.equal(inspectUnchanged(f).state, "unknown");
});
