import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlanStorageMutationRequest,
  planStorageStartupUnavailable,
  publicPlanStorageStartupSnapshot
} from "./planStorageStartupHttpGate.js";
import type {
  PlanStorageStartupLifecycleSnapshot,
  PlanStorageStartupLifecycleState
} from "./planStorageStartupLifecycle.js";

const PLAN_STORAGE_MUTATIONS = Object.freeze([
  ["POST", "/roles/YeYu/plans"],
  ["PATCH", "/roles/YeYu/plans/plan-1"],
  ["POST", "/roles/YeYu/plans/plan-1/feedback"],
  ["POST", "/api/roles/YeYu/plans"],
  ["PATCH", "/api/roles/YeYu/plans/plan-1"],
  ["POST", "/api/roles/YeYu/plans/plan-1/feedback"],
  ["POST", "/api/roles/YeYu/plan-agents/plan-1/open"],
  ["POST", "/api/persona-sync/sync"],
  ["POST", "/api/persona-sync/conflicts/resolve"],
  ["POST", "/api/persona-sync/plan-packages/active"],
  ["POST", "/api/persona-sync/plan-packages/archive"]
] as const);

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

test("every plan storage mutation is unavailable while startup is pending or failed", () => {
  const unavailableStates: ReadonlyArray<readonly [string, PlanStorageStartupLifecycleSnapshot | undefined]> = [
    ["uninitialized", undefined],
    ["idle", snapshot("idle")],
    ["running", snapshot("running", { deadlineAt: "2026-09-01T00:15:00.000Z" })],
    ["degraded", snapshot("degraded", {
      completedAt: "2026-09-01T00:00:01.000Z",
      nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
      lastError: "startup failed"
    })]
  ];

  for (const [method, pathname] of PLAN_STORAGE_MUTATIONS) {
    assert.equal(isPlanStorageMutationRequest(method, pathname), true, `${method} ${pathname}`);
    for (const [label, state] of unavailableStates) {
      const unavailable = planStorageStartupUnavailable(method, pathname, state);
      assert.ok(unavailable, `${method} ${pathname} should be blocked in ${label}`);
      assert.equal(unavailable.statusCode, 503);
      assert.ok(unavailable.retryAfterSeconds >= 1);
      assert.equal(unavailable.body.error, "PLAN_STORAGE_STARTUP_UNAVAILABLE");
      assert.deepEqual(unavailable.body.planStorageStartup, state
        ? {
          state: state.state,
          attempt: state.attempt,
          incidents: state.incidents,
          lastTransitionAt: state.lastTransitionAt,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          deadlineAt: state.deadlineAt,
          nextRetryAt: state.nextRetryAt,
          lastErrorCode: state.lastError ? "PLAN_STORAGE_STARTUP_ATTEMPT_FAILED" : undefined,
          summary: undefined
        }
        : { state: "idle", attempt: 0, incidents: 0 });
    }
  }
});

test("ready startup releases every plan storage mutation", () => {
  const ready = snapshot("ready", {
    completedAt: "2026-09-01T00:00:01.000Z",
    summary: { roles: 2, migrated: 1, reconciled: 1, failures: [], skipped: false }
  });

  for (const [method, pathname] of PLAN_STORAGE_MUTATIONS) {
    assert.equal(planStorageStartupUnavailable(method, pathname, ready), null, `${method} ${pathname}`);
  }
});

test("non-plan, Xiaomi Home, and read-only requests remain available during startup", () => {
  const running = snapshot("running");
  const requests = [
    ["POST", "/api/roles/YeYu/memory/recent"],
    ["PATCH", "/api/roles/YeYu/persona"],
    ["POST", "/api/agent/xiaomi-home/action-requests"],
    ["POST", "/api/agent/xiaomi-home/events"],
    ["POST", "/api/codex-hook/context"],
    ["GET", "/api/roles/YeYu/plans"],
    ["HEAD", "/api/roles/YeYu/plans/plan-1"],
    ["OPTIONS", "/api/persona-sync/sync"]
  ] as const;

  for (const [method, pathname] of requests) {
    assert.equal(isPlanStorageMutationRequest(method, pathname), false, `${method} ${pathname}`);
    assert.equal(planStorageStartupUnavailable(method, pathname, running), null, `${method} ${pathname}`);
  }
});

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
    skipped: false
  });
  assert.equal(publicSnapshot.lastErrorCode, "PLAN_STORAGE_STARTUP_ATTEMPT_FAILED");
});
