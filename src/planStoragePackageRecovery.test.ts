import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitPlanStoragePackage } from "./planStorageRepository.js";
import { recoverStoredPlanPackages } from "./planStoragePackageRecovery.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-package-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "roles", "Example");
  const planId = "pending-package";
  const plan = { id: planId, title: "Recovery", focus: "Preserve historical bytes", status: "执行中" };
  const files = [
    ["plan.json", JSON.stringify(plan)],
    ["history.jsonl", `${JSON.stringify({ id: "created", planId, kind: "created", after: plan })}\n`],
    ["attachments/evidence.txt", "historical evidence\n"]
  ].map(([filePath, text]) => {
    const content = Buffer.from(text);
    return { path: filePath, content, size: content.length, sha256: createHash("sha256").update(content).digest("hex") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const inventoryHash = createHash("sha256").update(JSON.stringify(files.map(file => [file.path, file.size, file.sha256]))).digest("hex");
  const transactionId = `persona_sync_active_${inventoryHash}`;
  const result = commitPlanStoragePackage({ roleDir, planId, storageId: planId, bucket: "active", inventoryHash, files, transactionId });
  assert.ok(result.receiptPath);
  const target = path.join(roleDir, "plans", "active", planId);
  const transactionRoot = path.join(roleDir, "plans", "quarantine", "plan-storage-package-transactions", planId, transactionId);
  return { roleDir, target, transactionRoot, receiptPath: result.receiptPath, inventoryHash };
}

for (const staged of [false, true]) {
  test(`startup recovers historical package without a codec (${staged ? "staged" : "published"} payload)`, t => {
    const data = fixture(t);
    if (staged) fs.renameSync(data.target, path.join(data.transactionRoot, "payload"));
    fs.unlinkSync(data.receiptPath);
    const recovered = recoverStoredPlanPackages(data.roleDir);
    assert.deepEqual(recovered.errors, []);
    assert.equal(recovered.results.length, 1);
    assert.equal(recovered.results[0].status, staged ? "applied" : "unchanged");
    assert.equal(recovered.results[0].inventoryHash, data.inventoryHash);
    assert.equal(fs.readFileSync(path.join(data.target, "attachments", "evidence.txt"), "utf8"), "historical evidence\n");
    assert.ok(fs.existsSync(data.receiptPath));
    assert.deepEqual(recoverStoredPlanPackages(data.roleDir).errors, []);
  });
}

test("incomplete historical payload remains on disk and fails recovery closed", t => {
  const data = fixture(t);
  const payload = path.join(data.transactionRoot, "payload");
  fs.renameSync(data.target, payload);
  fs.unlinkSync(data.receiptPath);
  fs.writeFileSync(path.join(payload, "attachments", "evidence.txt"), "incomplete");
  const recovered = recoverStoredPlanPackages(data.roleDir);
  assert.equal(recovered.errors.length, 1);
  assert.match(recovered.errors[0].message, /incomplete or changed/);
  assert.ok(fs.existsSync(path.join(data.transactionRoot, "manifest.json")));
  assert.equal(fs.readFileSync(path.join(payload, "attachments", "evidence.txt"), "utf8"), "incomplete");
  assert.equal(fs.existsSync(data.receiptPath), false);
});
