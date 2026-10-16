import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BoundedStorageStartup, StorageTerminationError, type StorageAttempt } from "./boundedStorageStartup.js";
import { ProgressivePlanStorageStartup, type StartupProcessFactory } from "./progressivePlanStorageStartup.js";
import { ProgressiveRouteCatalogStartup } from "./progressiveRouteCatalogStartup.js";
import { createStorageStartupProcess, type StorageStartupTask } from "./storageStartupProcess.js";
import { PlanStorageStartupLifecycle } from "./planStorageStartupLifecycle.js";
import { planStorageStartupUnavailable } from "./planStorageStartupHttpGate.js";
import { RouteCatalogStartupLifecycle } from "./routeCatalogStartupLifecycle.js";
import { routeCatalogStartupUnavailable } from "./routeCatalogStartupHttpGate.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";
import type { RouteCatalogSnapshot, RouteCatalogTransactionInput } from "./routeCatalogTransaction.js";
import { executeRouteCatalogTransaction } from "./routeCatalogTransaction.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

const limits = { concurrency: 2, batchSize: 3, itemTimeoutMs: 30, batchTimeoutMs: 65 };
const success: PlanStorageStartupGateSummary = { roles: 1, migrated: 1, reconciled: 0, failures: [], skipped: false };
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function factory(handler: (task: StorageStartupTask) => Promise<unknown>, cancelled: () => void = () => {}): StartupProcessFactory {
  return <Value>(task: StorageStartupTask): StorageAttempt<Value> => ({
    result: handler(task) as Promise<Value>,
    async cancel() { cancelled(); }
  });
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "startup condition timed out");
    await delay(2);
  }
}

test("bounded batches cap concurrency, time out hanging items, and publish healthy items without waiting", async () => {
  const scope = new BoundedStorageStartup(limits);
  let active = 0;
  let peak = 0;
  const events: string[] = [];
  await scope.run(["hung", "fast", "next", "last"], item => {
    active += 1;
    peak = Math.max(peak, active);
    return {
      result: item === "hung" ? new Promise<string>(() => {}) : Promise.resolve(item),
      async cancel() { active -= 1; }
    };
  }, item => { events.push(item); }, item => { events.push(`failed:${item}`); });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.ok(events.indexOf("fast") < events.indexOf("failed:hung"));
  assert.deepEqual(new Set(events), new Set(["fast", "next", "last", "failed:hung"]));
});

test("batch deadline also bounds queued items and cancellation drains every active child", async () => {
  const scope = new BoundedStorageStartup({ ...limits, concurrency: 1, itemTimeoutMs: 60, batchTimeoutMs: 20 });
  let created = 0;
  const failures: number[] = [];
  await scope.run([1, 2, 3], () => {
    created += 1;
    return { result: new Promise<void>(() => {}), async cancel() {} };
  }, () => assert.fail("hung item published"), item => { failures.push(item); });
  assert.equal(created, 1);
  assert.deepEqual(failures, [1, 2, 3]);
  const cancellable = new BoundedStorageStartup(limits);
  let cancelled = 0;
  const work = cancellable.run([1, 2, 3], () => {
    let closed = false;
    return {
      result: new Promise<void>(() => {}), async cancel() { if (!closed) cancelled += 1; closed = true; }
    };
  }, () => assert.fail("cancelled result published"), () => assert.fail("stop reported an item failure"));
  await cancellable.cancel();
  await work;
  assert.equal(cancelled, 2);
});

test("unconfirmed child termination fails closed instead of launching another batch", async () => {
  const scope = new BoundedStorageStartup({ ...limits, concurrency: 1 });
  let created = 0;
  await assert.rejects(scope.run([1, 2], () => {
    created += 1;
    return { result: new Promise<void>(() => {}), async cancel() { throw new Error("still alive"); } };
  }, () => {}, () => {}), StorageTerminationError);
  assert.equal(created, 1);
});

test("plan startup publishes recovered roles, retries only failed roles, and retains partial results on enumeration failure", async () => {
  let recover = false;
  let enumerate = true;
  const calls: string[] = [];
  const loader = new ProgressivePlanStorageStartup({ rolesRoot: "roles", readOnly: false, limits,
    processFactory: factory(async task => {
      if (task.kind === "directories") {
        if (!enumerate) throw new Error("offline");
        return ["fast", "hung"];
      }
      assert.equal(task.kind, "plan");
      if (task.kind !== "plan") throw new Error("unexpected task");
      calls.push(task.roleId);
      if (task.roleId === "hung" && !recover) return new Promise(() => {});
      return success;
    })
  });
  const progress: PlanStorageStartupGateSummary[] = [];
  const first = await loader.attempt(summary => { progress.push(summary); }).result;
  assert.deepEqual(first.readyRoleIds, ["fast"]);
  assert.equal(first.failures.length, 1);
  assert.ok(progress.some(summary => summary.readyRoleIds?.includes("fast") && !summary.failures.length));
  enumerate = false;
  assert.deepEqual((await loader.attempt(() => {}).result).readyRoleIds, ["fast"]);
  enumerate = true;
  recover = true;
  const second = await loader.attempt(() => {}).result;
  assert.deepEqual(second.readyRoleIds, ["fast", "hung"]);
  assert.equal(second.failures.length, 0);
  assert.equal(calls.filter(roleId => roleId === "fast").length, 1);
  assert.equal(second.migrated, 2);
});

test("partial plan roles are writable during recovery but other roles and stopping states remain gated", () => {
  const snapshot = {
    state: "degraded" as const, attempt: 1, incidents: 1, lastTransitionAt: new Date().toISOString(),
    summary: { ...success, readyRoleIds: ["ready role"] }
  };
  assert.equal(planStorageStartupUnavailable("POST", "/api/roles/ready%20role/plans", snapshot), null);
  assert.equal(planStorageStartupUnavailable("POST", "/api/roles/other/plans", snapshot)?.statusCode, 503);
  assert.equal(planStorageStartupUnavailable("POST", "/api/roles/%GG/plans", snapshot)?.statusCode, 503);
  assert.equal(planStorageStartupUnavailable("POST", "/api/roles/ready%20role/plans", { ...snapshot, state: "stopping" })?.statusCode, 503);
});

test("plan lifecycle ignores late progress from a timed-out attempt and protects readiness snapshots", async () => {
  let progress!: (summary: PlanStorageStartupGateSummary) => void;
  const lifecycle = new PlanStorageStartupLifecycle({ rolesRoot: "roles", readOnly: false,
    attemptTimeoutMs: 20, retryBaseMs: 5, retryMaxMs: 5,
    attemptFactory(report) {
      progress ??= report;
      return { result: new Promise(() => {}), async cancel() {} };
    }
  });
  lifecycle.start();
  try {
    progress({ ...success, readyRoleIds: ["safe"] });
    await until(() => Boolean(lifecycle.snapshot().summary));
    lifecycle.snapshot().summary?.readyRoleIds?.push("unsafe");
    assert.deepEqual(lifecycle.snapshot().summary?.readyRoleIds, ["safe"]);
    await until(() => lifecycle.snapshot().attempt === 2);
    progress({ ...success, readyRoleIds: ["late"] });
    await delay(2);
    assert.deepEqual(lifecycle.snapshot().summary?.readyRoleIds, ["safe"]);
  } finally { await lifecycle.stop(); }
});

test("plan lifecycle retains an unconfirmed child for explicit stop and never retries over it", async () => {
  let canStop = false;
  let attempts = 0;
  const lifecycle = new PlanStorageStartupLifecycle({ rolesRoot: "roles", readOnly: false,
    retryBaseMs: 1, retryMaxMs: 1,
    attemptFactory() {
      attempts += 1;
      return { result: Promise.reject(new StorageTerminationError()), async cancel() {
        if (!canStop) throw new StorageTerminationError();
      } };
    }
  });
  lifecycle.start();
  await until(() => lifecycle.snapshot().state === "degraded");
  await delay(10);
  assert.equal(attempts, 1);
  assert.equal(lifecycle.snapshot().nextRetryAt, undefined);
  await assert.rejects(lifecycle.stop(), StorageTerminationError);
  assert.equal(lifecycle.snapshot().state, "degraded");
  canStop = true;
  await lifecycle.stop();
  assert.equal(lifecycle.snapshot().state, "stopped");
});

test("route startup installs partial snapshots serially, gates writes, and keeps retrying beyond mutation maxAttempts", async () => {
  let recover = false;
  const input: RouteCatalogTransactionInput = {
    requestId: "request", attemptToken: "attempt", operationId: "operation", rootDir: path.resolve(".cache/startup"),
    routeRoot: path.resolve(".cache/startup/route"), rolesRoot: path.resolve(".cache/startup/roles"),
    managerPort: 19000, readOnly: true, operation: { kind: "capture" }
  };
  const loader = new ProgressiveRouteCatalogStartup({ limits, processFactory: factory(async task => {
    if (task.kind === "catalog_recovery") return true;
    if (task.kind === "directories") return task.catalog === "routes" ? ["fast", "hung"] : [];
    if (task.kind === "route") {
      if (task.configName === "hung" && !recover) return new Promise(() => {});
      return { id: task.configName, configName: task.configName };
    }
    throw new Error("unexpected task");
  }) });
  let applying = 0;
  let peak = 0;
  const applied: RouteCatalogSnapshot[] = [];
  const lifecycle = new RouteCatalogStartupLifecycle({ maxAttempts: 1, retryBaseMs: 5, retryMaxMs: 5,
    attemptFactory(operation, identity, onProgress) {
      return loader.attempt({ ...input, ...identity, operation }, onProgress ?? (() => {}));
    },
    async apply(snapshot) {
      applying += 1;
      peak = Math.max(peak, applying);
      await delay(1);
      applied.push(snapshot);
      applying -= 1;
    }
  });
  lifecycle.start();
  try {
    await until(() => lifecycle.catalog()?.gateways.some(item => item.id === "fast") === true);
    assert.equal(lifecycle.catalog()?.gateways[0].id, "fast");
    assert.equal(routeCatalogStartupUnavailable("GET", "/gateways", lifecycle.snapshot()), null);
    assert.equal(routeCatalogStartupUnavailable("POST", "/gateways", lifecycle.snapshot())?.statusCode, 503);
    await until(() => lifecycle.snapshot().attempt >= 3);
    recover = true;
    await until(() => lifecycle.snapshot().state === "ready");
    assert.deepEqual(lifecycle.catalog()?.gateways.map(item => item.id), ["fast", "hung"]);
    assert.equal(peak, 1);
    assert.equal(applied.at(-1)?.startupIncomplete, false);
  } finally { await lifecycle.stop(); }
});

test("real storage children enumerate local data and finish plan recovery without touching external storage", async () => {
  fs.mkdirSync(path.resolve(".cache"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".cache/startup-"));
  try {
    fs.mkdirSync(path.join(root, "example"), { recursive: true });
    fs.writeFileSync(path.join(root, "not-a-role.txt"), "example");
    assert.deepEqual(await createStorageStartupProcess<string[]>({ kind: "directories", root }).result, ["example"]);
    const loader = new ProgressivePlanStorageStartup({ rolesRoot: root, readOnly: false,
      limits: { itemTimeoutMs: 10_000, batchTimeoutMs: 15_000 } });
    assert.deepEqual((await loader.attempt(() => {}).result).readyRoleIds, ["example"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recapture preserves the latest committed route snapshot when its storage becomes unavailable", async () => {
  const content = {
    routeRoot: path.resolve(".cache/recapture/route"), rolesRoot: path.resolve(".cache/recapture/roles"),
    gateways: [{ id: "updated", configName: "updated", gatewayPort: 19001, agentModel: "latest-model" }], personas: []
  };
  const baseline: RouteCatalogSnapshot = { requestId: "committed", attemptToken: "committed", ...content,
    ...routeCatalogSnapshotIdentities(content) };
  const loader = new ProgressiveRouteCatalogStartup({ limits, processFactory: factory(async task => {
    if (task.kind === "catalog_recovery") return true;
    if (task.kind === "directories") return task.catalog === "routes" ? ["updated"] : [];
    return new Promise(() => {});
  }) });
  const progress: RouteCatalogSnapshot[] = [];
  const snapshot = await loader.attempt({
    rootDir: path.resolve(".cache/recapture"), routeRoot: content.routeRoot, rolesRoot: content.rolesRoot,
    managerPort: 19000, readOnly: true, operation: { kind: "capture" }, requestId: "read", attemptToken: "read", operationId: "read"
  }, value => { progress.push(value); }, baseline).result;
  assert.equal(snapshot.startupIncomplete, true);
  assert.deepEqual(snapshot.gateways, content.gateways);
  assert.ok(progress.length > 0);
  assert.ok(progress.every(value => value.gateways[0]?.agentModel === "latest-model"));
});

test("real progressive route capture matches the transactional catalog including referenced and remote personas", async () => {
  fs.mkdirSync(path.resolve(".cache"), { recursive: true });
  const root = fs.mkdtempSync(path.resolve(".cache/route-startup-"));
  const input: RouteCatalogTransactionInput = {
    requestId: "seed", attemptToken: "seed", operationId: "seed", rootDir: root,
    routeRoot: path.join(root, "route"), rolesRoot: path.join(root, "roles"),
    managerPort: 19000, readOnly: false, operation: { kind: "replace", config: { gateways: [
      { id: "local", agentRoleId: "Example", gatewayPort: 19001 },
      { id: "remote", agentRoleId: "Remote", agentRoleDeviceId: "pc-example", gatewayPort: 19002 },
      { id: "document", agentRoleId: "DocumentOnly", agentRoleFile: "instructions.md", gatewayPort: 19003 }
    ] } }
  };
  try {
    fs.mkdirSync(path.join(input.rolesRoot, "Example"), { recursive: true });
    fs.writeFileSync(path.join(input.rolesRoot, "Example", "persona.md"), "# Example\nPublic example.");
    fs.mkdirSync(path.join(input.rolesRoot, "DocumentOnly"));
    fs.writeFileSync(path.join(input.rolesRoot, "DocumentOnly", "instructions.md"), "# Example instructions");
    const expected = executeRouteCatalogTransaction(input);
    const capture = { ...input, operation: { kind: "capture" as const } };
    const loader = new ProgressiveRouteCatalogStartup({ limits: { itemTimeoutMs: 10_000, batchTimeoutMs: 20_000 } });
    const snapshot = await loader.attempt(capture, () => {}).result;
    assert.equal(snapshot.startupIncomplete, false);
    assert.equal(snapshot.contentHash, expected.contentHash);
    assert.deepEqual(snapshot.gateways, JSON.parse(JSON.stringify(expected.gateways)));
    assert.deepEqual(snapshot.personas, JSON.parse(JSON.stringify(expected.personas)));
    const cancelled = createStorageStartupProcess({ kind: "directories", root });
    const settled = cancelled.result.catch(() => undefined);
    await cancelled.cancel();
    await settled;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
