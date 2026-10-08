import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPlanStoragePackage, withPlanStorageLease, commitPlanLifecycleTransitionUnderLease, commitPlanStorageTransactionUnderLease, recoverPlanStorageTransactions, type PlanStoragePackageFile } from "./planStorageRepository.js";
import { archivedPlanDirectoryDominatesActive, validateCanonicalActivePlanDirectory, validateCanonicalArchivedPlanDirectory } from "./planStoragePolicy.js";
import { canonicalizeRolePlanStorageDirectories, inspectPlanStorageConflict } from "./planStorageReconciliation.js";
import { readPlanHistoryDirectory } from "./planHistoryShards.js";

const id = "history-shards-test";
const createdAt = "2026-09-01T00:00:00.000Z";
const activePlan = { id, status: "完成", createdAt, updatedAt: "2026-09-01T01:00:00.000Z", completedAt: "2026-09-01T01:00:00.000Z" };
const archivePlan = { ...activePlan, archiveStatus: "已归档", updatedAt: "2026-09-02T01:00:00.000Z", archivedAt: "2026-09-02T01:00:00.000Z" };
const created = `${JSON.stringify({ id: "created", planId: id, kind: "created", after: activePlan })}\n`;
const archived = `${JSON.stringify({ id: "archived", planId: id, kind: "archived", before: activePlan, after: archivePlan })}\n`;

function fixture(t: { after: (callback: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-history-shards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "role");
  const active = path.join(roleDir, "plans", "active", id);
  const archive = path.join(roleDir, "plans", "archive", id);
  for (const [directory, plan] of [[active, activePlan], [archive, archivePlan]] as const) {
    fs.mkdirSync(path.join(directory, "history"), { recursive: true });
    fs.writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan));
    fs.writeFileSync(path.join(directory, "history.jsonl"), created);
  }
  fs.writeFileSync(path.join(archive, "history", "000001.jsonl"), archived);
  return { roleDir, active, archive };
}

function packageFile(filePath: string, content: string): PlanStoragePackageFile {
  const bytes = Buffer.from(content);
  return { path: filePath, content: bytes, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("history reader refuses a dangling shard directory link rather than hiding records", (t) => {
  const { active } = fixture(t);
  const shardDirectory = path.join(active, "history");
  const missing = path.join(active, "missing-shards");
  let linkType: "dir" | "junction" = "dir";
  const probe = path.join(active, "probe-link");
  try {
    fs.symlinkSync(missing, probe, linkType);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    linkType = "junction";
    try {
      fs.symlinkSync(missing, probe, linkType);
    } catch (junctionError) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes((junctionError as NodeJS.ErrnoException).code || "")) throw junctionError;
      t.skip("Host cannot create directory links or junctions.");
      return;
    }
  }
  fs.unlinkSync(probe);
  fs.rmdirSync(shardDirectory);
  fs.symlinkSync(missing, shardDirectory, linkType);
  assert.throws(() => readPlanHistoryDirectory(active), /Invalid plan history/);
  assert.deepEqual([...readPlanHistoryDirectory(path.join(active, "absent-owner"))], []);
});

test("repository reads ordered shards and rejects gaps, empty base, partial rows and identity mismatch", (t) => {
  const { roleDir, active, archive } = fixture(t);
  fs.rmSync(active, { recursive: true });
  assert.deepEqual(readPlanStoragePackage(roleDir, id, "archive").files.map(file => file.path), ["history.jsonl", "history/000001.jsonl", "plan.json"]);
  const shard = path.join(archive, "history", "000001.jsonl");
  const base = path.join(archive, "history.jsonl");
  const assertRejected = (mutate: () => void, restore: () => void) => {
    mutate();
    try { assert.throws(() => readPlanStoragePackage(roleDir, id, "archive")); }
    finally { restore(); }
  };
  assertRejected(() => fs.renameSync(shard, path.join(archive, "history", "000002.jsonl")), () => fs.renameSync(path.join(archive, "history", "000002.jsonl"), shard));
  assertRejected(() => fs.writeFileSync(base, ""), () => fs.writeFileSync(base, created));
  fs.writeFileSync(base, created.trimEnd());
  assert.deepEqual(readPlanStoragePackage(roleDir, id, "archive").files.map(file => file.path), ["history.jsonl", "history/000001.jsonl", "plan.json"]);
  fs.writeFileSync(base, created);
  assertRejected(() => fs.writeFileSync(base, created.slice(0, -2)), () => fs.writeFileSync(base, created));
  assertRejected(() => fs.writeFileSync(shard, archived.trimEnd()), () => fs.writeFileSync(shard, archived));
  assertRejected(() => fs.writeFileSync(shard, `${JSON.stringify({ id: "bad", planId: "other" })}\n`), () => fs.writeFileSync(shard, archived));
  assertRejected(() => fs.writeFileSync(shard, "\n"), () => fs.writeFileSync(shard, archived));
  assertRejected(() => fs.writeFileSync(path.join(archive, "history", "unexpected.jsonl"), archived), () => fs.unlinkSync(path.join(archive, "history", "unexpected.jsonl")));
});

test("feedback transaction refuses projected 96 MiB package before staging any operation", (t) => {
  const { roleDir, active } = fixture(t);
  fs.rmSync(path.join(roleDir, "plans", "archive"), { recursive: true });
  const before = fs.readFileSync(path.join(active, "history.jsonl"));
  const large = Buffer.alloc(16 * 1024 * 1024 - 1, "x");
  const operations = Array.from({ length: 6 }, (_, index) => ({
    type: "replace-file" as const,
    relativePath: index === 0 ? "feedback.jsonl" : `attachments/${index}.bin`,
    content: large
  }));
  assert.throws(() => withPlanStorageLease(roleDir, id, lease => commitPlanStorageTransactionUnderLease(lease, {
    transactionId: "oversize_feedback_package", kind: "plan-feedback", operations
  })), /Plan storage package is too large/);
  assert.deepEqual(fs.readFileSync(path.join(active, "history.jsonl")), before);
  assert.equal(fs.existsSync(path.join(active, "feedback.jsonl")), false);
  assert.equal(fs.existsSync(path.join(roleDir, "plans", "quarantine", "plan-storage-transactions")), false);
});

test("published feedback attachment directory survives interrupted transaction recovery", (t) => {
  const { roleDir, active } = fixture(t);
  fs.rmSync(path.join(roleDir, "plans", "archive"), { recursive: true });
  const spec = {
    transactionId: "published_feedback_directory", kind: "plan-feedback" as const,
    operations: [
      { type: "publish-directory" as const, relativePath: "attachments/evidence", files: [{ relativePath: "item.txt", content: Buffer.from("evidence") }] },
      { type: "replace-file" as const, relativePath: "feedback.jsonl", content: Buffer.from("{\"id\":\"feedback\"}\n") }
    ],
    hooks: { afterOperation(index: number) { if (index === 0) throw new Error("injected interruption"); } }
  };
  assert.throws(() => withPlanStorageLease(roleDir, id, lease => commitPlanStorageTransactionUnderLease(lease, spec)), /injected interruption/);
  assert.equal(fs.readFileSync(path.join(active, "attachments", "evidence", "item.txt"), "utf8"), "evidence");
  assert.equal(fs.existsSync(path.join(active, "feedback.jsonl")), false);
  const result = recoverPlanStorageTransactions(roleDir, { kind: "plan-feedback", planId: id });
  assert.deepEqual(result.failures, []);
  assert.equal(result.committed, 1);
  assert.equal(fs.readFileSync(path.join(active, "feedback.jsonl"), "utf8"), "{\"id\":\"feedback\"}\n");
  assert.equal(recoverPlanStorageTransactions(roleDir, { kind: "plan-feedback", planId: id }).alreadyCommitted, 1);
});

test("feedback transaction refuses directory root overlap with another target", (t) => {
  const { roleDir, active } = fixture(t);
  fs.rmSync(path.join(roleDir, "plans", "archive"), { recursive: true });
  const operations = [
    { type: "publish-directory" as const, relativePath: "attachments/evidence", files: [{ relativePath: "item.txt", content: Buffer.from("evidence") }] },
    { type: "replace-file" as const, relativePath: "attachments/evidence/other.txt", content: Buffer.from("other") }
  ];
  assert.throws(() => withPlanStorageLease(roleDir, id, lease => commitPlanStorageTransactionUnderLease(lease, {
    transactionId: "overlapping_feedback_directory", kind: "plan-feedback", operations
  })), /overlapping targets/);
  assert.equal(fs.existsSync(path.join(active, "attachments")), false);
  assert.throws(() => withPlanStorageLease(roleDir, id, lease => commitPlanStorageTransactionUnderLease(lease, {
    transactionId: "reverse_overlapping_feedback_directory", kind: "plan-feedback", operations: [...operations].reverse()
  })), /overlapping targets/);
});

test("repository lifecycle accepts multiple complete physical shards", (t) => {
  const { roleDir } = fixture(t);
  const planId = "shard-lifecycle";
  const plan = { id: planId, status: "执行中" };
  const files = [packageFile("plan.json", JSON.stringify(plan)), packageFile("history.jsonl", `${JSON.stringify({ id: "one", planId })}\n`), packageFile("history/000001.jsonl", `${JSON.stringify({ id: "two", planId })}\n`)];
  const result = withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, { transactionId: "create_shards", kind: "plan-create", fromBucket: null, toBucket: "active", files }));
  assert.equal(result.status, "committed");
  assert.equal(readPlanStoragePackage(roleDir, planId, "active").files.length, 3);
});

test("policy validates cross-shard history and ignores physical shard boundaries when proving dominance", (t) => {
  const { roleDir, active, archive } = fixture(t);
  validateCanonicalActivePlanDirectory(active, id);
  validateCanonicalArchivedPlanDirectory(archive, id);
  assert.equal(inspectPlanStorageConflict(roleDir, id).status, "reconcilable");
  assert.equal(archivedPlanDirectoryDominatesActive(active, archive, id), true);
  fs.writeFileSync(path.join(active, "history", "000001.jsonl"), `${JSON.stringify({ id: "active-extra", planId: id, kind: "updated", after: activePlan })}\n`);
  assert.equal(inspectPlanStorageConflict(roleDir, id).status, "conflict");
});

test("name canonicalization refuses a missing shard before moving the legacy directory", (t) => {
  const { roleDir, active } = fixture(t);
  fs.rmSync(path.join(roleDir, "plans", "archive"), { recursive: true });
  const legacy = path.join(path.dirname(active), "History-Shards-Test");
  fs.renameSync(active, legacy);
  fs.mkdirSync(path.join(legacy, "history"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "history", "000002.jsonl"), archived);
  const result = canonicalizeRolePlanStorageDirectories(roleDir);
  assert.equal(result.migrated, 0);
  assert.match(result.failures[0]?.error || "", /missing or duplicated/);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.readdirSync(path.dirname(active)).some(name => name === "History-Shards-Test"), true);
});

test("name canonicalization rewrites absolute paths in every history shard", (t) => {
  const { roleDir, active } = fixture(t);
  fs.rmSync(path.join(roleDir, "plans", "archive"), { recursive: true });
  const legacy = path.join(path.dirname(active), "History-Shards-Test");
  fs.renameSync(active, legacy);
  const referenced = path.join(legacy, "attachments", "item.txt");
  for (const relative of ["history.jsonl", "history/000001.jsonl", "history/000002.jsonl"]) {
    const target = path.join(legacy, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ id: relative, planId: id, after: activePlan, path: referenced })}\n`);
  }
  const migrated = canonicalizeRolePlanStorageDirectories(roleDir);
  assert.deepEqual(migrated.failures, []);
  assert.equal(migrated.migrated, 1);
  const shardDir = path.join(active, "history");
  const physicalFiles = ["history.jsonl", ...(fs.existsSync(shardDir) ? fs.readdirSync(shardDir).sort().map(name => `history/${name}`) : [])];
  const rows = physicalFiles.flatMap(relative =>
    fs.readFileSync(path.join(active, relative), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as { id: string; path?: string })
  );
  assert.deepEqual(rows.map(row => row.id), ["history.jsonl", "history/000001.jsonl", "history/000002.jsonl"]);
  for (const row of rows) assert.equal(row.path, path.join(active, "attachments", "item.txt"));
});
