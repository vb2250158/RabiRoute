import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  legacyActivePlanFile,
  legacyPlanAttachmentDirectory,
  legacyPlanFeedbackFile,
  legacyPlanHistoryFile
} from "./planStorageLegacyLayout.js";
import {
  planAttachmentDirectory,
  planDirectory,
  planFeedbackFile,
  planHistoryFile,
  planJsonFile
} from "./planStorageLayout.js";
import { migrateRolePlanLayout } from "./planStorageMigration.js";
import { recoverPlanLifecycleTransitions } from "./planStorageRepository.js";

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function migrate(roleDir: string) {
  return migrateRolePlanLayout(roleDir, {
    normalizePlan: (raw, fallbackId) => ({
      ...raw,
      id: String(raw.id || fallbackId),
      status: raw.status
    })
  });
}

function fixture(t: test.TestContext, divergent: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-legacy-canonical-"));
  const roleDir = path.join(root, "roles", "YeYu");
  const planId = divergent ? "legacy-canonical-divergent" : "legacy-canonical-equal";
  const canonicalPlan = {
    id: planId,
    title: "Canonical plan",
    focus: divergent ? "canonical version" : "same version",
    status: "进行中",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
  const legacyPlan = divergent ? { ...canonicalPlan, focus: "legacy version" } : canonicalPlan;
  const history = `${JSON.stringify({
    id: `${planId}-history`,
    planId,
    kind: "created",
    recordedAt: canonicalPlan.updatedAt,
    after: legacyPlan
  })}\n`;
  writeFile(planJsonFile(roleDir, planId, "active"), `${JSON.stringify(canonicalPlan, null, 2)}\n`);
  writeFile(planHistoryFile(roleDir, planId, "active"), divergent
    ? `${JSON.stringify({
        id: `${planId}-history`,
        planId,
        kind: "created",
        recordedAt: canonicalPlan.updatedAt,
        after: canonicalPlan
      })}\n`
    : history);
  writeFile(legacyActivePlanFile(roleDir, planId), `${JSON.stringify(legacyPlan, null, 2)}\n`);
  writeFile(legacyPlanHistoryFile(roleDir, planId), history);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { roleDir, planId };
}

function firstLayoutFixture(t: test.TestContext, suffix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-legacy-first-${suffix}-`));
  const roleDir = path.join(root, "roles", "YeYu");
  const planId = `legacy-first-${suffix}`;
  const legacyAttachment = path.join(legacyPlanAttachmentDirectory(roleDir, planId), "evidence.txt");
  const destinationAttachment = path.join(planAttachmentDirectory(roleDir, planId, "active"), "evidence.txt");
  const plan = {
    id: planId,
    title: "Legacy-only plan",
    focus: "preserve the only copy",
    status: "进行中",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    evidence: { path: legacyAttachment }
  };
  const history = `${JSON.stringify({
    id: `${planId}-history`,
    planId,
    kind: "created",
    recordedAt: plan.updatedAt,
    after: plan,
    evidence: { path: legacyAttachment }
  })}\n`;
  const feedback = `${JSON.stringify({
    id: `${planId}-feedback`,
    planId,
    createdAt: plan.updatedAt,
    evidence: { path: legacyAttachment }
  })}\n`;
  writeFile(legacyActivePlanFile(roleDir, planId), `${JSON.stringify(plan, null, 2)}\n`);
  writeFile(legacyPlanHistoryFile(roleDir, planId), history);
  writeFile(legacyPlanFeedbackFile(roleDir, planId), feedback);
  writeFile(legacyAttachment, "only-copy\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    roleDir,
    planId,
    legacyAttachment,
    destinationAttachment,
    legacyPlanFile: legacyActivePlanFile(roleDir, planId),
    legacyHistoryFile: legacyPlanHistoryFile(roleDir, planId),
    legacyFeedbackFile: legacyPlanFeedbackFile(roleDir, planId),
    destinationPlanFile: planJsonFile(roleDir, planId, "active"),
    destinationHistoryFile: planHistoryFile(roleDir, planId, "active"),
    destinationFeedbackFile: planFeedbackFile(roleDir, planId, "active")
  };
}

function withLegacyRetirementFailure<T>(legacyArtifactFile: string, callback: () => T): T {
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
    const [source, destination] = args;
    if (
      path.resolve(String(source)) === path.resolve(legacyArtifactFile)
      && String(destination).includes(`${path.sep}plan-storage-legacy-resolutions${path.sep}`)
    ) {
      injected = true;
      const error = new Error("injected legacy retirement failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return originalRename(...args);
  }) as typeof fs.renameSync;
  try {
    return callback();
  } finally {
    fs.renameSync = originalRename;
    assert.equal(injected, true);
  }
}

function crashMigrationAt(
  roleDir: string,
  planId: string,
  point: "before-canonical-publish" | "after-canonical-publish"
) {
  const repositoryUrl = new URL("./planStorageRepository.ts", import.meta.url).href;
  const migrationUrl = new URL("./planStorageMigration.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    import { subscribePlanStorageBeforeMutation } from ${JSON.stringify(repositoryUrl)};
    import { migrateRolePlanLayout } from ${JSON.stringify(migrationUrl)};
    const roleDir = process.env.RABIROUTE_MIGRATION_TEST_ROLE_DIR;
    const planId = process.env.RABIROUTE_MIGRATION_TEST_PLAN_ID;
    const point = process.env.RABIROUTE_MIGRATION_TEST_CRASH_POINT;
    const canonicalDirectory = process.env.RABIROUTE_MIGRATION_TEST_CANONICAL_DIR;
    if (!roleDir || !planId || !point || !canonicalDirectory) {
      throw new Error("migration crash fixture input is missing");
    }
    if (point === "before-canonical-publish") {
      let mutations = 0;
      subscribePlanStorageBeforeMutation(event => {
        if (event.planId === planId && ++mutations === 2) process.kill(process.pid, "SIGKILL");
      });
    } else {
      const originalRename = fs.renameSync;
      fs.renameSync = (...args) => {
        const result = originalRename(...args);
        if (path.resolve(String(args[1])) === path.resolve(canonicalDirectory)) {
          process.kill(process.pid, "SIGKILL");
        }
        return result;
      };
    }
    migrateRolePlanLayout(roleDir, {
      normalizePlan: (raw, fallbackId) => ({
        ...raw,
        id: String(raw.id || fallbackId),
        status: raw.status
      })
    });
    process.exit(97);
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RABIROUTE_MIGRATION_TEST_CANONICAL_DIR: planDirectory(roleDir, planId, "active"),
      RABIROUTE_MIGRATION_TEST_CRASH_POINT: point,
      RABIROUTE_MIGRATION_TEST_PLAN_ID: planId,
      RABIROUTE_MIGRATION_TEST_ROLE_DIR: roleDir
    },
    timeout: 30_000
  });
}

function assertCanonicalProjection(data: ReturnType<typeof firstLayoutFixture>): void {
  assert.equal(fs.readFileSync(data.destinationAttachment, "utf8"), "only-copy\n");
  const migratedPlan = JSON.parse(fs.readFileSync(data.destinationPlanFile, "utf8")) as {
    evidence?: { path?: unknown };
  };
  assert.equal(migratedPlan.evidence?.path, data.destinationAttachment);
  const migratedHistory = JSON.parse(fs.readFileSync(data.destinationHistoryFile, "utf8").trim()) as {
    evidence?: { path?: unknown };
  };
  const migratedFeedback = JSON.parse(fs.readFileSync(data.destinationFeedbackFile, "utf8").trim()) as {
    evidence?: { path?: unknown };
  };
  assert.equal(migratedHistory.evidence?.path, data.destinationAttachment);
  assert.equal(migratedFeedback.evidence?.path, data.destinationAttachment);
}

test("startup migration retires a byte-equivalent legacy source beside its canonical target", (t) => {
  const data = fixture(t, false);
  const canonicalPlanHash = sha256File(planJsonFile(data.roleDir, data.planId, "active"));
  const canonicalHistoryHash = sha256File(planHistoryFile(data.roleDir, data.planId, "active"));

  const first = migrate(data.roleDir);

  assert.deepEqual(first.failures, []);
  assert.equal(first.migrated, 1);
  assert.equal(fs.existsSync(legacyActivePlanFile(data.roleDir, data.planId)), false);
  assert.equal(fs.existsSync(legacyPlanHistoryFile(data.roleDir, data.planId)), false);
  assert.equal(sha256File(planJsonFile(data.roleDir, data.planId, "active")), canonicalPlanHash);
  assert.equal(sha256File(planHistoryFile(data.roleDir, data.planId, "active")), canonicalHistoryHash);
  assert.equal(first.receipts.length, 1);
  const receipt = JSON.parse(fs.readFileSync(first.receipts[0]!, "utf8")) as {
    status?: unknown;
    evidenceDirectory?: unknown;
  };
  assert.equal(receipt.status, "duplicate_retired");
  assert.equal(typeof receipt.evidenceDirectory, "string");
  assert.equal(fs.existsSync(String(receipt.evidenceDirectory)), true);

  const repeated = migrate(data.roleDir);
  assert.deepEqual(repeated.failures, []);
  assert.equal(repeated.migrated, 0);
});

test("startup migration quarantines a divergent legacy source without changing its canonical target", (t) => {
  const data = fixture(t, true);
  const canonicalPlanHash = sha256File(planJsonFile(data.roleDir, data.planId, "active"));
  const canonicalHistoryHash = sha256File(planHistoryFile(data.roleDir, data.planId, "active"));

  const first = migrate(data.roleDir);

  assert.deepEqual(first.failures, []);
  assert.equal(first.migrated, 1);
  assert.equal(fs.existsSync(legacyActivePlanFile(data.roleDir, data.planId)), false);
  assert.equal(fs.existsSync(legacyPlanHistoryFile(data.roleDir, data.planId)), false);
  assert.equal(sha256File(planJsonFile(data.roleDir, data.planId, "active")), canonicalPlanHash);
  assert.equal(sha256File(planHistoryFile(data.roleDir, data.planId, "active")), canonicalHistoryHash);
  const receipt = JSON.parse(fs.readFileSync(first.receipts[0]!, "utf8")) as {
    status?: unknown;
    evidenceDirectory?: unknown;
  };
  assert.equal(receipt.status, "conflict_quarantined");
  const evidenceDirectory = String(receipt.evidenceDirectory);
  assert.equal(fs.existsSync(path.join(evidenceDirectory, "legacy", "plan.json")), true);
  assert.equal(fs.existsSync(path.join(evidenceDirectory, "legacy", "history.jsonl")), true);
  assert.equal(fs.existsSync(path.join(evidenceDirectory, "canonical", "plan.json")), true);
  assert.equal(fs.existsSync(path.join(evidenceDirectory, "canonical", "history.jsonl")), true);

  const repeated = migrate(data.roleDir);
  assert.deepEqual(repeated.failures, []);
  assert.equal(repeated.migrated, 0);
  assert.equal(fs.existsSync(planDirectory(data.roleDir, data.planId, "active")), true);
});

test("startup migration publishes a legacy-only plan as one lifecycle snapshot before retiring legacy artifacts", (t) => {
  const data = firstLayoutFixture(t, "lifecycle");

  const first = migrate(data.roleDir);

  assert.deepEqual(first.failures, []);
  assert.equal(first.migrated, 1);
  assert.equal(first.receipts.length, 2);
  const receiptKinds = first.receipts.map(receiptPath => {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { kind?: unknown };
    return receipt.kind;
  });
  assert.deepEqual(receiptKinds, [
    "plan_storage_lifecycle_transition_receipt",
    "plan_storage_legacy_resolution_receipt"
  ]);
  assert.equal(fs.existsSync(data.legacyPlanFile), false);
  assert.equal(fs.existsSync(data.legacyHistoryFile), false);
  assert.equal(fs.existsSync(data.legacyFeedbackFile), false);
  assertCanonicalProjection(data);

  const repeated = migrate(data.roleDir);
  assert.deepEqual(repeated.failures, []);
  assert.equal(repeated.migrated, 0);
});

test("startup migration rejects missing or identity-invalid legacy history before canonical publication", async (t) => {
  for (const fault of ["missing", "wrong-identity"] as const) {
    await t.test(fault, (t) => {
      const data = firstLayoutFixture(t, `history-${fault}`);
      if (fault === "missing") {
        fs.unlinkSync(data.legacyHistoryFile);
      } else {
        const history = JSON.parse(fs.readFileSync(data.legacyHistoryFile, "utf8").trim()) as Record<string, unknown>;
        writeFile(data.legacyHistoryFile, `${JSON.stringify({ ...history, planId: "another-plan" })}\n`);
      }

      const failed = migrate(data.roleDir);

      assert.equal(failed.migrated, 0);
      assert.equal(failed.failures.length, 1);
      assert.deepEqual(failed.receipts, []);
      assert.equal(fs.existsSync(planDirectory(data.roleDir, data.planId, "active")), false);
      assert.equal(fs.existsSync(path.join(
        data.roleDir,
        "plans",
        "quarantine",
        "plan-storage-lifecycle-transactions",
        data.planId
      )), false);
      assert.equal(fs.existsSync(data.legacyPlanFile), true);
      assert.equal(fs.existsSync(data.legacyHistoryFile), fault !== "missing");
      assert.equal(fs.existsSync(data.legacyFeedbackFile), true);
      assert.equal(fs.readFileSync(data.legacyAttachment, "utf8"), "only-copy\n");
    });
  }
});

test("startup migration recovers a prepared legacy retirement instead of replaying raw moves", (t) => {
  const data = firstLayoutFixture(t, "resolution-recovery");
  const legacyPlanHash = sha256File(data.legacyPlanFile);

  const failed = withLegacyRetirementFailure(data.legacyHistoryFile, () => migrate(data.roleDir));

  assert.equal(failed.migrated, 0);
  assert.equal(failed.failures.length, 1);
  assert.equal(failed.receipts.length, 1);
  assert.equal(fs.existsSync(planDirectory(data.roleDir, data.planId, "active")), true);
  assert.equal(fs.existsSync(data.legacyPlanFile), false);
  assert.equal(fs.existsSync(data.legacyHistoryFile), true);
  assert.equal(fs.existsSync(data.legacyFeedbackFile), true);
  assert.equal(fs.readFileSync(data.legacyAttachment, "utf8"), "only-copy\n");
  const resolutionRoot = path.join(
    data.roleDir,
    "plans",
    "quarantine",
    "plan-storage-legacy-resolutions",
    data.planId
  );
  const [transactionDirectory] = fs.readdirSync(resolutionRoot);
  const retiredPlanFile = path.join(
    resolutionRoot,
    transactionDirectory!,
    "evidence",
    "legacy",
    "plan.json"
  );
  assert.equal(fs.existsSync(retiredPlanFile), true);
  assert.equal(sha256File(retiredPlanFile), legacyPlanHash);

  const recovered = migrate(data.roleDir);

  assert.deepEqual(recovered.failures, []);
  assert.equal(recovered.migrated, 1);
  assert.equal(fs.existsSync(data.legacyPlanFile), false);
  assert.equal(fs.existsSync(data.legacyHistoryFile), false);
  assert.equal(fs.existsSync(data.legacyFeedbackFile), false);
  assert.equal(sha256File(retiredPlanFile), legacyPlanHash);
  assertCanonicalProjection(data);
});

test("the next startup recovers hard termination around canonical lifecycle publication", async (t) => {
  for (const point of ["before-canonical-publish", "after-canonical-publish"] as const) {
    await t.test(point, (t) => {
      const data = firstLayoutFixture(t, point);

      const child = crashMigrationAt(data.roleDir, data.planId, point);

      assert.equal(child.error, undefined, child.stderr || child.stdout);
      assert.notEqual(child.status, 0, "fault-injection child exited successfully");
      assert.notEqual(child.status, 97, "fault-injection child reached normal migration return");
      assert.equal(fs.existsSync(data.legacyPlanFile), true);
      assert.equal(
        fs.existsSync(planDirectory(data.roleDir, data.planId, "active")),
        point === "after-canonical-publish"
      );

      const lifecycleRecovery = recoverPlanLifecycleTransitions(data.roleDir);
      assert.deepEqual(lifecycleRecovery.failures, []);
      assert.equal(
        lifecycleRecovery.results.length,
        1
      );
      assert.equal(fs.existsSync(planDirectory(data.roleDir, data.planId, "active")), true);

      const migrated = migrate(data.roleDir);

      assert.deepEqual(migrated.failures, []);
      assert.equal(migrated.migrated, 1);
      assert.equal(fs.existsSync(data.legacyPlanFile), false);
      assert.equal(fs.existsSync(data.legacyHistoryFile), false);
      assert.equal(fs.existsSync(data.legacyFeedbackFile), false);
      assertCanonicalProjection(data);

      const canonicalPlanHash = sha256File(data.destinationPlanFile);
      const repeatedLifecycleRecovery = recoverPlanLifecycleTransitions(data.roleDir);
      const repeatedMigration = migrate(data.roleDir);
      assert.deepEqual(repeatedLifecycleRecovery, { results: [], failures: [] });
      assert.deepEqual(repeatedMigration.failures, []);
      assert.equal(repeatedMigration.migrated, 0);
      assert.deepEqual(repeatedMigration.receipts, []);
      assert.equal(sha256File(data.destinationPlanFile), canonicalPlanHash);
      for (const transactionKind of [
        "plan-storage-lifecycle-transactions",
        "plan-storage-legacy-resolutions"
      ]) {
        const transactionRoot = path.join(
          data.roleDir,
          "plans",
          "quarantine",
          transactionKind,
          data.planId
        );
        assert.equal(fs.readdirSync(transactionRoot, { withFileTypes: true })
          .filter(entry => entry.isDirectory()).length, 1);
      }
    });
  }
});
