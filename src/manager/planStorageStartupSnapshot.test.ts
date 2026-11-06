import assert from "node:assert/strict";
import test from "node:test";
import { publicPlanStorageStartupSnapshot } from "./planStorageStartupSnapshot.js";
import type { PlanStorageStartupLifecycleSnapshot, PlanStorageStartupLifecycleState } from "./planStorageStartupLifecycle.js";

function snapshot(
  state: PlanStorageStartupLifecycleState,
  patch: Partial<PlanStorageStartupLifecycleSnapshot> = {}
): PlanStorageStartupLifecycleSnapshot {
  return Object.freeze({
    state,
    attempt: state === "idle" ? 0 : 1,
    incidents: state === "degraded" ? 1 : 0,
    lastTransitionAt: "2026-09-01T00:00:00.000Z",
    ...patch
  });
}

test("public startup snapshots expose stable counts without leaking paths or raw errors", () => {
  const publicSnapshot = publicPlanStorageStartupSnapshot(snapshot("degraded", {
    lastError: "failed at Z:\\ExampleShare\\Project\\data\\roles\\ExampleRole\\plans\\private",
    summary: {
      roles: 12,
      migrated: 3,
      reconciled: 4,
      failures: ["ExampleRole:Z:\\private\\transaction.json:lifecycle_recovery:token=secret"],
      skipped: false
    }
  }));
  const serialized = JSON.stringify(publicSnapshot);

  assert.equal(serialized.includes("ExampleShare"), false);
  assert.equal(serialized.includes("transaction.json"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.deepEqual(publicSnapshot.summary, {
    roles: 12,
    migrated: 3,
    reconciled: 4,
    failureCount: 1,
    skipped: false,
    readyRoles: 0
  });
  assert.equal(publicSnapshot.lastErrorCode, "PLAN_STORAGE_STARTUP_ATTEMPT_FAILED");
});

test("partial package recovery exposes diagnostic counts without private conflict details", () => {
  const current = snapshot("partial", { summary: { roles: 2, migrated: 0, reconciled: 0,
    failures: [], skipped: false, readyRoleIds: ["ReadyRole"], packageConflicts: [
      {roleId: "ReadyRole", planId: "blocked", transactionPath: "private/manifest.json", message: "private failure"}
    ] } });
  const publicValue = publicPlanStorageStartupSnapshot(current);
  assert.equal((publicValue.summary as Record<string, unknown>).packageConflictCount, 1);
  assert.equal(JSON.stringify(publicValue).includes("private"), false);
});
