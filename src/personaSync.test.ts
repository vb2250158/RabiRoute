import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PersonaSyncService } from "./personaSync.js";
import {
  createActivePlanPackageCommandFromFiles,
  createArchivedPlanPackageCommandFromFiles,
  type PersonaSyncActivePlanPackageCommand,
  type PersonaSyncArchivedPlanPackageCommand,
  type PersonaSyncPlanPackageFile
} from "./personaSyncPlanPackage.js";
import { planStorageDirectory } from "./planStorageReconciliation.js";

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function planPackageFile(relativePath: string, value: Buffer | string): PersonaSyncPlanPackageFile {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return {
    path: relativePath,
    size: content.byteLength,
    sha256: hash(content),
    contentBase64: content.toString("base64")
  };
}

function activePlanPackage(
  roleId: string,
  planId: string,
  overrides: Record<string, unknown> = {}
): PersonaSyncActivePlanPackageCommand {
  const recordedAt = "2026-08-01T00:00:00.000Z";
  const plan = {
    id: planId,
    title: "Active plan",
    focus: "Remain active",
    status: "执行中",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    steps: [{ id: "working", title: "Working", status: "进行中" }],
    keywords: ["active"],
    ...overrides
  };
  const history = {
    id: `created-${planId}`,
    planId,
    kind: "created",
    recordedAt,
    after: plan
  };
  return createActivePlanPackageCommandFromFiles(roleId, planId, [
    planPackageFile("plan.json", `${JSON.stringify(plan, null, 2)}\n`),
    planPackageFile("history.jsonl", `${JSON.stringify(history)}\n`)
  ], "fixture-peer");
}

function archivedPlanPackage(
  roleId: string,
  planId: string,
  options: { storedPlanId?: string; archiveStatus?: string } = {}
): PersonaSyncArchivedPlanPackageCommand {
  const storedPlanId = options.storedPlanId || planId;
  const completed = {
    id: storedPlanId,
    title: "Archived plan",
    focus: "Remain archived",
    status: "完成",
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    steps: [{ id: "done", title: "Done", status: "已完成" }],
    keywords: ["archive"]
  };
  const archived = {
    ...completed,
    archiveStatus: options.archiveStatus || "已归档",
    archivedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z"
  };
  const history = [
    {
      id: `created-${storedPlanId}`,
      planId: storedPlanId,
      kind: "created",
      recordedAt: completed.updatedAt,
      after: completed
    },
    {
      id: `archived-${storedPlanId}`,
      planId: storedPlanId,
      kind: "archived",
      recordedAt: archived.updatedAt,
      before: completed,
      after: archived
    }
  ];
  return createArchivedPlanPackageCommandFromFiles(roleId, planId, [
    planPackageFile("plan.json", `${JSON.stringify(archived, null, 2)}\n`),
    planPackageFile("history.jsonl", `${history.map(record => JSON.stringify(record)).join("\n")}\n`)
  ], "fixture-peer");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("persona sync manifests text and binary persona assets while safely merging JSONL histories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(path.join(roleRoot, "conversation"), { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "本地人格\n", "utf8");
  fs.writeFileSync(path.join(roleRoot, "conversation", "current.jsonl"), `${JSON.stringify({ id: "local-one", time: 1, text: "本地" })}\n`, "utf8");
  fs.mkdirSync(path.join(roleRoot, "voice", "cache", "reference-audio"), { recursive: true });
  const referenceAudio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
  const avatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(roleRoot, "voice", "cache", "reference-audio", "sample.wav"), referenceAudio);
  fs.writeFileSync(path.join(roleRoot, "avatar.png"), avatar);
  fs.mkdirSync(path.join(roleRoot, "voice", "cache", "tts-audio"), { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "voice", "cache", "tts-audio", "ignored.wav"), Buffer.from([1, 2, 3]));
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));

  const manifest = await service.manifest("Rabi");
  assert.deepEqual(manifest.roles[0]?.files.map(item => item.path).sort(), [
    "avatar.png",
    "conversation/current.jsonl",
    "persona.md",
    "voice/cache/reference-audio/sample.wav"
  ]);
  assert.deepEqual(service.readFile("Rabi", "avatar.png").content, avatar);
  assert.deepEqual(service.readFile("Rabi", "voice/cache/reference-audio/sample.wav").content, referenceAudio);

  const remoteJsonl = `${JSON.stringify({ id: "remote-one", time: 2, text: "远端" })}\n`;
  const merged = service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    contentBase64: Buffer.from(remoteJsonl).toString("base64"),
    remoteHash: hash(remoteJsonl),
    peerId: "pc-b"
  });
  assert.equal(merged.status, "merged");
  const rows = fs.readFileSync(path.join(roleRoot, "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.id), ["local-one", "remote-one"]);
  assert.ok(merged.archivePath);

  const remoteReference = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x22, 0x33, 0x44, 0x55]);
  const binaryMerge = service.merge({
    roleId: "Rabi",
    path: "voice/cache/reference-audio/remote.wav",
    contentBase64: remoteReference.toString("base64"),
    remoteHash: hash(remoteReference),
    peerId: "pc-b"
  });
  assert.equal(binaryMerge.status, "created");
  assert.deepEqual(fs.readFileSync(path.join(roleRoot, "voice", "cache", "reference-audio", "remote.wav")), remoteReference);
});

test("persona sync transport rejects runtime and generic plan paths while accepting whole plan packages and memory files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-runtime-filter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(path.join(roleRoot, "state", "work-cycle-history"), { recursive: true });
  const runtimeTarget = path.join(roleRoot, "state", "work-cycle-history", "snapshot.json");
  fs.writeFileSync(runtimeTarget, "{\"records\":[]}\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  t.after(() => service.stopManifestIndex());

  assert.throws(
    () => service.readFile("Rabi", "state/work-cycle-history/snapshot.json"),
    /excluded/i
  );
  assert.throws(
    () => service.merge({
      roleId: "Rabi",
      path: "state/work-cycle-history/snapshot.json",
      deleted: true,
      baseHash: hash("{\"records\":[]}\n"),
      peerId: "pc-b"
    }),
    /excluded/i
  );
  assert.equal(fs.existsSync(runtimeTarget), true);

  const memory = Buffer.from("{\"id\":\"memory-1\"}\n", "utf8");
  assert.equal(service.applyActivePlanPackage(activePlanPackage("Rabi", "plan-1")).status, "applied");
  const activePlan = fs.readFileSync(path.join(roleRoot, "plans", "active", "plan-1", "plan.json"));
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "plans/active/plan-1/plan.json",
    contentBase64: activePlan.toString("base64"),
    remoteHash: hash(activePlan),
    peerId: "pc-b"
  }), /requires an atomic plan package/i);
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "plans/items/active/plan-1.json",
    contentBase64: activePlan.toString("base64"),
    remoteHash: hash(activePlan),
    peerId: "pc-b"
  }), /excluded|legacy plan storage/i);
  assert.equal(service.merge({
    roleId: "Rabi",
    path: "memory/recent/memory-1.json",
    contentBase64: memory.toString("base64"),
    remoteHash: hash(memory),
    peerId: "pc-b"
  }).status, "created");
});

function writeArchivedPlanFixture(roleRoot: string, planId = "archived-plan"): { active: string; archive: string } {
  const active = planStorageDirectory(roleRoot, planId, "active");
  const archive = planStorageDirectory(roleRoot, planId, "archive");
  fs.mkdirSync(archive, { recursive: true });
  for (const file of archivedPlanPackage("Rabi", planId).files) {
    const target = path.join(archive, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.contentBase64, "base64"));
  }
  return { active, archive };
}

test("persona sync treats canonical archive as a terminal fence against active resurrection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-archive-fence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const { active } = writeArchivedPlanFixture(roleRoot);
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());

  const manifest = await service.manifest("Rabi");
  assert.equal(manifest.roles[0]?.files.some((file) => file.path.includes("plans/active/")), false);
  assert.throws(
    () => service.readFile("Rabi", "plans/active/archived-plan/plan.json"),
    /already archived/i
  );
  const result = service.applyActivePlanPackage(activePlanPackage("Rabi", "archived-plan", {
    status: "完成",
    completedAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z"
  }));
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "canonical_archive_is_terminal");
  assert.equal(fs.existsSync(active), false);
});

test("persona sync fails closed for incomplete archive storage and non-canonical plan paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-invalid-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(path.join(roleRoot, "plans", "archive", "broken-plan"), { recursive: true });
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  const incoming = Buffer.from(JSON.stringify({ id: "broken-plan", status: "执行中" }), "utf8");

  assert.throws(
    () => service.applyActivePlanPackage(activePlanPackage("Rabi", "broken-plan")),
    /identity collision.*invalid storage/i
  );
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "plans/active/foo bar/plan.json",
    contentBase64: incoming.toString("base64"),
    remoteHash: hash(incoming)
  }), /non-canonical storage identity/i);
});

test("persona sync validates archive identity and never applies archive deletion", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-archive-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());

  assert.throws(
    () => service.applyArchivedPlanPackage(archivedPlanPackage("Rabi", "archive-plan", { storedPlanId: "other-plan" })),
    /invalid terminal identity|identity does not match plan\.json|plan\.json identity mismatch/i
  );
  assert.throws(
    () => service.applyArchivedPlanPackage(archivedPlanPackage("Rabi", "archive-plan", { archiveStatus: "未归档" })),
    /archive plan package is not terminal|bucket does not match plan status/i
  );

  const applied = service.applyArchivedPlanPackage(archivedPlanPackage("Rabi", "archive-plan"));
  assert.equal(applied.status, "applied");
  const archived = fs.readFileSync(path.join(roleRoot, "plans", "archive", "archive-plan", "plan.json"));
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "plans/archive/archive-plan/plan.json",
    deleted: true,
    baseHash: hash(archived)
  }), /requires an atomic plan package/i);
  assert.equal(fs.existsSync(path.join(roleRoot, "plans", "archive", "archive-plan", "plan.json")), true);
});

test("generic persona merge cannot bypass plan package identity or lifecycle fencing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-resolution-fence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  const applied = service.applyActivePlanPackage(activePlanPackage("Rabi", "resolve-plan", { title: "local" }));
  assert.equal(applied.status, "applied");
  const planFile = path.join(roleRoot, "plans", "active", "resolve-plan", "plan.json");
  const local = fs.readFileSync(planFile);
  const remote = Buffer.from(JSON.stringify({ id: "resolve-plan", status: "完成", title: "remote" }), "utf8");
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "plans/active/resolve-plan/plan.json",
    contentBase64: remote.toString("base64"),
    peerId: "pc-b"
  }), /requires an atomic plan package/i);
  assert.equal(service.listConflicts("Rabi").length, 0);
  assert.deepEqual(fs.readFileSync(planFile), local);
});

test("persona sync rejects full logical plan id collisions that share one storage identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-logical-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const localId = `${"p".repeat(100)}-local`;
  const remoteId = `${"p".repeat(100)}-remote`;
  const storageId = "p".repeat(100);
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  assert.equal(service.applyActivePlanPackage(activePlanPackage("Rabi", localId)).status, "applied");
  const planFile = path.join(roleRoot, "plans", "active", storageId, "plan.json");
  const local = fs.readFileSync(planFile);

  assert.throws(
    () => service.applyActivePlanPackage(activePlanPackage("Rabi", remoteId)),
    /invalid live identity|storage identity collision/i
  );
  assert.deepEqual(fs.readFileSync(planFile), local);
});

test("persona manifest fails closed instead of hiding an ambiguous active and archive pair", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-ambiguity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const { active, archive } = writeArchivedPlanFixture(roleRoot, "ambiguous-plan");
  const archivedHistory = fs.readFileSync(path.join(archive, "history.jsonl"), "utf8").trim().split(/\r?\n/);
  const first = JSON.parse(archivedHistory[0]!) as { after: Record<string, unknown> };
  fs.mkdirSync(path.join(active, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(active, "plan.json"), `${JSON.stringify(first.after, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(active, "history.jsonl"), `${archivedHistory[0]}\n`, "utf8");
  fs.writeFileSync(path.join(active, "attachments", "unarchived.txt"), "new active-only data\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());

  await assert.rejects(service.manifest("Rabi"), /incomplete or ambiguous plan package|unresolved plan lifecycle|duplicate active\/archive plan storage/i);
});

test("persona manifest refuses to hide a reconcilable active replica before reconciliation completes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-reconcilable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const { active, archive } = writeArchivedPlanFixture(roleRoot, "reconcilable-plan");
  const archivedHistory = fs.readFileSync(path.join(archive, "history.jsonl"), "utf8").trim().split(/\r?\n/);
  const last = JSON.parse(archivedHistory.at(-1)!) as { before: Record<string, unknown> };
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, "plan.json"), `${JSON.stringify(last.before, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(active, "history.jsonl"), `${archivedHistory[0]}\n`, "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());

  await assert.rejects(service.manifest("Rabi"), /incomplete or ambiguous plan package|unresolved plan lifecycle|duplicate active\/archive plan storage/i);
  assert.equal(fs.existsSync(active), true);
});

test("persona sync fast-forwards from a known base and preserves divergent files as conflicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "base\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  const fastForward = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote change\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(fastForward.status, "fast_forwarded");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "remote change\n");

  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "local divergent\n");
  assert.ok(conflict.conflictPath);
  assert.equal(fs.existsSync(path.join(root, "sync-state", conflict.conflictPath!)), true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const duplicateConflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(duplicateConflict.conflictPath, conflict.conflictPath);
  const conflicts = service.listConflicts("Rabi");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.path, "persona.md");
  assert.equal(conflicts[0]?.localHash, hash("local divergent\n"));
  assert.equal(service.readConflict(conflicts[0]!.conflictId).content.toString("utf8"), "remote divergent\n");
  assert.throws(() => service.resolveConflict({
    conflictId: conflicts[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("stale\n")
  }), /stale local file hash/);
  const resolved = service.resolveConflict({
    conflictId: conflicts[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("local divergent\n")
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.action, "use_remote");
  assert.equal(fs.readFileSync(path.join(roleRoot, "persona.md"), "utf8"), "remote divergent\n");
  assert.equal(service.listConflicts("Rabi").length, 0);
  assert.equal(fs.existsSync(path.join(root, "sync-state", resolved.resolutionPath)), true);
  assert.equal(fs.existsSync(path.join(root, "sync-state", `${resolved.resolutionPath}.resolution.json`)), true);
});

test("persona sync conflict resolution can retain local or publish explicit merged content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-resolve-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  const target = path.join(roleRoot, "persona.md");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  fs.writeFileSync(target, "local one\n", "utf8");
  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote one\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  const keep = service.listConflicts("Rabi")[0]!;
  const kept = service.resolveConflict({
    conflictId: keep.conflictId,
    action: "keep_local",
    expectedLocalHash: hash("local one\n")
  });
  assert.equal(kept.resultHash, hash("local one\n"));
  assert.equal(fs.readFileSync(target, "utf8"), "local one\n");

  fs.writeFileSync(target, "local two\n", "utf8");
  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote two\n").toString("base64"),
    baseHash,
    peerId: "pc-b"
  });
  const merge = service.listConflicts("Rabi")[0]!;
  const merged = service.resolveConflict({
    conflictId: merge.conflictId,
    action: "use_merged",
    contentBase64: Buffer.from("explicit merged\n").toString("base64"),
    expectedLocalHash: hash("local two\n")
  });
  assert.equal(merged.resultHash, hash("explicit merged\n"));
  assert.equal(fs.readFileSync(target, "utf8"), "explicit merged\n");
});

test("persona sync keeps different peer evidence as separate conflicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-peer-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const remote = Buffer.from("remote divergent\n");
  const command = {
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: remote.toString("base64"),
    baseHash: hash("base\n")
  };

  const first = service.merge({ ...command, peerId: "pc-b" });
  const second = service.merge({ ...command, peerId: "pc-c" });

  assert.notEqual(first.conflictPath, second.conflictPath);
  assert.equal(service.listConflicts("Rabi").length, 2);
});

test("persona sync reuses conflict evidence without scanning the legacy directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-direct-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const command = {
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash: hash("base\n"),
    peerId: "pc-b"
  };
  const first = service.merge(command);
  const conflictDirectory = path.dirname(path.join(root, "sync-state", first.conflictPath!));
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = ((target: fs.PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
    if (path.resolve(String(target)) === path.resolve(conflictDirectory)) {
      throw new Error("legacy conflict directory must not be scanned");
    }
    return originalReaddirSync(target, options as never);
  }) as typeof fs.readdirSync;
  try {
    const repeated = service.merge(command);
    assert.equal(repeated.conflictPath, first.conflictPath);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test("persona sync collapses legacy duplicate evidence and resolves it as one conflict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-legacy-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash: hash("base\n"),
    peerId: "pc-b"
  });
  const original = path.join(root, "sync-state", conflict.conflictPath!);
  const duplicate = path.join(path.dirname(original), `legacy-copy-${path.basename(original)}`);
  fs.copyFileSync(original, duplicate);
  fs.copyFileSync(`${original}.meta.json`, `${duplicate}.meta.json`);

  const listed = service.listConflicts("Rabi");
  assert.equal(listed.length, 1);
  service.resolveConflict({
    conflictId: listed[0]!.conflictId,
    action: "keep_local",
    expectedLocalHash: hash("local divergent\n")
  });
  assert.equal(service.listConflicts("Rabi").length, 0);
});

test("persona sync builds a deduplicated legacy conflict catalog without blocking the event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-conflict-catalog-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const remote = Buffer.from("remote divergent\n");
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: remote.toString("base64"),
    baseHash: hash("base\n"),
    peerId: "pc-b"
  });
  const original = path.join(root, "sync-state", conflict.conflictPath!);
  const directory = path.dirname(original);
  const suffix = `pc-b-${hash(remote).slice(0, 12)}`;
  for (let index = 0; index < 100; index += 1) {
    const duplicate = path.join(directory, `2026-08-06T10-00-00-${String(index).padStart(3, "0")}Z-${suffix}`);
    fs.copyFileSync(original, duplicate);
    fs.copyFileSync(`${original}.meta.json`, `${duplicate}.meta.json`);
  }

  let yielded = false;
  setImmediate(() => { yielded = true; });
  const listed = await service.listConflictsAsync("Rabi");

  assert.equal(yielded, true);
  assert.equal(listed.length, 1);
  assert.equal((await service.listConflictsAsync("Rabi"))[0]?.conflictId, listed[0]?.conflictId);
});

test("persona sync propagates a based deletion and preserves delete-versus-edit evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-delete-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const target = path.join(roleRoot, "persona.md");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(target, "base\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const baseHash = hash("base\n");

  const deleted = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    deleted: true,
    remoteHash: "deleted",
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(deleted.status, "fast_forwarded");
  assert.equal(deleted.remoteDeleted, true);
  assert.equal(fs.existsSync(target), false);
  assert.ok(deleted.archivePath);

  fs.writeFileSync(target, "local edit\n", "utf8");
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    deleted: true,
    remoteHash: "deleted",
    baseHash,
    peerId: "pc-b"
  });
  assert.equal(conflict.status, "conflict");
  const listed = service.listConflicts("Rabi");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.remoteDeleted, true);
  assert.equal(listed[0]?.peerId, "pc-b");
  assert.equal(listed[0]?.baseHash, baseHash);
  assert.equal(service.readConflict(listed[0]!.conflictId).content.byteLength, 0);

  const resolved = service.resolveConflict({
    conflictId: listed[0]!.conflictId,
    action: "use_remote",
    expectedLocalHash: hash("local edit\n")
  });
  assert.equal(resolved.remoteDeleted, true);
  assert.equal(fs.existsSync(target), false);
  assert.ok(resolved.archivePath);
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    deleted: true,
    remoteHash: "deleted",
    baseHash
  }), /union\/tombstone semantics/);
});

test("persona sync shares the live conversation lock before replacing current context", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-live-lock-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const conversationDir = path.join(roleRoot, "conversation");
  const lockPath = path.join(conversationDir, ".message-context.lock");
  const readyPath = path.join(root, "lock-ready");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "current.jsonl"), `${JSON.stringify({ id: "local", time: 1 })}\n`, "utf8");
  const holder = spawn(process.execPath, [
    "-e",
    [
      "const fs=require('node:fs');",
      "const lock=process.argv[1];",
      "const ready=process.argv[2];",
      "fs.writeFileSync(lock, 'held\\n');",
      "fs.writeFileSync(ready, 'ready\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);",
      "fs.unlinkSync(lock);"
    ].join(""),
    lockPath,
    readyPath
  ], { stdio: "ignore" });
  t.after(() => {
    if (holder.exitCode == null) holder.kill();
  });
  await waitForFile(readyPath);

  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));
  const remoteJsonl = `${JSON.stringify({ id: "remote", time: 2 })}\n`;
  const startedAt = Date.now();
  const result = service.merge({
    roleId: "Rabi",
    path: "conversation/current.jsonl",
    contentBase64: Buffer.from(remoteJsonl).toString("base64")
  });
  const elapsedMs = Date.now() - startedAt;
  if (holder.exitCode == null) await once(holder, "exit");

  assert.equal(result.status, "merged");
  assert.ok(elapsedMs >= 200, `Expected merge to wait for the live conversation lock, waited ${elapsedMs}ms.`);
});

test("persona sync refuses files reached through persona symlinks or junctions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-link-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const outside = path.join(root, "outside");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.md"), "outside\n", "utf8");
  try {
    fs.symlinkSync(outside, path.join(roleRoot, "linked"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("This Windows environment does not permit junction creation.");
      return;
    }
    throw error;
  }
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "sync-state"));

  assert.equal((await service.manifest("Rabi")).roles[0]?.files.some(file => file.path.startsWith("linked/")), false);
  assert.throws(() => service.readFile("Rabi", "linked/secret.md"), /symbolic links|junctions/i);
  assert.throws(() => service.merge({
    roleId: "Rabi",
    path: "linked/new.md",
    contentBase64: Buffer.from("blocked\n").toString("base64")
  }), /symbolic links|junctions/i);
  assert.equal(fs.existsSync(path.join(outside, "new.md")), false);
});
