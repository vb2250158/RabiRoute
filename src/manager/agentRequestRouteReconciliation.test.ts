import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AgentRequestRouteReconciliation } from "./agentRequestRouteReconciliation.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import { ManagerRuntimeOwner } from "./managerRuntimeOwner.js";
import { RouteCatalogStartupLifecycle } from "./routeCatalogStartupLifecycle.js";
import { routeCatalogSnapshotIdentities } from "./routeCatalogIdentity.js";

const immediate = () => new Promise<void>(resolve => setImmediate(resolve));

test("route bookkeeping coalesces readiness and joins an already entered reconciliation", async () => {
  let ready!: () => void, release!: () => void, calls = 0;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const active = new Promise<void>(resolve => { release = resolve; });
  const owner = new AgentRequestRouteReconciliation({ ready: () => waiting, reconcile: async () => { calls++; await active; }, onError: () => assert.fail() });
  for (let count = 0; count < 10; count++) owner.request();
  await immediate(); assert.equal(calls, 0);
  ready(); await immediate(); assert.equal(calls, 1);
  let stopped = false;
  const stopping = owner.stop().then(() => { stopped = true; });
  await immediate(); assert.equal(stopped, false);
  release(); await stopping;
  owner.request(); await immediate(); assert.equal(calls, 1);
});

test("stopping a readiness-only waiter does not require the shared loader to finish", async () => {
  let calls = 0;
  const owner = new AgentRequestRouteReconciliation({ ready: () => new Promise<void>(() => {}), reconcile: async () => { calls++; }, onError: () => assert.fail() });
  owner.request(); await immediate(); await owner.stop(); assert.equal(calls, 0);
});

test("an unavailable loader reports once without a self-rescheduling failure storm", async () => {
  let failures = 0, calls = 0;
  const owner = new AgentRequestRouteReconciliation({ ready: async () => { throw new Error("Invalid ledger."); },
    reconcile: async () => { calls++; }, onError: () => { failures++; } });
  owner.request(); await immediate(); await immediate();
  assert.equal(failures, 1); assert.equal(calls, 0); await owner.stop();
});

test("a newer explicit route request survives an earlier failed reconciliation without automatic retry", async () => {
  let reject!: (error: unknown) => void, calls = 0, failures = 0;
  const first = new Promise<void>((_resolve, fail) => { reject = fail; });
  const owner = new AgentRequestRouteReconciliation({ ready: async () => {}, reconcile: async () => { if (++calls === 1) await first; },
    onError: async () => { failures++; throw new Error("Diagnostic observer failed."); } });
  owner.request(); await immediate(); assert.equal(calls, 1);
  owner.request(); reject(new Error("Transient mutation failure.")); await immediate(); await immediate();
  assert.equal(calls, 2); assert.equal(failures, 1);
  await immediate(); assert.equal(calls, 2); await owner.stop();
});

test("Manager ingress fencing rejects purely queued mutations before waiting for their plugin callers", async () => {
  let writes = 0;
  const store = new AgentRequestStore({ read: () => undefined, write: () => { writes++; } });
  const mutations = Array.from({ length: 40 }, (_, count) => store.prepare({ responsePolicy: "required", responseInstruction: "Return evidence.",
    source: { threadId: `source-${count}`, agentType: "agent" }, target: { threadId: `target-${count}`, agentType: "agent" } }));
  const completed = Promise.allSettled(mutations);
  const owner = new ManagerRuntimeOwner({ fenceIngress: () => { void store.close().catch(() => {}); }, publish() {}, unpublish() {}, resourceStopTimeoutMs: 1000 });
  owner.register("store", () => store.close());
  owner.register("plugin", async () => { await completed; });
  await owner.teardown("fixture");
  for (const result of await completed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason.commitState, "not_started");
  }
  assert.equal(writes, 0);
});

test("actual route startup and reverse-order Manager teardown do not wait for a never-ready ledger child", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-ledger-owner-"));
  const worker = path.join(root, "never-ready.mjs");
  const started = path.join(root, "started");
  await fs.writeFile(worker, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)},'started'); process.on('message',()=>{}); await new Promise(()=>{});\n`);
  const store = new AgentRequestStore(path.join(root, "ledger.json"), undefined, { workerURL: pathToFileURL(worker), timeoutMs: 60_000 });
  let reconciled = 0;
  const background = new AgentRequestRouteReconciliation({ ready: () => store.ready(),
    reconcile: async () => { reconciled++; await store.reconcileOpenParties(() => undefined); }, onError() {} });
  const route = new RouteCatalogStartupLifecycle({ apply: () => background.request(), attemptFactory(_operation, identity) {
    const content = { routeRoot: root, rolesRoot: root, gateways: [], personas: [] };
    return { result: Promise.resolve({ requestId: identity.requestId, attemptToken: identity.attemptToken,
      ...routeCatalogSnapshotIdentities(content), ...content }), async cancel() {} };
  } });
  t.after(async () => { await store.close().catch(() => {}); await background.stop(); await route.stop(); await fs.rm(root, { recursive: true, force: true }); });
  route.start();
  const deadline = performance.now() + 2000;
  while (route.snapshot().state !== "ready") { if (performance.now() >= deadline) assert.fail("Route publication waited for ledger readiness."); await immediate(); }
  const childDeadline = performance.now() + 5000;
  while (!await fs.access(started).then(() => true, () => false)) { if (performance.now() >= childDeadline) assert.fail("Fixture child did not start."); await immediate(); }
  const owner = new ManagerRuntimeOwner({ fenceIngress() { void store.close().catch(() => {}); background.stopAccepting(); },
    publish() {}, unpublish() {}, resourceStopTimeoutMs: 1000, teardownTimeoutMs: 3000 });
  owner.register("store", () => store.close()); owner.register("bookkeeping", () => background.stop()); owner.register("route", () => route.stop());
  await owner.teardown("fixture"); assert.equal(reconciled, 0);
  await assert.rejects(fs.access(path.join(root, "ledger.json")));
});
