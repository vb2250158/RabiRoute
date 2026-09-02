import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalPlanStorageName } from "./planStorageLayout.js";
import {
  applyActivePlanPackage,
  applyArchivedPlanPackage,
  archivedPlanPackageInventory,
  createActivePlanPackageCommand,
  createActivePlanPackageCommandFromFiles,
  createArchivedPlanPackageCommand,
  recoverPersonaSyncPlanPackageTransactions,
  MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES
} from "./personaSyncPlanPackage.js";

type Fixture = {
  root: string;
  roleDir: string;
};

function fixture(t: test.TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-package-"));
  const roleDir = path.join(root, "roles", "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, roleDir };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function directoryByteSnapshot(root: string): Array<[string, string]> {
  if (!fs.existsSync(root)) return [];
  const files: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push([path.relative(root, target).replace(/\\/g, "/"), fs.readFileSync(target).toString("hex")]);
    }
  };
  visit(root);
  return files;
}

function activePlan(planId: string, status = "进行中", updatedAt = "2026-08-31T10:00:00.000Z") {
  return {
    id: planId,
    title: `Plan ${planId}`,
    focus: `Focus ${planId}`,
    status,
    createdAt: "2026-08-31T09:00:00.000Z",
    updatedAt,
    ...(status === "已完成" ? { completedAt: "2026-08-31T10:00:00.000Z" } : {})
  };
}

function writeActivePackage(
  roleDir: string,
  planId: string,
  options: { status?: string; attachment?: string } = {}
): string {
  const directory = path.join(roleDir, "plans", "active", canonicalPlanStorageName(planId));
  const plan = activePlan(planId, options.status);
  const history = {
    id: `${planId}-history-1`,
    planId,
    kind: "updated",
    before: null,
    after: plan
  };
  writeJson(path.join(directory, "plan.json"), plan);
  fs.writeFileSync(path.join(directory, "history.jsonl"), `${JSON.stringify(history)}\n`, "utf8");
  fs.mkdirSync(path.join(directory, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(directory, "attachments", "evidence.txt"), options.attachment ?? "active evidence\n", "utf8");
  return directory;
}

function writeArchivePackage(roleDir: string, planId: string, attachment = "active evidence\n"): string {
  const directory = path.join(roleDir, "plans", "archive", canonicalPlanStorageName(planId));
  const completed = activePlan(planId, "已完成");
  const archived = {
    ...completed,
    status: "已归档",
    archivedAt: "2026-08-31T11:00:00.000Z",
    updatedAt: "2026-08-31T11:00:00.000Z"
  };
  const history = [
    {
      id: `${planId}-history-1`,
      planId,
      kind: "updated",
      before: null,
      after: completed
    },
    {
      id: `${planId}-history-2`,
      planId,
      kind: "archived",
      before: completed,
      after: archived
    }
  ];
  writeJson(path.join(directory, "plan.json"), archived);
  fs.writeFileSync(path.join(directory, "history.jsonl"), `${history.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
  fs.mkdirSync(path.join(directory, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(directory, "attachments", "evidence.txt"), attachment, "utf8");
  return directory;
}

test("active plan packages publish one physical inventory and recreate a missing same-hash receipt", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "active-package";
  const sourceDirectory = writeActivePackage(source.roleDir, planId);
  const command = createActivePlanPackageCommand("Rabi", planId, sourceDirectory, "peer-a");

  const first = applyActivePlanPackage(destination.roleDir, command);
  assert.equal(first.status, "applied");
  assert.ok(first.receiptPath && fs.existsSync(first.receiptPath));
  const target = path.join(destination.roleDir, "plans", "active", command.storageId);
  assert.equal(archivedPlanPackageInventory(target).hash, command.inventoryHash);
  assert.equal(archivedPlanPackageInventory(target).files.length, command.files.length);

  const committedAt = JSON.parse(fs.readFileSync(first.receiptPath!, "utf8")).committedAt;
  const unchanged = applyActivePlanPackage(destination.roleDir, command);
  assert.equal(unchanged.status, "unchanged");
  assert.equal(JSON.parse(fs.readFileSync(unchanged.receiptPath!, "utf8")).committedAt, committedAt);

  fs.unlinkSync(unchanged.receiptPath!);
  const recovered = applyActivePlanPackage(destination.roleDir, command);
  assert.equal(recovered.status, "unchanged");
  assert.ok(recovered.receiptPath && fs.existsSync(recovered.receiptPath));
});

test("startup recovery recreates a package receipt after payload publication consumed the stage", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "published-before-receipt";
  const sourceDirectory = writeActivePackage(source.roleDir, planId);
  fs.writeFileSync(
    path.join(sourceDirectory, "attachments", "manifest.json"),
    `${JSON.stringify({ kind: "business_attachment_manifest", planId })}\n`,
    "utf8"
  );
  const command = createActivePlanPackageCommand(
    "Rabi",
    planId,
    sourceDirectory,
    "peer-a"
  );
  const applied = applyActivePlanPackage(destination.roleDir, command);
  assert.equal(applied.status, "applied");
  assert.ok(applied.receiptPath);
  const target = path.join(destination.roleDir, "plans", "active", command.storageId);
  const transactionRoot = path.join(
    destination.roleDir,
    "plans",
    "quarantine",
    "plan-storage-package-transactions",
    command.storageId,
    `persona_sync_active_${command.inventoryHash}`
  );
  fs.cpSync(target, path.join(transactionRoot, "payload"), { recursive: true });
  fs.unlinkSync(applied.receiptPath!);

  const recovered = recoverPersonaSyncPlanPackageTransactions(destination.roleDir);

  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.results[0]?.status, "unchanged");
  assert.equal(recovered.results[0]?.inventoryHash, command.inventoryHash);
  assert.ok(recovered.results[0]?.receiptPath && fs.existsSync(recovered.results[0].receiptPath));
});

test("one canonical storage identity never aliases two distinct logical plan ids", (t) => {
  const firstSource = fixture(t);
  const secondSource = fixture(t);
  const destination = fixture(t);
  const receiptOnlyDestination = fixture(t);
  const sharedPrefix = "p".repeat(100);
  const firstPlanId = `${sharedPrefix}-local`;
  const secondPlanId = `${sharedPrefix}-remote`;
  const first = createActivePlanPackageCommand(
    "Rabi",
    firstPlanId,
    writeActivePackage(firstSource.roleDir, firstPlanId),
    "peer-a"
  );
  const second = createActivePlanPackageCommand(
    "Rabi",
    secondPlanId,
    writeActivePackage(secondSource.roleDir, secondPlanId),
    "peer-b"
  );
  assert.equal(first.storageId, second.storageId);

  assert.equal(applyActivePlanPackage(destination.roleDir, first).status, "applied");
  const target = path.join(destination.roleDir, "plans", "active", first.storageId);
  const original = archivedPlanPackageInventory(target).hash;
  assert.throws(() => applyActivePlanPackage(destination.roleDir, second), /storage identity collision/i);
  assert.equal(archivedPlanPackageInventory(target).hash, original);

  assert.equal(applyActivePlanPackage(receiptOnlyDestination.roleDir, first).status, "applied");
  fs.rmSync(path.join(receiptOnlyDestination.roleDir, "plans", "active", first.storageId), {
    recursive: true,
    force: true
  });
  assert.throws(
    () => applyActivePlanPackage(receiptOnlyDestination.roleDir, second),
    /storage identity collision/i
  );
});

test("persona sync rejects a sigma/final-sigma storage alias before staging or receipts", (t) => {
  const firstSource = fixture(t);
  const secondSource = fixture(t);
  const destination = fixture(t);
  const firstPlanId = "sync-σ";
  const collidingPlanId = "sync-ς";
  const first = createActivePlanPackageCommand(
    "Rabi",
    firstPlanId,
    writeActivePackage(firstSource.roleDir, firstPlanId),
    "peer-a"
  );
  const second = createActivePlanPackageCommand(
    "Rabi",
    collidingPlanId,
    writeActivePackage(secondSource.roleDir, collidingPlanId),
    "peer-b"
  );
  assert.notEqual(first.storageId, second.storageId);
  assert.equal(applyActivePlanPackage(destination.roleDir, first).status, "applied");
  const plansRoot = path.join(destination.roleDir, "plans");
  const before = directoryByteSnapshot(plansRoot);

  assert.throws(() => applyActivePlanPackage(destination.roleDir, second), /storage identity collision/i);

  assert.deepEqual(directoryByteSnapshot(plansRoot), before);
  assert.equal(
    archivedPlanPackageInventory(path.join(destination.roleDir, "plans", "active", first.storageId)).hash,
    first.inventoryHash
  );
});

test("a terminal archive package atomically wins only when it proves dominance over active", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "archive-dominates";
  const archiveSource = writeArchivePackage(source.roleDir, planId);
  writeActivePackage(destination.roleDir, planId, { status: "已完成" });
  const command = createArchivedPlanPackageCommand("Rabi", planId, archiveSource, "peer-a");

  const result = applyArchivedPlanPackage(destination.roleDir, command);
  assert.equal(result.status, "applied");
  const active = path.join(destination.roleDir, "plans", "active", command.storageId);
  const archive = path.join(destination.roleDir, "plans", "archive", command.storageId);
  assert.equal(fs.existsSync(active), false);
  assert.equal(archivedPlanPackageInventory(archive).hash, command.inventoryHash);
  assert.ok(result.quarantinePath && fs.existsSync(result.quarantinePath));
  assert.ok(result.receiptPath && fs.existsSync(result.receiptPath));
});

test("an applied archive receipt recreates its missing canonical payload", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "archive-replay";
  const command = createArchivedPlanPackageCommand(
    "Rabi",
    planId,
    writeArchivePackage(source.roleDir, planId),
    "peer-a"
  );
  const archive = path.join(destination.roleDir, "plans", "archive", command.storageId);

  const first = applyArchivedPlanPackage(destination.roleDir, command);
  assert.equal(first.status, "applied");
  fs.rmSync(archive, { recursive: true, force: true });

  const replayed = applyArchivedPlanPackage(destination.roleDir, command);
  assert.equal(replayed.status, "applied");
  assert.equal(archivedPlanPackageInventory(archive).hash, command.inventoryHash);
  assert.equal(replayed.receiptPath, first.receiptPath);
});

test("an archive that cannot prove full active preservation stays out of the live archive root", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "archive-not-dominant";
  const archiveSource = writeArchivePackage(source.roleDir, planId, "old evidence\n");
  const active = writeActivePackage(destination.roleDir, planId, {
    status: "已完成",
    attachment: "newer active-only evidence\n"
  });
  const activeHash = archivedPlanPackageInventory(active).hash;
  const command = createArchivedPlanPackageCommand("Rabi", planId, archiveSource, "peer-a");

  const result = applyArchivedPlanPackage(destination.roleDir, command);
  assert.equal(result.status, "conflict");
  assert.match(result.reason || "", /does_not_prove_dominance/);
  assert.equal(archivedPlanPackageInventory(active).hash, activeHash);
  assert.equal(fs.existsSync(path.join(destination.roleDir, "plans", "archive", command.storageId)), false);
  assert.ok(result.quarantinePath && fs.existsSync(result.quarantinePath));
  assert.equal(archivedPlanPackageInventory(result.quarantinePath!).hash, command.inventoryHash);
});

test("divergent canonical storage preserves incoming evidence while invalid orphan storage fails closed", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "divergent-active";
  const sourceDirectory = writeActivePackage(source.roleDir, planId, { attachment: "incoming\n" });
  const existingDirectory = writeActivePackage(destination.roleDir, planId, { attachment: "existing\n" });
  const existingHash = archivedPlanPackageInventory(existingDirectory).hash;
  const command = createActivePlanPackageCommand("Rabi", planId, sourceDirectory, "peer-a");

  const divergent = applyActivePlanPackage(destination.roleDir, command);
  assert.equal(divergent.status, "conflict");
  assert.equal(archivedPlanPackageInventory(existingDirectory).hash, existingHash);
  assert.ok(divergent.quarantinePath && fs.existsSync(divergent.quarantinePath));
  assert.equal(archivedPlanPackageInventory(divergent.quarantinePath!).hash, command.inventoryHash);

  const orphanSource = fixture(t);
  const orphanDestination = fixture(t);
  const orphanPlanId = "orphan-active";
  const orphanCommand = createActivePlanPackageCommand(
    "Rabi",
    orphanPlanId,
    writeActivePackage(orphanSource.roleDir, orphanPlanId),
    "peer-a"
  );
  const orphan = path.join(orphanDestination.roleDir, "plans", "active", orphanCommand.storageId);
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "history.jsonl"), "orphan\n", "utf8");
  assert.throws(
    () => applyActivePlanPackage(orphanDestination.roleDir, orphanCommand),
    /identity collision.*invalid storage/i
  );
  assert.equal(fs.existsSync(path.join(orphan, "plan.json")), false);
});

test("an archived plan is terminal and quarantines a later active package without resurrection", (t) => {
  const source = fixture(t);
  const destination = fixture(t);
  const planId = "terminal-plan";
  const activeCommand = createActivePlanPackageCommand(
    "Rabi",
    planId,
    writeActivePackage(source.roleDir, planId),
    "peer-a"
  );
  writeArchivePackage(destination.roleDir, planId);

  const result = applyActivePlanPackage(destination.roleDir, activeCommand);
  assert.equal(result.status, "conflict");
  assert.match(result.reason || "", /archive_is_terminal/);
  assert.equal(fs.existsSync(path.join(destination.roleDir, "plans", "active", activeCommand.storageId)), false);
  assert.ok(result.quarantinePath && fs.existsSync(result.quarantinePath));
  assert.equal(archivedPlanPackageInventory(result.quarantinePath!).hash, activeCommand.inventoryHash);
});

test("portable plan packages reject Windows aliases, hidden transient files, and oversized members", (t) => {
  const data = fixture(t);
  const planId = "portable-paths";
  const source = writeActivePackage(data.roleDir, planId);
  const command = createActivePlanPackageCommand("Rabi", planId, source);
  const attachment = command.files.find(file => file.path === "attachments/evidence.txt")!;
  const invalidPaths = [
    "/attachments/evidence.txt",
    "attachments\\evidence.txt",
    "attachments/../evidence.txt",
    "attachments/CON.txt",
    "attachments/trailing. ",
    "attachments/.hidden",
    "attachments/evidence.part"
  ];
  for (const invalidPath of invalidPaths) {
    assert.throws(() => createActivePlanPackageCommandFromFiles("Rabi", planId, [
      ...command.files.filter(file => file.path !== attachment.path),
      { ...attachment, path: invalidPath }
    ]), /portable|Windows-unsafe|transient/i);
  }
  assert.throws(() => createActivePlanPackageCommandFromFiles("Rabi", planId, [
    ...command.files,
    { ...command.files.find(file => file.path === "plan.json")!, path: "Plan.json" }
  ]), /collision/i);
  assert.throws(
    () => createActivePlanPackageCommandFromFiles("Rabi", ` ${planId}`, command.files),
    /trimmed|canonical logical plan id/i
  );
  assert.throws(
    () => createActivePlanPackageCommandFromFiles("Rabi", "e\u0301", command.files),
    /normalized|canonical logical plan id/i
  );
  assert.throws(
    () => applyActivePlanPackage(data.roleDir, { ...command, storageId: command.storageId.toUpperCase() }),
    /storage identity/i
  );

  fs.writeFileSync(path.join(source, ".gitkeep"), "", "utf8");
  assert.throws(() => createActivePlanPackageCommand("Rabi", planId, source), /Windows-unsafe/i);
  fs.unlinkSync(path.join(source, ".gitkeep"));
  const large = path.join(source, "attachments", "large.bin");
  const descriptor = fs.openSync(large, "w");
  try {
    fs.ftruncateSync(descriptor, MAX_PERSONA_SYNC_PLAN_PACKAGE_FILE_BYTES + 1);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.throws(() => createActivePlanPackageCommand("Rabi", planId, source), /too large/i);
});
