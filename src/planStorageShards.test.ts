import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPlanStoragePackage, readPlanStoragePackageSnapshot, readPlanStorageInventoryHash, withPlanStorageLease, commitPlanLifecycleTransitionUnderLease, commitPlanStorageTransactionUnderLease, recoverPlanLifecycleTransitions, recoverPlanStorageTransactions, type PlanStoragePackageFile } from "./planStorageRepository.js";
import { archivedPlanDirectoryDominatesActive, validateCanonicalActivePlanDirectory, validateCanonicalArchivedPlanDirectory } from "./planStoragePolicy.js";
import { canonicalizeRolePlanStorageDirectories, inspectPlanStorageConflict } from "./planStorageReconciliation.js";
import { PLAN_HISTORY_FILE_LIMIT, isPlanHistoryPath, planHistoryFileDigest, readPlanHistoryDirectory, setPlanHistoryCommitment, setPlanHistoryCommitmentFromDigests } from "./planHistoryShards.js";
import { createPlan, listPlanHistory, updatePlan, type PlanHistoryRecord } from "./roleKnowledge.js";
import { ManagerStorageMutationError, ManagerStorageMutationPool } from "./manager/managerStorageMutationPool.js";
import { ManagerReadWorkerPool } from "./manager/managerReadWorkerPool.js";
import { storageInventoryRevisionToken } from "./shared/storageRevision.js";

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

function fullPlanFixture(t: test.TestContext, shards: number) {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-history-capacity-"));
  const roleDir = path.join(rolesRoot, "Fixture");
  fs.mkdirSync(roleDir);
  const writers = new ManagerStorageMutationPool({ rolesRoot, applicationGenerationId: "capacity-app",
    managerInstanceId: "capacity-manager", timeoutMs: 30_000 });
  const readers = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 30_000 });
  t.after(async () => {
    await Promise.all([writers.stop(), readers.stop()]);
    fs.rmSync(rolesRoot, { recursive: true, force: true });
  });
  const plan = createPlan(roleDir, { id: "capacity-fixture", title: "Capacity fixture",
    focus: "x".repeat(64 * 1024), keywords: ["capacity"], status: "完成",
    steps: [{ id: "review", title: "Review" }] });
  const active = path.join(roleDir, "plans", "active", plan.id);
  const planFile = path.join(active, "plan.json");
  const raw = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const note = path.join(active, "attachments", "proof.txt");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, "evidence bytes");
  const noteHash = createHash("sha256").update("evidence bytes").digest("hex");
  fs.mkdirSync(path.join(active, "history"), { recursive: true });
  const digests = [];
  for (let index = 0; index < shards; index += 1) {
    const file = index === 0 ? "history.jsonl" : `history/${String(index).padStart(6, "0")}.jsonl`;
    const after = { ...plan, focus: "", attachments: [{ path: note, sha256: noteHash }] };
    const record = { id: `fixture-history-${index}`, planId: plan.id, kind: index === 0 ? "created" : "updated",
      recordedAt: plan.createdAt, after };
    const tail = index === 0 ? "" : "\n";
    const empty = `${JSON.stringify(record)}${tail}`;
    after.focus = "界" + "x".repeat(PLAN_HISTORY_FILE_LIMIT - 16 * 1024 - Buffer.byteLength(empty) - 3);
    const bytes = Buffer.from(`${JSON.stringify(record)}${tail}`);
    fs.writeFileSync(path.join(active, file), bytes);
    digests.push(planHistoryFileDigest(file, bytes));
  }
  fs.writeFileSync(planFile, JSON.stringify(setPlanHistoryCommitmentFromDigests(raw, digests)));
  return { rolesRoot, roleDir, writers, readers, plan, digests, noteHash };
}

test("canonical writes cross the old total with intact history, CAS and recoverable archive", { timeout: 90_000 }, async t => {
  const f = fullPlanFixture(t, 6);
  const { roleDir, plan, writers, readers } = f;
  const original = readPlanStoragePackageSnapshot(roleDir, plan.id, "active");
  assert.ok(original.files.reduce((total, file) => total + file.size, 0) < 96 * 1024 * 1024);
  const expectedRevision = storageInventoryRevisionToken(original.inventoryHash);
  const patch = { title: "Updated large plan" };
  const competitor = new ManagerStorageMutationPool({ rolesRoot: f.rolesRoot, applicationGenerationId: "other-capacity-app",
    managerInstanceId: "other-capacity-manager", timeoutMs: 30_000 });
  t.after(() => competitor.stop());
  const results = await Promise.allSettled([
    writers.updatePlan("Fixture", plan.id, patch, { expectedRevision, idempotencyKey: "capacity-update-one" }),
    competitor.updatePlan("Fixture", plan.id, patch, { expectedRevision, idempotencyKey: "capacity-update-two" })
  ]);
  const successful = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof ManagerStorageMutationError);
  assert.equal(rejected[0]!.reason.code, "revision_conflict");
  assert.equal(successful[0]!.value.title, patch.title);
  const options = { expectedRevision, idempotencyKey: successful[0]!.value.storageMutationRequestId! };
  assert.equal((await writers.updatePlan("Fixture", plan.id, patch, options)).storageMutationRequestId, options.idempotencyKey);
  await assert.rejects(writers.updatePlan("Fixture", plan.id, patch, { expectedRevision, idempotencyKey: "stale-capacity-update" }),
    error => error instanceof ManagerStorageMutationError && error.code === "revision_conflict");
  const after = readPlanStoragePackageSnapshot(roleDir, plan.id, "active");
  assert.ok(after.files.reduce((total, file) => total + file.size, 0) > 96 * 1024 * 1024);
  assert.equal(await readPlanStorageInventoryHash(roleDir, plan.id, "active"), after.inventoryHash);
  assert.deepEqual(after.files.filter(file => isPlanHistoryPath(file.path)).slice(0, 6).map(file => [file.path, file.sha256]),
    f.digests.map(file => [file.path, file.sha256]));
  withPlanStorageLease(roleDir, plan.id, lease => commitPlanStorageTransactionUnderLease(lease, {
    transactionId: "capacity-feedback", kind: "plan-feedback",
    operations: [{ type: "replace-file", relativePath: "feedback.jsonl", content: Buffer.from('{"fixture":true}\n') }]
  }));
  const history = await readers.run<{ records: PlanHistoryRecord[] }>({ type: "role_plan_history", roleDir, planId: plan.id });
  assert.equal(history.records.length, 7);
  assert.equal(history.records[0]?.after.attachments[0]?.sha256, f.noteHash);
  assert.equal(history.records.at(-1)?.after.storageMutationRequestId, options.idempotencyKey);
  const rename = fs.renameSync;
  const publication = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(from)) === "payload" && String(to).includes(`${path.sep}archive${path.sep}`)) {
      throw new Error("fixture interrupted archive publication");
    }
    rename(from, to);
  });
  try {
    assert.throws(() => updatePlan(roleDir, plan.id, { archiveStatus: "已归档", activationStatus: "已归档" }),
      /fixture interrupted archive publication/);
  } finally {
    publication.mock.restore();
  }
  const recovered = recoverPlanLifecycleTransitions(roleDir, { planId: plan.id });
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.results.length, 1);
  const archived = readPlanStoragePackage(roleDir, plan.id, "archive");
  assert.equal(archived.files.find(file => file.path === "attachments/proof.txt")?.sha256, f.noteHash);
  const records = listPlanHistory(roleDir, plan.id);
  assert.deepEqual(records.slice(0, 6).map(record => record.id), history.records.slice(0, 6).map(record => record.id));
  assert.deepEqual(records.slice(0, 6).map(record => record.after.focus), history.records.slice(0, 6).map(record => record.after.focus));
  assert.match(records[0]!.after.attachments[0]!.path, /[\\/]archive[\\/]/);
  assert.equal(records[0]!.after.attachments[0]!.sha256, f.noteHash);
  assert.equal(records.at(-1)?.kind, "archived");
});

test("a full independent history budget is a terminal pre-WAL rejection", { timeout: 45_000 }, async t => {
  const { roleDir, plan, writers } = fullPlanFixture(t, 8);
  const before = readPlanStoragePackageSnapshot(roleDir, plan.id, "active");
  const wal = path.join(roleDir, "plans", "quarantine", "plan-storage-lifecycle-transactions", plan.id);
  const transactions = fs.readdirSync(wal);
  const patch = { title: "Over the finite history budget", focus: "q".repeat(128 * 1024) };
  const options = { expectedRevision: storageInventoryRevisionToken(before.inventoryHash), idempotencyKey: "over-history-capacity" };
  await assert.rejects(writers.updatePlan("Fixture", plan.id, patch, options),
    error => error instanceof ManagerStorageMutationError && error.code === "validation_rejected"
      && /128 MiB/.test(error.message));
  const receipt = await writers.reconcilePlanUpdateReceipt("Fixture", plan.id, patch, options);
  assert.equal(receipt.operationState, "failed");
  assert.equal(receipt.commitState, "not_committed");
  assert.equal(readPlanStoragePackageSnapshot(roleDir, plan.id, "active").inventoryHash, before.inventoryHash);
  assert.deepEqual(fs.readdirSync(wal), transactions);
});

test("committed history rejects loss or alteration of the terminal shard", async (t) => {
  const { roleDir, active, archive } = fixture(t);
  fs.rmSync(active, { recursive: true });
  const planPath = path.join(archive, "plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  fs.writeFileSync(planPath, JSON.stringify(setPlanHistoryCommitment(plan, readPlanHistoryDirectory(archive))));
  assert.equal(readPlanStoragePackage(roleDir, id, "archive").files.length, 3);
  assert.equal(await readPlanStorageInventoryHash(roleDir, id, "archive"), readPlanStoragePackage(roleDir, id, "archive").inventoryHash);
  const shardPath = path.join(archive, "history", "000001.jsonl");
  const shard = fs.readFileSync(shardPath);
  fs.unlinkSync(shardPath);
  assert.throws(() => readPlanStoragePackage(roleDir, id, "archive"), /commitment shard count mismatch/);
  await assert.rejects(readPlanStorageInventoryHash(roleDir, id, "archive"), /commitment shard count mismatch/);
  fs.writeFileSync(shardPath, Buffer.from(shard.toString().replace("archived", "altered_")));
  assert.throws(() => readPlanStoragePackage(roleDir, id, "archive"), /commitment bytes or hash mismatch/);
  fs.writeFileSync(shardPath, shard);
  assert.equal(readPlanStoragePackage(roleDir, id, "archive").files.length, 3);
});

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

test("package response uses the same verified bytes as its inventory hash", (t) => {
  const { roleDir, active, archive } = fixture(t);
  fs.rmSync(active, { recursive: true });
  const historyFile = path.join(archive, "history.jsonl");
  const originalRead = fs.readFileSync;
  let historyReads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const value = originalRead(...args);
    if (String(args[0]) === historyFile && ++historyReads > 1) {
      return Buffer.from(`${JSON.stringify({ id: "replacement", planId: id })}\n`);
    }
    return value;
  });
  const snapshot = readPlanStoragePackage(roleDir, id, "archive");
  for (const file of snapshot.files) {
    assert.equal(file.sha256, createHash("sha256").update(file.content).digest("hex"));
    assert.equal(file.size, file.content.byteLength);
  }
  assert.equal(historyReads, 1, "verified package bytes must not be fetched again");
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
