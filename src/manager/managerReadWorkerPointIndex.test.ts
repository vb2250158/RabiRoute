import assert from "node:assert/strict";
import test from "node:test";
import { ManagerReadWorkerError, ManagerReadWorkerPool, managerReadWorkerPool, managerKnowledgePageWorkerPool, startBuiltinManagerReadWorkerPools, stopBuiltinManagerReadWorkerPools } from "./managerReadWorkerPool.js";

for (const mode of ["valid", "changed", "rejected", "error"] as const) {
  test(`two-phase point transport keeps disk IO in default lane and original options: ${mode}`, async t => {
    const options = { timeoutMs: 37, signal: new AbortController().signal };
    const seen: Array<{ owner: ManagerReadWorkerPool; task: Parameters<ManagerReadWorkerPool["run"]>[0]; options: unknown }> = [];
    const run = ManagerReadWorkerPool.prototype.run;
    const targetError = new Error("original target recovery failed");
    t.mock.method(ManagerReadWorkerPool.prototype, "run", function (this: ManagerReadWorkerPool, ...args: Parameters<typeof run>) {
      seen.push({ owner: this, task: args[0], options: args[1] });
      const task = args[0];
      if (task.type === "role_plan_point_hint") return Promise.resolve(task.token === undefined
        ? { token: "one-catalog", paths: [] } : mode !== "changed");
      if (task.type === "role_storage_plan_projection") {
        if (mode === "error") return Promise.reject(targetError);
        return Promise.resolve(task.candidateFiles === undefined ? null : { value: null, hintAccepted: mode !== "rejected" });
      }
      return Promise.resolve({ items: [] });
    } as typeof run);
    startBuiltinManagerReadWorkerPools();
    try {
      await managerKnowledgePageWorkerPool.queryRolePlanPage("synthetic-role", {
        cursor: "", limit: 1, query: "", sort: "updated", statuses: [], tags: [], includeFacets: false, summary: true
      });
      if (mode === "error") await assert.rejects(managerReadWorkerPool.queryRoleStoragePlanProjection("synthetic-role", "one", options), error => error === targetError);
      else assert.equal(await managerReadWorkerPool.queryRoleStoragePlanProjection("synthetic-role", "one", options), null);
      const points = seen.filter(item => item.task.type === "role_storage_plan_projection");
      assert.equal(points.length, mode === "changed" ? 2 : 1);
      for (const point of points) { assert.equal(point.owner, managerReadWorkerPool); assert.equal(point.options, options); }
      const hints = seen.filter(item => item.task.type === "role_plan_point_hint");
      assert.equal(hints.length, mode === "valid" || mode === "changed" ? 2 : 1);
      for (const hint of hints) { assert.notEqual(hint.owner, managerReadWorkerPool); assert.equal(hint.options, options); }
      for (const item of [...points, ...hints]) {
        assert.equal("options" in item.task, false); assert.equal("signal" in item.task, false);
      }
      assert.deepEqual((points[0]!.task as { candidateFiles: string[] }).candidateFiles, []);
    } finally { await stopBuiltinManagerReadWorkerPools(); }
  });
}

for (const phase of ["hint", "validate"] as const) {
  for (const code of ["worker_failed", "busy", "timeout"] as const) {
    test(`optional memory ${phase} ${code} retains healthy default point access`, async t => {
      const options = { timeoutMs: 37, signal: new AbortController().signal };
      const healthy = { plan: { id: "healthy" }, revision: "original" };
      const run = ManagerReadWorkerPool.prototype.run;
      let points = 0, memory = 0;
      t.mock.method(ManagerReadWorkerPool.prototype, "run", function (this: ManagerReadWorkerPool, ...args: Parameters<typeof run>) {
        const task = args[0];
        if (task.type === "role_plan_point_hint") {
          memory++; assert.equal(args[1], options);
          if ((phase === "hint") === (task.token === undefined)) return Promise.reject(new ManagerReadWorkerError("synthetic optional worker failure", code));
          return Promise.resolve({ token: "original-catalog", paths: [] });
        }
        if (task.type === "role_storage_plan_projection") {
          points++; assert.equal(this, managerReadWorkerPool); assert.equal(args[1], options);
          return Promise.resolve(task.candidateFiles === undefined ? healthy : { value: null, hintAccepted: true });
        }
        return Promise.resolve({ items: [] });
      } as typeof run);
      startBuiltinManagerReadWorkerPools();
      try {
        await managerKnowledgePageWorkerPool.queryRolePlanPage("synthetic-role", {
          cursor: "", limit: 1, query: "", sort: "updated", statuses: [], tags: [], includeFacets: false, summary: true
        });
        assert.equal(await managerReadWorkerPool.queryRoleStoragePlanProjection("synthetic-role", "healthy", options), healthy);
        assert.equal(points, phase === "hint" ? 1 : 2, "only one original fresh read follows unavailable metadata");
        assert.equal(memory, phase === "hint" ? 1 : 2, "metadata failure is not retried");
      } finally { await stopBuiltinManagerReadWorkerPools(); }
    });
  }
  test(`optional memory ${phase} failure preserves explicit abort without starting a fresh point`, async t => {
    const controller = new AbortController(), options = { timeoutMs: 37, signal: controller.signal };
    const run = ManagerReadWorkerPool.prototype.run; let points = 0;
    t.mock.method(ManagerReadWorkerPool.prototype, "run", function (...args: Parameters<typeof run>) {
      const task = args[0];
      if (task.type === "role_plan_point_hint") {
        if ((phase === "hint") === (task.token === undefined)) { controller.abort(); return Promise.reject(new ManagerReadWorkerError("synthetic optional failure", "worker_failed")); }
        return Promise.resolve({ token: "original-catalog", paths: [] });
      }
      if (task.type === "role_storage_plan_projection") { points++; return Promise.resolve({ value: null, hintAccepted: true }); }
      return Promise.resolve({ items: [] });
    } as typeof run);
    startBuiltinManagerReadWorkerPools();
    try {
      await managerKnowledgePageWorkerPool.queryRolePlanPage("synthetic-role", {
        cursor: "", limit: 1, query: "", sort: "updated", statuses: [], tags: [], includeFacets: false, summary: true
      });
      await assert.rejects(managerReadWorkerPool.queryRoleStoragePlanProjection("synthetic-role", "healthy", options),
        error => error instanceof ManagerReadWorkerError && error.code === "aborted");
      assert.equal(points, phase === "hint" ? 0 : 1);
    } finally { await stopBuiltinManagerReadWorkerPools(); }
  });
}
