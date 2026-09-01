import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanStorageStartupGateError, runPlanStorageStartupGate } from "./planStorageStartupGate.js";

function fixture(): { root: string; rolesRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-startup-gate-"));
  const rolesRoot = path.join(root, "roles");
  fs.mkdirSync(path.join(rolesRoot, "YeYu"), { recursive: true });
  fs.mkdirSync(path.join(rolesRoot, "Rabi"), { recursive: true });
  return { root, rolesRoot };
}

function emptyGateOptions(rolesRoot: string) {
  return {
    rolesRoot,
    readOnly: false,
    recoverRoleLifecycle: async () => { throw new Error("must not run"); },
    migrateRole: async () => { throw new Error("must not run"); },
    recoverRoleFeedback: async () => { throw new Error("must not run"); },
    recoverRolePackages: async () => { throw new Error("must not run"); }
  };
}

test("fresh install treats a missing roles root as an empty writable catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-startup-gate-empty-"));
  const rolesRoot = path.join(root, "data", "roles");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const summary = await runPlanStorageStartupGate(emptyGateOptions(rolesRoot));

  assert.deepEqual(summary, { roles: 0, migrated: 0, reconciled: 0, failures: [], skipped: false });
  assert.equal(fs.existsSync(rolesRoot), false);
});

test("non-directory and inaccessible roles roots still fail closed", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-startup-gate-invalid-"));
  const nonDirectoryRoot = path.join(root, "roles-file");
  fs.writeFileSync(nonDirectoryRoot, "not a directory", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    runPlanStorageStartupGate(emptyGateOptions(nonDirectoryRoot)),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR"
  );

  const inaccessibleRoot = path.join(root, "inaccessible-roles");
  const originalReaddir = fs.promises.readdir;
  fs.promises.readdir = (async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(inaccessibleRoot)) {
      const error = new Error("access denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return originalReaddir(target, options as never);
  }) as typeof fs.promises.readdir;
  try {
    await assert.rejects(
      runPlanStorageStartupGate(emptyGateOptions(inaccessibleRoot)),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES"
    );
  } finally {
    fs.promises.readdir = originalReaddir;
  }
});

test("plan storage startup gate completes every role before granting plan storage read/mutation eligibility", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const visited: string[] = [];
  const summary = await runPlanStorageStartupGate({
    rolesRoot: data.rolesRoot,
    readOnly: false,
    yieldControl: async () => undefined,
    recoverRoleLifecycle: async roleDir => {
      visited.push(`lifecycle:${path.basename(roleDir)}`);
      return { results: [], failures: [] };
    },
    migrateRole: async roleDir => {
      visited.push(`migrate:${path.basename(roleDir)}`);
      return { migrated: 1, skipped: 0, reconciled: 1, alreadyReconciled: 0, receipts: [], failures: [] };
    },
    recoverRoleFeedback: async roleDir => {
      visited.push(`feedback:${path.basename(roleDir)}`);
      return { committed: 0, alreadyCommitted: 0, failures: [] };
    },
    recoverRolePackages: async roleDir => {
      visited.push(`recover:${path.basename(roleDir)}`);
      return { results: [], errors: [] };
    }
  });
  assert.deepEqual(visited, [
    "lifecycle:Rabi",
    "migrate:Rabi",
    "feedback:Rabi",
    "recover:Rabi",
    "lifecycle:YeYu",
    "migrate:YeYu",
    "feedback:YeYu",
    "recover:YeYu"
  ]);
  assert.deepEqual(summary, { roles: 2, migrated: 2, reconciled: 2, failures: [], skipped: false });
});

test("plan storage startup gate fails closed with exact role and plan evidence", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await assert.rejects(runPlanStorageStartupGate({
    rolesRoot: data.rolesRoot,
    readOnly: false,
    yieldControl: async () => undefined,
    recoverRoleLifecycle: async () => ({ results: [], failures: [] }),
    migrateRole: async roleDir => ({
      migrated: 0,
      skipped: 0,
      reconciled: 0,
      alreadyReconciled: 0,
      receipts: [],
      failures: path.basename(roleDir) === "YeYu" ? [{ planId: "plan-1", error: "dual root" }] : []
    }),
    recoverRoleFeedback: async () => ({ committed: 0, alreadyCommitted: 0, failures: [] }),
    recoverRolePackages: async () => ({ results: [], errors: [] })
  }), (error: unknown) => {
    assert.ok(error instanceof PlanStorageStartupGateError);
    assert.deepEqual(error.summary.failures, ["YeYu:plan-1:dual root"]);
    return true;
  });
});

test("read-only startup explicitly skips mutation without probing the roles root", async () => {
  const summary = await runPlanStorageStartupGate({
    rolesRoot: "Q:\\example-unavailable-roles-root",
    readOnly: true,
    recoverRoleLifecycle: async () => { throw new Error("must not run"); },
    migrateRole: async () => { throw new Error("must not run"); },
    recoverRoleFeedback: async () => { throw new Error("must not run"); },
    recoverRolePackages: async () => { throw new Error("must not run"); }
  });
  assert.equal(summary.skipped, true);
  assert.equal(summary.roles, 0);
});

test("plan storage startup gate withholds plan storage read/mutation eligibility when package recovery is unresolved", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await assert.rejects(runPlanStorageStartupGate({
    rolesRoot: data.rolesRoot,
    readOnly: false,
    yieldControl: async () => undefined,
    recoverRoleLifecycle: async () => ({ results: [], failures: [] }),
    migrateRole: async () => ({
      migrated: 0,
      skipped: 0,
      reconciled: 0,
      alreadyReconciled: 0,
      receipts: [],
      failures: []
    }),
    recoverRoleFeedback: async () => ({ committed: 0, alreadyCommitted: 0, failures: [] }),
    recoverRolePackages: async roleDir => path.basename(roleDir) === "YeYu"
      ? {
        results: [{ status: "conflict", planId: "plan-2", reason: "prepared_stage_is_invalid" }],
        errors: [{ receiptPath: "plans/quarantine/tx.json", message: "receipt is malformed" }]
      }
      : { results: [], errors: [] }
  }), (error: unknown) => {
    assert.ok(error instanceof PlanStorageStartupGateError);
    assert.deepEqual(error.summary.failures, [
      "YeYu:plan-2:package_recovery:prepared_stage_is_invalid",
      "YeYu:plans/quarantine/tx.json:package_recovery:receipt is malformed"
    ]);
    return true;
  });
});

test("plan storage startup gate blocks migration when lifecycle recovery fails", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const migrated: string[] = [];
  await assert.rejects(runPlanStorageStartupGate({
    rolesRoot: data.rolesRoot,
    readOnly: false,
    yieldControl: async () => undefined,
    recoverRoleLifecycle: async roleDir => path.basename(roleDir) === "Rabi"
      ? { results: [], failures: [{ transactionPath: "plans/quarantine/lifecycle/tx/manifest.json", error: "source inventory changed" }] }
      : { results: [], failures: [] },
    migrateRole: async roleDir => {
      migrated.push(path.basename(roleDir));
      return { migrated: 0, skipped: 0, reconciled: 0, alreadyReconciled: 0, receipts: [], failures: [] };
    },
    recoverRoleFeedback: async () => ({ committed: 0, alreadyCommitted: 0, failures: [] }),
    recoverRolePackages: async () => ({ results: [], errors: [] })
  }), (error: unknown) => {
    assert.ok(error instanceof PlanStorageStartupGateError);
    assert.deepEqual(error.summary.failures, [
      "Rabi:plans/quarantine/lifecycle/tx/manifest.json:lifecycle_recovery:source inventory changed"
    ]);
    return true;
  });
  assert.deepEqual(migrated, ["YeYu"]);
});

test("plan storage startup gate blocks package recovery when feedback WAL recovery fails", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const packageRecovered: string[] = [];
  await assert.rejects(runPlanStorageStartupGate({
    rolesRoot: data.rolesRoot,
    readOnly: false,
    yieldControl: async () => undefined,
    recoverRoleLifecycle: async () => ({ results: [], failures: [] }),
    migrateRole: async () => ({
      migrated: 0,
      skipped: 0,
      reconciled: 0,
      alreadyReconciled: 0,
      receipts: [],
      failures: []
    }),
    recoverRoleFeedback: async roleDir => path.basename(roleDir) === "YeYu"
      ? {
        committed: 0,
        alreadyCommitted: 0,
        failures: [{ transactionPath: "plans/quarantine/feedback/tx/manifest.json", error: "ledger target changed" }]
      }
      : { committed: 0, alreadyCommitted: 0, failures: [] },
    recoverRolePackages: async roleDir => {
      packageRecovered.push(path.basename(roleDir));
      return { results: [], errors: [] };
    }
  }), (error: unknown) => {
    assert.ok(error instanceof PlanStorageStartupGateError);
    assert.deepEqual(error.summary.failures, [
      "YeYu:plans/quarantine/feedback/tx/manifest.json:feedback_recovery:ledger target changed"
    ]);
    return true;
  });
  assert.deepEqual(packageRecovered, ["Rabi"]);
});
