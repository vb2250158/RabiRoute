import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalLogicalPlanId,
  canonicalPlanStorageName,
  planDirectory,
  safePlanStorageId
} from "./planStorageLayout.js";
import {
  archivedPlanStorageFence,
  canonicalPlanIdForStorageIdentity,
  canonicalizeRolePlanStorageDirectories,
  inspectPlanStorageConflict,
  planStorageDirectory,
  planStorageLockPath,
  reconcilePlanStorageConflict,
  withPlanStorageLock,
  withPlanStorageLockAsync
} from "./planStorageReconciliation.js";

const PLAN_ID = "plan-archive-terminal";

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture(): {
  root: string;
  roleDir: string;
  active: string;
  archive: string;
  activePlan: Record<string, unknown>;
  archivePlan: Record<string, unknown>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-reconcile-"));
  const roleDir = path.join(root, "roles", "YeYu");
  const active = planStorageDirectory(roleDir, PLAN_ID, "active");
  const archive = planStorageDirectory(roleDir, PLAN_ID, "archive");
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  const activePlan = {
    id: PLAN_ID,
    title: "Archive terminal contract",
    focus: "Keep one canonical archived plan",
    status: "已完成",
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    steps: [{ id: "done", title: "Done", status: "已完成" }],
    keywords: ["archive"]
  };
  const archivePlan = {
    ...activePlan,
    status: "已归档",
    updatedAt: "2026-08-24T00:00:00.000Z",
    archivedAt: "2026-08-24T00:00:00.000Z"
  };
  const created = {
    id: "history-created",
    planId: PLAN_ID,
    kind: "created",
    recordedAt: activePlan.updatedAt,
    after: activePlan
  };
  const archived = {
    id: "history-archived",
    planId: PLAN_ID,
    kind: "archived",
    recordedAt: archivePlan.updatedAt,
    before: activePlan,
    after: archivePlan
  };
  fs.writeFileSync(path.join(active, "plan.json"), `${JSON.stringify(activePlan, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(active, "history.jsonl"), `${JSON.stringify(created)}\n`, "utf8");
  fs.writeFileSync(path.join(archive, "plan.json"), `${JSON.stringify(archivePlan, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(archive, "history.jsonl"),
    `${JSON.stringify(created)}\n${JSON.stringify(archived)}\n`,
    "utf8"
  );
  return { root, roleDir, active, archive, activePlan, archivePlan };
}

test("plan reconciliation proves archive lineage, quarantines active, and is idempotent", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const archivePlanHash = sha256File(path.join(data.archive, "plan.json"));
  const archiveHistoryHash = sha256File(path.join(data.archive, "history.jsonl"));

  const inspection = inspectPlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(inspection.status, "reconcilable");
  assert.ok(inspection.activeInventory);
  assert.ok(inspection.archiveInventory);

  const result = reconcilePlanStorageConflict(data.roleDir, PLAN_ID, {
    expectedActiveInventoryHash: inspection.activeInventory?.hash,
    expectedArchiveInventoryHash: inspection.archiveInventory?.hash,
    now: () => new Date("2026-08-31T00:00:00.000Z")
  });
  assert.equal(result.status, "reconciled");
  assert.equal(fs.existsSync(data.active), false);
  assert.equal(fs.existsSync(result.quarantinePath!), true);
  assert.equal(sha256File(path.join(data.archive, "plan.json")), archivePlanHash);
  assert.equal(sha256File(path.join(data.archive, "history.jsonl")), archiveHistoryHash);
  const receipt = JSON.parse(fs.readFileSync(result.receiptPath!, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.status, "reconciled");
  assert.equal(receipt.occurrence, "initial");

  const repeated = reconcilePlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(repeated.status, "already_reconciled");
  assert.equal(repeated.receiptPath, result.receiptPath);
});

test("a proven archived ancestor reintroduced later is quarantined as a new recoverable occurrence", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const first = reconcilePlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(first.status, "reconciled");
  fs.cpSync(first.quarantinePath!, data.active, { recursive: true, errorOnExist: true });

  const second = reconcilePlanStorageConflict(data.roleDir, PLAN_ID, {
    now: () => new Date("2026-08-31T00:01:00.000Z")
  });
  assert.equal(second.status, "reconciled");
  assert.notEqual(second.receiptPath, first.receiptPath);
  assert.equal(fs.existsSync(data.active), false);
  const receipt = JSON.parse(fs.readFileSync(second.receiptPath!, "utf8")) as Record<string, unknown>;
  assert.equal(receipt.occurrence, "reintroduced");
  assert.equal(receipt.occurrenceSequence, 1);
});

test("reconciliation fails closed when active contains data absent from the archive", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(data.active, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(data.active, "attachments", "new.txt"), "not archived\n", "utf8");
  const activePlanHash = sha256File(path.join(data.active, "plan.json"));
  const archivePlanHash = sha256File(path.join(data.archive, "plan.json"));

  const result = reconcilePlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(result.status, "conflict");
  assert.equal(fs.existsSync(data.active), true);
  assert.equal(fs.existsSync(data.archive), true);
  assert.equal(sha256File(path.join(data.active, "plan.json")), activePlanHash);
  assert.equal(sha256File(path.join(data.archive, "plan.json")), archivePlanHash);
});

test("legacy active snapshots without history are quarantined only behind a later terminal archive", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const staleActive: Record<string, unknown> = { ...data.activePlan, status: "进行中" };
  delete staleActive.completedAt;
  const legacyArchive: Record<string, unknown> = { ...data.archivePlan };
  delete legacyArchive.archivedAt;
  fs.writeFileSync(path.join(data.active, "plan.json"), `${JSON.stringify(staleActive, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(data.archive, "plan.json"), `${JSON.stringify(legacyArchive, null, 2)}\n`, "utf8");
  fs.rmSync(path.join(data.active, "history.jsonl"));
  fs.rmSync(path.join(data.archive, "history.jsonl"));

  const inspection = inspectPlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(inspection.status, "reconcilable");
  assert.equal(inspection.reason, "terminal_archive_temporally_dominates_legacy_active_snapshot");
  const result = reconcilePlanStorageConflict(data.roleDir, PLAN_ID);
  assert.equal(result.status, "reconciled");
  assert.equal(fs.existsSync(data.active), false);
  assert.equal(fs.existsSync(data.archive), true);
  assert.equal(fs.existsSync(result.quarantinePath!), true);
});

test("the latest matching archived transition proves a repeated legacy archival", (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const finalArchive = {
    ...data.archivePlan,
    updatedAt: "2026-08-24T02:00:00.000Z",
    archivedAt: "2026-08-24T02:00:00.000Z"
  };
  const repeated = {
    id: "history-archived-again",
    planId: PLAN_ID,
    kind: "archived",
    recordedAt: finalArchive.updatedAt,
    before: data.activePlan,
    after: finalArchive
  };
  fs.appendFileSync(path.join(data.archive, "history.jsonl"), `${JSON.stringify(repeated)}\n`, "utf8");
  fs.writeFileSync(path.join(data.archive, "plan.json"), `${JSON.stringify(finalArchive, null, 2)}\n`, "utf8");
  assert.equal(inspectPlanStorageConflict(data.roleDir, PLAN_ID).status, "reconcilable");
});

test("historical mixed-case plan directories migrate atomically and recover after a post-rename crash", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-name-migration-"));
  const roleDir = path.join(root, "roles", "YeYu");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planId = "Plan-Case-Migration";
  const bucketRoot = path.join(roleDir, "plans", "active");
  const legacyName = planId;
  const canonicalName = "plan-case-migration";
  const legacyDirectory = path.join(bucketRoot, legacyName);
  const canonicalDirectory = path.join(bucketRoot, canonicalName);
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(path.join(legacyDirectory, "plan.json"), `${JSON.stringify({
    id: planId,
    status: "进行中",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    attachments: [{ path: path.join(legacyDirectory, "attachments", "proof.txt") }]
  }, null, 2)}\n`, "utf8");

  let injected = true;
  const interrupted = canonicalizeRolePlanStorageDirectories(roleDir, {
    faultInjection: {
      afterRename: () => {
        if (!injected) return;
        injected = false;
        throw new Error("injected post-rename crash");
      }
    }
  });
  assert.equal(interrupted.migrated, 0);
  assert.match(interrupted.failures[0]?.error || "", /injected post-rename crash/);
  assert.deepEqual(fs.readdirSync(bucketRoot), [canonicalName]);

  const recovered = canonicalizeRolePlanStorageDirectories(roleDir);
  assert.equal(recovered.recovered, 1);
  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.receipts.length, 1);
  const plan = JSON.parse(fs.readFileSync(path.join(canonicalDirectory, "plan.json"), "utf8")) as {
    attachments: Array<{ path: string }>;
  };
  assert.equal(plan.attachments[0]?.path, path.join(canonicalDirectory, "attachments", "proof.txt"));
  const receipt = JSON.parse(fs.readFileSync(recovered.receipts[0]!, "utf8")) as { status?: unknown };
  assert.equal(receipt.status, "migrated");
  const repeated = canonicalizeRolePlanStorageDirectories(roleDir);
  assert.equal(repeated.migrated, 0);
  assert.equal(repeated.recovered, 0);
  assert.deepEqual(repeated.failures, []);
});

test("plan locks share one case-folded physical identity and never retry business EEXIST errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(planStorageLockPath(root, "Plan-A"), planStorageLockPath(root, "plan-a"));

  let syncCalls = 0;
  const syncError = Object.assign(new Error("business EEXIST"), { code: "EEXIST" });
  assert.throws(() => withPlanStorageLock(root, "plan-a", () => {
    syncCalls += 1;
    throw syncError;
  }), /business EEXIST/);
  assert.equal(syncCalls, 1);
  const lockDirectory = path.dirname(planStorageLockPath(root, "plan-a"));
  assert.deepEqual(fs.readdirSync(lockDirectory), []);

  let asyncCalls = 0;
  const asyncError = Object.assign(new Error("business EPERM"), { code: "EPERM" });
  await assert.rejects(withPlanStorageLockAsync(root, "plan-a", async () => {
    asyncCalls += 1;
    throw asyncError;
  }), /business EPERM/);
  assert.equal(asyncCalls, 1);
  assert.deepEqual(fs.readdirSync(lockDirectory), []);
});

test("logical plan ids are canonical at every storage entry without splitting Unicode code points", () => {
  assert.equal(canonicalLogicalPlanId("plan-a"), "plan-a");
  assert.throws(() => canonicalLogicalPlanId(" plan-a "), /trimmed and Unicode NFC-normalized/i);
  assert.throws(() => canonicalLogicalPlanId("e\u0301-plan"), /trimmed and Unicode NFC-normalized/i);
  assert.throws(() => planDirectory("C:\\role", " plan-a ", "active"), /trimmed and Unicode NFC-normalized/i);
  assert.throws(() => canonicalPlanStorageName("e\u0301-plan"), /trimmed and Unicode NFC-normalized/i);
  assert.equal(canonicalPlanStorageName("\u00e9-plan"), safePlanStorageId("\u00e9-plan"));
  const astralLetter = "\u{10400}";
  const storageId = safePlanStorageId(`${"a".repeat(99)}${astralLetter}tail`);
  assert.equal(Array.from(storageId).length, 100);
  assert.equal(Array.from(storageId).at(-1), astralLetter);
});

test("identity readers fail closed for historical case, NFC, and legacy equivalents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-identity-fence-"));
  const roleDir = path.join(root, "roles", "YeYu");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const caseArchive = path.join(roleDir, "plans", "archive", "Plan-Archived");
  fs.mkdirSync(caseArchive, { recursive: true });
  fs.writeFileSync(path.join(caseArchive, "plan.json"), `${JSON.stringify({
    id: "Plan-Archived",
    status: "已归档"
  })}\n`, "utf8");
  const archiveFence = archivedPlanStorageFence(roleDir, "plan-archived");
  assert.equal(archiveFence.status, "invalid");
  assert.match(archiveFence.reason || "", /migration|collision|directory does not match/i);
  assert.throws(
    () => canonicalPlanIdForStorageIdentity(roleDir, "plan-archived"),
    /migration|collision|directory does not match/i
  );

  const nfdName = "e\u0301-active";
  const nfcId = "\u00e9-active";
  const nfdActive = path.join(roleDir, "plans", "active", nfdName);
  fs.mkdirSync(nfdActive, { recursive: true });
  fs.writeFileSync(path.join(nfdActive, "plan.json"), `${JSON.stringify({ id: nfcId, status: "进行中" })}\n`, "utf8");
  assert.throws(() => canonicalPlanIdForStorageIdentity(roleDir, nfcId), /migration|collision|directory does not match/i);

  const legacyArchive = path.join(roleDir, "plans", "archive", "Legacy-Plan.json");
  fs.writeFileSync(legacyArchive, `${JSON.stringify({ id: "Legacy-Plan", status: "已归档" })}\n`, "utf8");
  assert.equal(canonicalPlanIdForStorageIdentity(roleDir, "legacy-plan"), null);
});

test("nested synchronous plan locks fail immediately instead of waiting on their own lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-lock-reentrant-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const startedAt = Date.now();
  withPlanStorageLock(root, "plan-a", () => {
    assert.throws(
      () => withPlanStorageLock(root, "Plan-A", () => undefined),
      /re-entrant plan storage lock/i
    );
  });
  assert.ok(Date.now() - startedAt < 1_000);
});
