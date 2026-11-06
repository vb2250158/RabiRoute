import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitPlanLifecycleTransitionUnderLease,
  assertPlanStorageIdentityAvailable,
  readCanonicalPlanStoragePackageUnderLease,
  readPlanStorageInventoryHash,
  readPlanStoragePackage,
  recoverPlanLifecycleTransitions,
  recoverPlanStorageTransactions,
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

test("streamed plan revisions match package revisions and invalidate replaced attachments", async t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-streamed-revision-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const planId = "streamed-plan";
  withPlanStorageLease(roleDir, planId, lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "stream_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision(planId, "执行中", 1)
  }));
  const attachment = path.join(roleDir, "plans", "active", planId, "attachments", "large.bin");
  fs.writeFileSync(attachment, Buffer.alloc(4 * 1024 * 1024, 1));
  let turns = 0;
  const timer = setInterval(() => turns++, 1);
  t.after(() => clearInterval(timer));
  const first = await readPlanStorageInventoryHash(roleDir, planId, "active");
  assert.equal(first, readPlanStoragePackage(roleDir, planId, "active").inventoryHash);
  assert.ok(turns > 0);
  assert.equal(await readPlanStorageInventoryHash(roleDir, planId, "active"), first);
  const metadata = fs.statSync(attachment);
  fs.writeFileSync(`${attachment}.replacement`, Buffer.alloc(metadata.size, 2));
  fs.utimesSync(`${attachment}.replacement`, metadata.atime, metadata.mtime);
  fs.renameSync(`${attachment}.replacement`, attachment);
  const second = await readPlanStorageInventoryHash(roleDir, planId, "active");
  assert.notEqual(second, first);
  assert.equal(second, readPlanStoragePackage(roleDir, planId, "active").inventoryHash);
  fs.writeFileSync(path.join(path.dirname(path.dirname(attachment)), "history.jsonl"), "broken\n");
  await assert.rejects(readPlanStorageInventoryHash(roleDir, planId, "active"));
});

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

test("scoped lifecycle recovery never retires a foreign manifest after its owner advances", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-lifecycle-foreign-retirement-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const created = withPlanStorageLease(roleDir, "other-plan", lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "foreign_create", kind: "plan-create", fromBucket: null, toBucket: "active",
    files: revision("other-plan", "执行中", 1)
  }));
  const current = withPlanStorageLease(roleDir, "other-plan", lease => readCanonicalPlanStoragePackageUnderLease(lease));
  withPlanStorageLease(roleDir, "other-plan", lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "foreign_advance", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: current.inventoryHash, files: revision("other-plan", "完成", 2)
  }));
  const updated = withPlanStorageLease(roleDir, "other-plan", lease => readCanonicalPlanStoragePackageUnderLease(lease));
  const interrupted = withPlanStorageLease(roleDir, "other-plan", lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "foreign_interrupted", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: updated.inventoryHash, files: revision("other-plan", "完成", 4)
  }));
  const advanced = withPlanStorageLease(roleDir, "other-plan", lease => readCanonicalPlanStoragePackageUnderLease(lease));
  withPlanStorageLease(roleDir, "other-plan", lease => commitPlanLifecycleTransitionUnderLease(lease, {
    transactionId: "foreign_latest", kind: "plan-update", fromBucket: "active", toBucket: "active",
    expectedSourceInventoryHash: advanced.inventoryHash, files: revision("other-plan", "完成", 5)
  }));
  const source = path.dirname(interrupted.receiptPath);
  const misplaced = path.join(path.dirname(path.dirname(source)), "request-plan", "foreign_interrupted");
  fs.cpSync(source, misplaced, { recursive: true });
  fs.unlinkSync(path.join(misplaced, "receipt.json"));
  const recovered = recoverPlanLifecycleTransitions(roleDir, { planId: "request-plan" });
  assert.equal(recovered.abandoned.length, 0);
  assert.equal(recovered.failures.length, 1);
  assert.equal(fs.existsSync(path.join(misplaced, "receipt.json")), false);
});

test("scoped feedback recovery does not parse another plan's corrupt transaction", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-feedback-scoped-recovery-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const root = path.join(roleDir, "plans", "quarantine", "plan-storage-transactions", "other-plan", "plan-feedback", "broken");
  fs.mkdirSync(root, { recursive: true });
  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(manifest, "invalid-json");
  assert.deepEqual(recoverPlanStorageTransactions(roleDir, { planId: "request-plan" }), {
    committed: 0, alreadyCommitted: 0, failures: []
  });
  assert.equal(fs.readFileSync(manifest, "utf8"), "invalid-json");
  assert.equal(recoverPlanStorageTransactions(roleDir).failures.length, 1);
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


test("legacy identity reservation covers both flat buckets and historical UTF16 names while isolating invalid rows", t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-legacy-id-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const historicalId = "a".repeat(70) + "𐐀".repeat(20);
  const values = [
    { id: "original-active", directory: "items/active", name: "original-active" },
    { id: "original-archive", directory: "archive", name: "original-archive" },
    { id: historicalId, directory: "items/active", name: "a".repeat(70) + "𐐀".repeat(15) }
  ];
  for (const {id,directory,name} of values) {
    const file = path.join(roleDir,"plans",directory,name+".json");
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const raw = Buffer.from(JSON.stringify({id,title:"Original legacy data",vendor:{keep:true}})+"\n");
    fs.writeFileSync(file,raw);
    withPlanStorageLease(roleDir,id,()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,id),/already exists in legacy storage/));
    assert.deepEqual(fs.readFileSync(file),raw);
  }
  const badOther = path.join(roleDir,"plans/items/active/unrelated-bad.json");
  fs.writeFileSync(badOther,"invalid-json");
  withPlanStorageLease(roleDir,"healthy-new-id",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"healthy-new-id")));
  assert.equal(fs.readFileSync(badOther,"utf8"),"invalid-json");
});

test("an undecodable legacy row stays raw while a distinct historical truncation owner does not reserve a new ID", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-local-"));
  t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  const directory=path.join(roleDir,"plans/items/active");fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,"bad-target.json");fs.writeFileSync(file,"invalid-original-raw");
  withPlanStorageLease(roleDir,"bad-target",()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,"bad-target"),/Invalid legacy plan storage identity/));
  withPlanStorageLease(roleDir,"healthy",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"healthy")));
  assert.equal(fs.readFileSync(file,"utf8"),"invalid-original-raw");
  const prefix="a".repeat(100),otherId=prefix+"-other",targetId=prefix+"-new";
  // These IDs share their canonical key too, so both correctly remain occupied.
  const collision=path.join(directory,prefix+".json");fs.writeFileSync(collision,JSON.stringify({id:otherId}));
  withPlanStorageLease(roleDir,targetId,()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,targetId),/already exists in legacy storage/));
  fs.unlinkSync(collision);
  const supplementary="a".repeat(70)+"𐐀".repeat(15),owner=supplementary+"-old",target=supplementary+"-new";
  const sharedHistorical=path.join(directory,supplementary+".json");fs.writeFileSync(sharedHistorical,JSON.stringify({id:owner}));
  withPlanStorageLease(roleDir,target,()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,target)));
});


test("legacy filename metadata resolves supplementary-case aliases before the actual canonical namespace claim", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-alias-"));
  t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  const directory=path.join(roleDir,"plans/items/active");fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,"alias-𐐀.json"),raw=Buffer.from(JSON.stringify({id:"alias-𐐀",title:"Original case identity"})+"\n");fs.writeFileSync(file,raw);
  withPlanStorageLease(roleDir,"alias-𐐨",()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,"alias-𐐨"),/already exists in legacy storage/));
  assert.deepEqual(fs.readFileSync(file),raw);
  withPlanStorageLease(roleDir,"unrelated-new",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"unrelated-new")));
});


test("a historical split surrogate filename reserves its actual disk identity and migration fallback stays exact", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-roundtrip-"));
  t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  const directory=path.join(roleDir,"plans/items/active");fs.mkdirSync(directory,{recursive:true});
  const id="a".repeat(69)+"𐐀".repeat(20),name=("a".repeat(69)+"𐐀".repeat(20)).slice(0,100);
  const file=path.join(directory,name+".json"),raw=Buffer.from(JSON.stringify({id,title:"Original split identity"})+"\n");fs.writeFileSync(file,raw);
  withPlanStorageLease(roleDir,id,()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,id),/already exists in legacy storage/));
  assert.deepEqual(fs.readFileSync(file),raw);
  const fallback=path.join(directory,"fallback.JSON");fs.writeFileSync(fallback,JSON.stringify({title:"Migration uses fallback.JSON as its logical ID"}));
  withPlanStorageLease(roleDir,"fallback",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"fallback")));
});


test("legacy raw identity is reserved independently of arbitrary filenames in both containers", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-decoded-"));
  t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  for(const [directory,id] of [["items/active","original-active-id"],["archive","original-archived-id"]]){
    const file=path.join(roleDir,"plans",directory!,"arbitrary-import-name.json");fs.mkdirSync(path.dirname(file),{recursive:true});
    const raw=Buffer.from(JSON.stringify({id,title:"Existing reader-accepted plan",vendor:{retained:true}})+"\n");fs.writeFileSync(file,raw);
    withPlanStorageLease(roleDir,id!,()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,id!),/already exists in legacy storage/));
    assert.deepEqual(fs.readFileSync(file),raw);
  }
  withPlanStorageLease(roleDir,"healthy-new-id",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"healthy-new-id")));
});


test("unrelated row I/O stays diagnostic while known target I/O remains local and namespace errors stay real", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-io-"));t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  const directory=path.join(roleDir,"plans/items/active");fs.mkdirSync(directory,{recursive:true});
  const other=path.join(directory,"unrelated.json"),target=path.join(directory,"known-target.json");fs.writeFileSync(other,JSON.stringify({id:"other",title:"Other"}));fs.writeFileSync(target,JSON.stringify({id:"known-target",title:"Target"}));
  const raw=fs.readFileSync(other),original=fs.readFileSync,warnings:unknown[][]=[];const denied=Object.assign(new Error("Synthetic row read denied"),{code:"EACCES"});
  t.mock.method(console,"warn",(...args:unknown[])=>warnings.push(args));
  t.mock.method(fs,"readFileSync",((file:unknown,...args:unknown[])=>{if(String(file)===other||String(file)===target)throw denied;return Reflect.apply(original,fs,[file,...args]);}) as typeof fs.readFileSync);
  withPlanStorageLease(roleDir,"healthy-new-id",()=>assert.doesNotThrow(()=>assertPlanStorageIdentityAvailable(roleDir,"healthy-new-id")));
  assert.equal(warnings.length,1);assert.equal((warnings[0]![1] as {rows:number}).rows,2);
  withPlanStorageLease(roleDir,"known-target",()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,"known-target"),error=>error===denied));
  t.mock.restoreAll();assert.deepEqual(fs.readFileSync(other),raw);
  const brokenRole=path.join(roleDir,"namespace-case"),broken=path.join(brokenRole,"plans/items/active");fs.mkdirSync(path.dirname(broken),{recursive:true});fs.writeFileSync(broken,"original namespace error");
  let namespaceCode: unknown;try{fs.opendirSync(broken);}catch(error){namespaceCode=(error as NodeJS.ErrnoException).code;}
  assert.ok(namespaceCode);
  withPlanStorageLease(brokenRole,"new-id",()=>assert.throws(()=>assertPlanStorageIdentityAvailable(brokenRole,"new-id"),error=>(error as NodeJS.ErrnoException).code===namespaceCode));
  assert.equal(fs.readFileSync(broken,"utf8"),"original namespace error");
});


test("known malformed legacy logical ID preserves its decode cause and uses deterministic validation rejection", t => {
  const roleDir=fs.mkdtempSync(path.join(os.tmpdir(),"plan-legacy-decode-"));t.after(()=>fs.rmSync(roleDir,{recursive:true,force:true}));
  const file=path.join(roleDir,"plans/items/active/known-target.json");fs.mkdirSync(path.dirname(file),{recursive:true});
  const raw=Buffer.from(JSON.stringify({id:" known-target ",title:"Original malformed logical ID"})+"\n");fs.writeFileSync(file,raw);
  withPlanStorageLease(roleDir,"known-target",()=>assert.throws(()=>assertPlanStorageIdentityAvailable(roleDir,"known-target"),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/^Invalid legacy plan storage identity/);
    assert.ok(error.cause instanceof Error);assert.match(error.cause.message,/trimmed and Unicode NFC-normalized/);return true;
  }));
  assert.deepEqual(fs.readFileSync(file),raw);
});
