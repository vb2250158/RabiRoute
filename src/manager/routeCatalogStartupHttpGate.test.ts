import assert from "node:assert/strict";
import test from "node:test";
import {
  isRouteCatalogSnapshotInstalled,
  routeCatalogHttpDependency,
  routeCatalogStartupUnavailable
} from "./routeCatalogStartupHttpGate.js";
import type {
  RouteCatalogStartupLifecycleSnapshot,
  RouteCatalogStartupLifecycleState
} from "./routeCatalogStartupLifecycle.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function snapshot(
  state: RouteCatalogStartupLifecycleState,
  patch: Partial<RouteCatalogStartupLifecycleSnapshot> = {}
): RouteCatalogStartupLifecycleSnapshot {
  return Object.freeze({
    state,
    attempt: state === "idle" ? 0 : 1,
    incidents: state === "degraded" ? 1 : 0,
    lastTransitionAt: "2026-09-01T00:00:00.000Z",
    ...patch
  });
}

function installedSnapshot(
  state: RouteCatalogStartupLifecycleState = "ready",
  patch: Partial<RouteCatalogStartupLifecycleSnapshot> = {}
): RouteCatalogStartupLifecycleSnapshot {
  return snapshot(state, {
    contentHash: HASH_A,
    routeConfigHash: HASH_B,
    presentationHash: HASH_C,
    revision: 1,
    ...patch
  });
}

const SNAPSHOT_REQUESTS = Object.freeze([
  ["GET", "/gateways"],
  ["POST", "/gateways/route-a/start"],
  ["GET", "/api/personas"],
  ["GET", "/api/personas/YeYu"],
  ["POST", "/api/personas/YeYu/messages"],
  ["GET", "/api/rabi/instances"],
  ["GET", "/api/rabi/instances/local/routes"],
  ["GET", "/api/rabi/instances/local/routes/route-a/agent-options"]
] as const);

const MUTATION_REQUESTS = Object.freeze([
  ["POST", "/gateways"],
  ["POST", "/gateways/route-a/delete"],
  ["POST", "/reload"],
  ["POST", "/manager-config"],
  ["POST", "/open-config-file"],
  ["PATCH", "/api/rabi/instances/local/routes/route-a/message-processing"],
  ["POST", "/api/rabi/instances/local/routes/route-a/agent-binding"]
] as const);

test("route and persona HTTP entry points fail closed until an initial snapshot is installed", () => {
  const unavailableStates: ReadonlyArray<RouteCatalogStartupLifecycleSnapshot | undefined> = [
    undefined,
    snapshot("idle"),
    snapshot("running"),
    snapshot("degraded", { nextRetryAt: new Date(Date.now() + 5_000).toISOString() })
  ];

  for (const [method, pathname] of [...SNAPSHOT_REQUESTS, ...MUTATION_REQUESTS]) {
    assert.notEqual(routeCatalogHttpDependency(method, pathname), null, `${method} ${pathname}`);
    for (const state of unavailableStates) {
      const rejection = routeCatalogStartupUnavailable(method, pathname, state);
      assert.ok(rejection, `${method} ${pathname} must fail closed before initial capture`);
      assert.equal(rejection.statusCode, 503);
      assert.ok(rejection.retryAfterSeconds >= 1);
      assert.equal(rejection.body.error, "ROUTE_CATALOG_SNAPSHOT_UNAVAILABLE");
    }
  }
});

test("a ready installed snapshot releases reads, actions, and catalog mutations", () => {
  const ready = installedSnapshot();
  assert.equal(isRouteCatalogSnapshotInstalled(ready), true);

  for (const [method, pathname] of [...SNAPSHOT_REQUESTS, ...MUTATION_REQUESTS]) {
    assert.equal(routeCatalogStartupUnavailable(method, pathname, ready), null, `${method} ${pathname}`);
  }
});

test("a later catalog mutation keeps installed snapshot reads available but rejects another mutation", () => {
  const running = installedSnapshot("running", { attempt: 2 });

  for (const [method, pathname] of SNAPSHOT_REQUESTS) {
    assert.equal(routeCatalogHttpDependency(method, pathname), "snapshot", `${method} ${pathname}`);
    assert.equal(routeCatalogStartupUnavailable(method, pathname, running), null, `${method} ${pathname}`);
  }
  for (const [method, pathname] of MUTATION_REQUESTS) {
    assert.equal(routeCatalogHttpDependency(method, pathname), "mutation", `${method} ${pathname}`);
    const rejection = routeCatalogStartupUnavailable(method, pathname, running);
    assert.ok(rejection, `${method} ${pathname} must not queue behind the active mutation`);
    assert.equal(rejection.body.error, "ROUTE_CATALOG_MUTATION_UNAVAILABLE");
  }
});

test("receipt, health, identity, and unrelated role APIs stay outside the catalog gate", () => {
  const running = snapshot("running");
  const requests = [
    ["GET", "/health"],
    ["GET", "/meta"],
    ["GET", "/api/rabi/identity"],
    ["GET", "/api/personas/messages/receipts/receipt-1"],
    ["GET", "/api/roles/YeYu/plans"],
    ["POST", "/api/roles/YeYu/memory/recent"],
    ["GET", "/network-options"],
    ["GET", "/manager-config"]
  ] as const;

  for (const [method, pathname] of requests) {
    assert.equal(routeCatalogHttpDependency(method, pathname), null, `${method} ${pathname}`);
    assert.equal(routeCatalogStartupUnavailable(method, pathname, running), null, `${method} ${pathname}`);
  }
});

test("public rejection state proves readiness without leaking raw paths or errors", () => {
  const rejection = routeCatalogStartupUnavailable("GET", "/gateways", snapshot("degraded", {
    lastErrorCode: "ROUTE_CATALOG_STARTUP_FAILED"
  }));
  assert.ok(rejection);
  const serialized = JSON.stringify(rejection.body);

  assert.equal(serialized.includes("ExampleShare"), false);
  assert.equal(serialized.includes("routeRoot"), false);
  assert.equal(serialized.includes("rolesRoot"), false);
  assert.deepEqual(rejection.body.routeCatalogStartup, {
    state: "degraded",
    attempt: 1,
    incidents: 1,
    lastTransitionAt: "2026-09-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    deadlineAt: undefined,
    nextRetryAt: undefined,
    lastErrorCode: "ROUTE_CATALOG_STARTUP_FAILED",
    revision: undefined,
    snapshotInstalled: false
  });
});
