import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DeliveryStore, canonicalJson } from "../lib/delivery-store.mjs";
import { DeliveryOwner } from "../lib/delivery-owner.mjs";
import { __test } from "../rabi-agent.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-delivery-"));
  return { root, file: path.join(root, "queue.sqlite"), configPath: path.join(root, "config.json") };
}
const intent = (intentId = "fixture-intent") => ({ intentId, agentType: "codex", sessionId: "source-session", request: {
  action: "send", deliveryId: intentId, sourceThreadId: "source-session", threadId: "target-session", agentAdapter: "codex", prompt: "Fixture transport message" } });
const response = (statusCode, data) => ({ ok: statusCode >= 200 && statusCode < 300, statusCode, body: JSON.stringify(data) });

test("bounded pause times out without releasing an unresolved original operation", async t => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { owner, store, seed } = controlledOwner(t, async method => {
    assert.equal(method, "POST"); entered(); await waiting;
    return response(503, { error: "fixture receipt remains unavailable" });
  });
  seed("fixture-intent", "pending");
  const running = owner.tick(); await started;
  const active = owner.active.get("fixture-intent"), original = store.raw("fixture-intent");
  try {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    const paused = assert.rejects(owner.pause({ deadline: 1020 }), { code: "DELIVERY_OWNER_DRAIN_TIMEOUT" });
    t.mock.timers.tick(20); await paused;
    assert.equal(owner.paused, true);
    assert.equal(owner.active.get("fixture-intent"), active, "timeout must retain the exact active promise and its ownership");
    assert.deepEqual(store.raw("fixture-intent"), original, "timeout must not settle or cancel the durable intent");
    t.mock.timers.reset();
    let joined = false;
    const withoutBudget = owner.pause().then(() => { joined = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(joined, false, "ordinary pause still joins the real operation");
    release(); await running; await withoutBudget;
    assert.equal(owner.active.size, 0);
    assert.equal(store.get("fixture-intent").state, "unknown");
  } finally { t.mock.timers.reset(); release(); await running; }
});

test("durable unknown and pending records without active work do not block bounded pause", async t => {
  const { owner, store, seed } = controlledOwner(t, async () => assert.fail("pausing must not dispatch stored records"));
  seed("unknown-intent", "unknown"); seed("pending-intent", "pending");
  const records = [store.raw("unknown-intent"), store.raw("pending-intent")];
  await owner.pause({ deadline: Date.now() + 1000 });
  assert.equal(owner.active.size, 0);
  assert.deepEqual([store.raw("unknown-intent"), store.raw("pending-intent")], records);
});

function controlledOwner(t, request) {
  const { configPath, root, file } = fixture(t);
  const store = new DeliveryStore(file);
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store,
    client: (agentType, sessionId, guid) => {
      assert.equal(agentType, "codex"); assert.equal(sessionId, "source-session"); assert.equal(guid, "fixture-guid");
      return { request };
    }, sendEvent: () => false });
  owner.wake = () => {};
  t.after(async () => { await owner.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = (id = "fixture-intent", state = "unknown") => {
    store.submit(id, "agent-delivery", { ...intent(id), nodeId: "node" }, { managerGuid: "fixture-guid" });
    if (state !== "pending") store.update(id, state);
  };
  return { owner, store, seed, file };
}

test("node cancel persists a terminal tombstone, preserves received evidence, and rejects late task ACK", async t => {
  const { owner, store, seed, file } = controlledOwner(t, async () => { assert.fail("cancelled intent must not use transport"); });
  seed("cancelled", "pending");
  const cancelled = await owner.control({ action: "cancel", intentId: "cancelled" });
  assert.equal(cancelled.record.state, "cancelled"); assert.match(cancelled.record.reason, /Manager/);
  store.update("cancelled", "delivered", { receipt: { accepted: true } });
  store.update("cancelled", "unknown"); await owner.tick();
  assert.equal(store.get("cancelled").state, "cancelled");
  assert.equal(store.submit("cancelled", "agent-delivery", { ...intent("cancelled"), nodeId: "node" }).state, "cancelled");
  const reopened = new DeliveryStore(file);
  assert.equal(reopened.get("cancelled").state, "cancelled"); assert.equal(reopened.due().length, 0); reopened.close();
  seed("received", "delivered");
  assert.equal((await owner.control({ action: "cancel", intentId: "received" })).record.state, "received");
  store.submit("event", "task-result", { taskId: "task" }, { managerGuid: "fixture-guid" });
  await owner.control({ action: "cancel", intentId: "event" });
  assert.equal(owner.acknowledge({ eventId: "event", taskId: "task" }, "fixture-guid"), false);
  assert.equal(store.get("event").state, "cancelled");
});

for (const phase of ["send"]) test(`cancel during ${phase} prevents late commit and any further send`, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let calls = 0, originalEntered = false;
  const { owner, store, seed } = controlledOwner(t, async (method, target, options) => {
    calls++;
    if (originalEntered) return response(503, { errorCode: "UNAVAILABLE" });
    if (phase === "legacy-reconcile" && method === "GET") return response(200, { data: { state: "dispatching", deliveryId: "original-internal" } });
    originalEntered = true;
    entered.resolve(); await release.promise;
    if (phase === "lookup") return response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true });
    assert.equal(method, "POST");
    assert.equal(options.body.action, phase === "send" ? "send" : "reconcile_delivery");
    return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: "original-internal" } });
  });
  seed("fixture-intent", phase === "send" ? "pending" : "unknown");
  const ticking = owner.tick(); await entered.promise;
  assert.equal((await owner.control({ action: "cancel", intentId: "fixture-intent" })).record.state, "cancelled");
  release.resolve(); await ticking; await owner.tick();
  assert.equal(store.get("fixture-intent").state, "cancelled");
  assert.equal(calls, phase === "legacy-reconcile" ? 3 : 2);
  assert.equal(store.get("fixture-intent").managerCancelPending, true);
});

test("manual node reconcile reads original receipt only; prepared or missing evidence never dispatches", async t => {
  let reply = response(200, { data: { state: "prepared", canSubmitSameIntent: true } }); let reads = 0;
  const { owner, store, seed } = controlledOwner(t, async (method, target) => {
    assert.equal(method, "GET"); assert.equal(target, "/api/agent/deliveries/caller/fixture-intent"); reads++; return reply;
  });
  seed("queued", "pending");
  assert.equal((await owner.control({ action: "reconcile", intentId: "queued" })).record.state, "queued"); assert.equal(reads, 0);
  seed(); const before = store.get("fixture-intent");
  await owner.control({ action: "reconcile", intentId: "fixture-intent" }); assert.deepEqual(store.get("fixture-intent"), before);
  reply = response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true });
  await owner.control({ action: "reconcile", intentId: "fixture-intent" }); assert.deepEqual(store.get("fixture-intent"), before);
  reply = { ...response(200, { data: { state: "committed", deliveryId: "original-internal", receipt: { accepted: true } } }), uncertain: true };
  await owner.control({ action: "reconcile", intentId: "fixture-intent" }); assert.deepEqual(store.get("fixture-intent"), before);
  reply.uncertain = false; reply.identityChanged = true;
  await owner.control({ action: "reconcile", intentId: "fixture-intent" }); assert.deepEqual(store.get("fixture-intent"), before);
  reply.identityChanged = false;
  const confirmed = await owner.control({ action: "reconcile", intentId: "fixture-intent" });
  assert.equal(confirmed.record.state, "received"); assert.equal(confirmed.record.deliveryId, "original-internal");
  assert.equal(reads, 5);
  await assert.rejects(owner.control({ action: "reconcile", intentId: "missing" }), { code: "DELIVERY_NOT_FOUND" });
  await assert.rejects(owner.control({ action: "send", intentId: "queued" }), /cancel\/reconcile/);
});

test("cancel fences a concurrent read-only reconcile and changed Manager never supplies evidence", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let reads = 0;
  const { owner, store, seed } = controlledOwner(t, async () => {
    if (reads++ > 0) return response(503, { errorCode: "UNAVAILABLE" });
    entered.resolve(); await release.promise;
    return response(200, { data: { state: "committed", receipt: { accepted: true } } });
  });
  seed(); const checking = owner.control({ action: "reconcile", intentId: "fixture-intent" }); await entered.promise;
  await owner.control({ action: "cancel", intentId: "fixture-intent" }); release.resolve();
  assert.equal((await checking).record.state, "cancelled");
  seed("other"); owner.readIdentity = () => ({ managerGuid: "changed-manager" });
  await assert.rejects(owner.control({ action: "reconcile", intentId: "other" }), /ORIGINAL_MANAGER_UNAVAILABLE/);
  assert.equal(store.get("other").state, "unknown");
});

for (const outcome of ["cancelled", "committed"]) test(`node cancellation settles only original Manager readback: ${outcome}`, async t => {
  let managerState = "prepared"; const calls = [];
  const { owner, store, seed } = controlledOwner(t, async (method, target, options) => {
    calls.push({ method, target });
    if (method === "GET") return response(200, { data: { deliveryId: "original-internal", state: managerState,
      ...(managerState === "committed" ? { receipt: { accepted: true } } : {}) } });
    assert.equal(target, "/api/agent/deliveries/original-internal/cancel"); assert.deepEqual(options.body, {});
    managerState = outcome;
    return response(outcome === "committed" ? 409 : 200, { code: outcome === "committed" ? -1 : 0 });
  });
  seed(); await owner.control({ action: "cancel", intentId: "fixture-intent" });
  const result = await owner.control({ action: "reconcile", intentId: "fixture-intent" });
  assert.equal(result.record.state, outcome === "committed" ? "received" : "cancelled");
  assert.equal(result.record.managerCancelPending, undefined); assert.equal(result.record.deliveryId, "original-internal");
  assert.equal(store.due().length, 0); assert.equal(calls.length, 3);
  assert.equal(result.record.receipt.accepted, outcome === "committed" ? true : undefined);
});

test("offline Manager cancellation survives restart and reconnect retries cancellation only", async t => {
  let online = false, managerState = "dispatching"; const calls = [];
  const { owner, store, seed, file } = controlledOwner(t, async (method, target) => {
    calls.push({ method, target });
    if (!online) return response(503, {});
    if (method === "POST") { assert.equal(target, "/api/agent/deliveries/original-internal/cancel"); managerState = "cancelled"; return response(200, {}); }
    return response(200, { data: { deliveryId: "original-internal", state: managerState } });
  });
  seed();
  assert.equal((await owner.control({ action: "cancel", intentId: "fixture-intent" })).record.managerCancelPending, true);
  const reopened = new DeliveryStore(file, { now: () => Date.now() + 120_000 });
  const row = reopened.due()[0]; assert.equal(row.id, "fixture-intent"); assert.equal(row.state, "cancelled"); assert.equal(row.manager_cancel_pending, 1); reopened.close();
  online = true; store.now = () => Date.now() + 120_000; await owner.tick();
  assert.equal(store.get("fixture-intent").state, "cancelled"); assert.equal(store.get("fixture-intent").managerCancelPending, undefined);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("absence during an in-flight cancelled send remains cancellation pending", async t => {
  const { owner, store, seed } = controlledOwner(t, async (method, target) => {
    assert.equal(method, "GET"); assert.match(target, /caller\/fixture-intent$/);
    return response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true });
  });
  seed("fixture-intent", "sending");
  const result = await owner.control({ action: "cancel", intentId: "fixture-intent" });
  assert.equal(result.record.state, "cancelled"); assert.equal(result.record.managerCancelPending, true);
  assert.equal(store.raw("fixture-intent").manager_cancel_pending, 1);
});

test("manual dispatching reconcile uses receipt-only control then verifies original caller receipt", async t => {
  let state = "dispatching"; const calls = [];
  const { owner, seed } = controlledOwner(t, async (method, target, options) => {
    calls.push({ method, target });
    if (method === "POST") {
      assert.equal(target, "/api/agent/deliveries/original-internal/reconcile"); assert.deepEqual(options.body, {});
      state = "committed"; return response(200, { data: { state: "received" } });
    }
    return response(200, { data: { state, deliveryId: "original-internal", ...(state === "committed" ? { receipt: { accepted: true } } : {}) } });
  });
  seed(); const result = await owner.control({ action: "reconcile", intentId: "fixture-intent" });
  assert.equal(result.record.state, "received"); assert.equal(calls.length, 3);
  assert.equal(calls[0].target, calls[2].target); assert.match(calls[2].target, /caller\/fixture-intent$/);
});

test("manual reconcile of pending cancellation synchronizes only cancellation", async t => {
  let state = "prepared"; let online = false; const posts = [];
  const { owner, seed } = controlledOwner(t, async (method, target) => {
    if (!online) return response(503, {});
    if (method === "POST") { posts.push(target); state = "cancelled"; return response(200, {}); }
    return response(200, { data: { state, deliveryId: "original-internal" } });
  });
  seed(); await owner.control({ action: "cancel", intentId: "fixture-intent" }); online = true;
  const result = await owner.control({ action: "reconcile", intentId: "fixture-intent" });
  assert.equal(result.record.state, "cancelled"); assert.equal(result.record.managerCancelPending, undefined);
  assert.deepEqual(posts, ["/api/agent/deliveries/original-internal/cancel"]);
});

test("pending cancellation cannot be stranded by an earlier blocked intent for the same target", async t => {
  const { owner, store } = controlledOwner(t, async (method, target) => {
    assert.equal(method, "GET"); assert.match(target, /caller\/cancelled$/);
    return response(200, { data: { state: "cancelled", deliveryId: "original-internal" } });
  });
  for (const id of ["earlier", "cancelled"]) store.submit(id, "agent-delivery", { ...intent(id), nodeId: "node" }, { managerGuid: "fixture-guid", targetKey: "same-target" });
  store.update("earlier", "blocked", { error: "invalid" }); store.update("cancelled", "unknown"); store.cancel("cancelled");
  assert.deepEqual(store.due(1, { ordered: true }).map(row => row.id), ["cancelled"]);
  await owner.tick(); assert.equal(store.get("cancelled").managerCancelPending, undefined); assert.equal(store.get("earlier").state, "blocked");
});

test("canonical durable JSON preserves wire semantics for optional terminal result fields", () => {
  const body = { taskId: "fixture", status: "completed", error: undefined, nested: { missing: undefined, list: [undefined, "text"] } };
  assert.deepEqual(JSON.parse(canonicalJson(body)), JSON.parse(JSON.stringify(body)));
});

test("durable receipt survives a killed writer; same ID conflicts never overwrite content", t => {
  const { file } = fixture(t);
  const module = new URL("../lib/delivery-store.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {DeliveryStore} from ${JSON.stringify(module)}; const store=new DeliveryStore(process.argv[1]);store.submit('a','agent-delivery',{text:'original'});store.update('a','sending');process.exit(17);`, file]);
  assert.equal(child.status, 17, child.stderr.toString());
  const store = new DeliveryStore(file); t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  assert.equal(store.get("a").state, "unknown");
  assert.equal(store.submit("a", "agent-delivery", { text: "original" }).state, "unknown");
  assert.throws(() => store.submit("a", "agent-delivery", { text: "changed" }), /CONFLICT/);
  assert.equal(store.raw("a").payload.text, "original");
});

test("capacity refuses new acceptance, preserves accepted records and paginates without payload", t => {
  const { file } = fixture(t), store = new DeliveryStore(file, { maxPending: 2 }); t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  store.submit("a", "agent-delivery", { text: "private" }); store.submit("b", "agent-delivery", { text: "two" });
  assert.throws(() => store.submit("c", "agent-delivery", {}), /QUEUE_FULL/);
  const first = store.list({ limit: 1 }), second = store.list({ limit: 1, cursor: first.nextCursor });
  assert.equal(first.items[0].intentId, "a"); assert.equal(second.items[0].intentId, "b");
  assert.equal(first.items[0].payload, undefined); assert.equal(first.counts.pending, 2);
});

test("unknown POST never retries after absent receipt or identity changes", async t => {
  const { file, configPath } = fixture(t); let now = 1000, mode = "unknown", posts = 0; const calls = [];
  const store = new DeliveryStore(file, { now: () => now });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, random: () => 0, client: () => ({ request: async (method, target, options) => {
    calls.push({ method, target });
    if (method === "POST") { posts++; assert.equal(options.body.deliveryId, "fixture-intent"); return { ...response(202, { status: "delivery_unconfirmed" }), uncertain: true }; }
    if (mode === "unreserved") return response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true });
    if (mode === "changed") return { ...response(404, { errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true }), identityChanged: true };
    return response(404, { errorCode: "NOT_FOUND" });
  } }) }); t.after(async () => { await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  owner.submit(intent()); await owner.flight; assert.equal(posts, 1); assert.equal(store.get("fixture-intent").state, "unknown");
  now += 10000; await owner.tick(); assert.equal(posts, 1);
  mode = "changed"; now += 10000; await owner.tick(); assert.equal(posts, 1);
  mode = "unreserved"; now += 10000; await owner.tick(); assert.equal(posts, 1);
  assert.equal(calls.length, 1);
});

test("query recovers accepted receipt without sending another task; one blocked target does not starve another", async t => {
  const { file, configPath } = fixture(t); let now = 1000, posts = 0;
  const store = new DeliveryStore(file, { now: () => now });
  store.submit("recovered", "agent-delivery", { ...intent("recovered"), request: intent("recovered").request }, { managerGuid: "fixture-guid" }); store.update("recovered", "unknown");
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, client: () => ({ request: async (method, target, options) => {
    if (method === "GET") return response(200, { code: 0, data: { deliveryId: "internal", state: "committed", receipt: { accepted: true } } });
    posts++; return options.body.deliveryId === "blocked" ? response(403, { code: -1 }) : response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: "internal-2" } });
  } }) }); t.after(async () => { await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  owner.submit(intent("blocked")); owner.submit({ ...intent("good"), request: { ...intent("good").request, threadId: "other-target" } }); await owner.flight; await owner.tick(); await owner.control({ action: "reconcile", intentId: "recovered" });
  assert.equal(store.get("recovered").state, "delivered"); assert.equal(store.get("blocked").state, "blocked"); assert.equal(store.get("good").state, "delivered"); assert.equal(posts, 2);
});

test("runtime completion while disconnected persists until matching receiver ACK and survives restart", async t => {
  const { root, configPath } = fixture(t), config = { nodeId: "fixture-node", managerGuid: "fixture-guid", managerUrl: "http://manager.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath);
  let recovered;
  try {
  runtime.stateStore.state.tasks.task = { status: "progress", managerGuid: config.managerGuid };
  runtime.publishDesktop = () => {}; runtime.taskByThread.set("thread", "task");
  runtime.handleAgentPluginEvent("agent.task-state", { provider: "codex", sessionId: "thread", status: "completed" });
  const owner = runtime.deliveryOwner; await owner.flight;
  const record = owner.query().items[0]; assert.equal(owner.store.raw(record.intentId).kind, "task-result"); assert.notEqual(record.state, "received"); assert.equal(runtime.taskByThread.size, 0);
  await owner.close(); runtime.deliveryOwner = null;
  recovered = new DeliveryOwner({ configPath, config, client: () => {}, sendEvent: () => false });
  assert.notEqual(recovered.query().items[0].state, "received");
  assert.equal(recovered.acknowledge({ eventId: record.intentId, taskId: "wrong" }), false);
  assert.equal(recovered.acknowledge({ eventId: record.intentId, taskId: "task" }), true);
  assert.equal(recovered.query().items[0].state, "received");
  } finally {
    try { await recovered?.close(); await runtime.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("public queue filtering runs before pagination and policy capacity is read from config", async t => {
  const { configPath, root } = fixture(t);
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxPending: 2 } }, client: () => ({ request: async () => { throw new Error("offline fixture"); } }), sendEvent: () => false });
  owner.paused = true;
  owner.store.submit("first", "agent-delivery", { ...intent("first"), request: intent("first").request });
  owner.store.submit("second", "agent-delivery", { ...intent("second"), request: { ...intent("second").request, threadId: "selected-target" } });
  owner.store.update("first", "blocked", { error: "invalid" });
  const page = owner.query({ state: "queued", query: "selected-target", limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].id, "second"); assert.equal(page.items[0].target.sessionId, "selected-target");
  assert.equal(page.nextCursor, null); assert.equal(page.items[0].ownerScope, "node"); assert.equal(page.items[0].payload, undefined);
  assert.throws(() => owner.store.submit("third", "agent-delivery", {}), /QUEUE_FULL/);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("disabled identity is blocked but observes original receipt after restoration without a second POST", async t => {
  const { file, configPath } = fixture(t); let now = 1000, allowed = false, posts = 0;
  const store = new DeliveryStore(file, { now: () => now });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid" }, store, now: () => now, random: () => 0, client: () => ({ request: async method => {
    if (method === "POST") { posts++; return response(403, { code: -1 }); }
    return allowed ? response(200, { data: { state: "committed", deliveryId: "original-internal", receipt: { accepted: true } } }) : response(403, { code: -1 });
  } }) });
  owner.submit(intent()); await owner.flight; assert.equal(store.get("fixture-intent").state, "blocked");
  now += 10000; allowed = true; await owner.tick(); await owner.control({ action: "reconcile", intentId: "fixture-intent" }); assert.equal(posts, 1); assert.equal(owner.query({ action: "get", intentId: "fixture-intent" }).item.state, "received");
  await owner.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("cancelled records retain dedup evidence but release pending count and byte capacity", t => {
  const { file } = fixture(t), store = new DeliveryStore(file, { maxPending: 1, maxBytes: 300 });
  t.after(() => { store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  store.submit("cancelled", "agent-delivery", { text: "first" }); store.update("cancelled", "cancelled");
  assert.equal(store.submit("next", "agent-delivery", { text: "second" }).state, "pending");
  assert.equal(store.get("cancelled").state, "cancelled"); assert.throws(() => store.submit("cancelled", "agent-delivery", { text: "different" }), /CONFLICT/);
});

test("bounded target concurrency starts a healthy target while another is unresolved and pause joins every flight", async t => {
  const { configPath, root } = fixture(t); let releaseSlow; let healthyStarted = false, sameTargetStarted = false, paused = false;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxConcurrency: 2, maxPerTarget: 1 } }, sendEvent: () => false,
    client: () => ({ request: async (_method, _path, options) => {
      if (options.body.deliveryId === "slow") await slow;
      if (options.body.deliveryId === "healthy") healthyStarted = true;
      if (options.body.deliveryId === "same-target") sameTargetStarted = true;
      return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: options.body.deliveryId } });
    } }) });
  owner.submit(intent("slow")); owner.submit({ ...intent("healthy"), request: { ...intent("healthy").request, threadId: "other-target" } }); owner.submit(intent("same-target"));
  for (let count = 0; count < 30 && !healthyStarted; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthyStarted, true, "healthy target must start before releasing the slow target"); assert.equal(sameTargetStarted, false);
  const drain = owner.pause().then(() => { paused = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(paused, false);
  releaseSlow(); await drain; assert.equal(paused, true); assert.equal(sameTargetStarted, false);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("all intent kinds freeze the original Manager GUID and reject another Manager or its ACK", async t => {
  const { configPath, root } = fixture(t); let identity = { nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid" }, now = 1000, posts = 0, events = 0;
  const owner = new DeliveryOwner({ configPath, config: identity, readIdentity: () => identity, now: () => now, sendEvent: () => { events++; },
    client: () => ({ request: async () => { posts++; return response(200, { status: "delivered", delivery: { status: "accepted" } }); } }) });
  owner.paused = true; owner.store.submit("legacy-unbound", "agent-delivery", { ...intent("legacy-unbound"), nodeId: "node" }); owner.store.update("legacy-unbound", "unknown");
  owner.paused = false; owner.submit(intent("original-agent")); owner.paused = true;
  const eventId = owner.enqueueResult({ type: "taskResult", taskId: "task", status: "completed" });
  identity = { ...identity, managerGuid: "manager-B", managerUrl: "http://b.invalid" }; owner.paused = false; await owner.tick();
  if (owner.flight) await owner.flight;
  assert.equal(posts, 0); assert.equal(events, 0); assert.equal(owner.store.get("original-agent").error, "DELIVERY_MANAGER_CHANGED");
  assert.equal(owner.store.get(eventId).error, "DELIVERY_MANAGER_CHANGED"); assert.equal(owner.store.get("legacy-unbound").error, null);
  assert.equal(owner.acknowledge({ eventId, taskId: "task" }), false);
  now += 10000; identity = { ...identity, managerGuid: "manager-A", managerUrl: "http://a.invalid" }; await owner.tick();
  assert.equal(events, 1); assert.equal(posts, 1); assert.equal(owner.acknowledge({ eventId, taskId: "task" }), true);
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a legacy pending hint binds the first authenticated GUID before sending; padded IDs never enter the queue", async t => {
  const { configPath, root } = fixture(t); let identity = { nodeId: "node", managerUrl: "http://original.invalid", nodeCredential: "original-fixture-only" }, proved = false;
  const owner = new DeliveryOwner({ configPath, config: identity, readIdentity: () => identity, resolveManagerIdentity: async () => {
    identity = { ...identity, managerGuid: "verified-original" }; proved = true; return { guid: "verified-original" };
  }, sendEvent: () => false, client: () => ({ request: async () => {
    assert.equal(proved, true); assert.equal(owner.store.raw("fresh").manager_guid, "verified-original");
    return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: "internal" } });
  } }) });
  assert.throws(() => owner.submit(intent(" padded ")), /whitespace/);
  owner.submit(intent("fresh")); await owner.flight; assert.equal(owner.store.get("fresh").state, "delivered");
  await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

for (const ordering of ["target", "none"]) test(`SQL scheduling bounds payload materialization with 100 queued messages before a healthy target (${ordering})`, async t => {
  const { configPath, root } = fixture(t); let releaseSlow, healthy = false;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const owner = new DeliveryOwner({ configPath, config: { nodeId: "node", managerGuid: "fixture-guid", deliveryPolicy: { maxConcurrency: 2, maxPerTarget: 1, ordering } },
    client: () => ({ request: async (_method, _path, options) => {
      if (options.body.threadId === "crowded") await slow; else healthy = true;
      return response(200, { status: "delivered", delivery: { status: "accepted", deliveryId: options.body.deliveryId } });
    } }), sendEvent: () => false });
  for (let index = 0; index < 100; index++) owner.store.submit("crowded-" + index, "agent-delivery",
    { ...intent("crowded-" + index), nodeId: "node", request: { ...intent("crowded-" + index).request, threadId: "crowded" } }, { managerGuid: "fixture-guid", targetKey: "crowded" });
  owner.store.submit("healthy-late", "agent-delivery", { ...intent("healthy-late"), nodeId: "node", request: { ...intent("healthy-late").request, threadId: "healthy" } }, { managerGuid: "fixture-guid", targetKey: "healthy" });
  const due = owner.store.due.bind(owner.store); let materialized = 0;
  owner.store.due = (...args) => { const rows = due(...args); materialized += rows.length; return rows; };
  owner.wake(); for (let count = 0; count < 30 && !healthy; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(healthy, true); assert.equal(materialized, 2, "only two available scheduling slots may materialize bodies");
  const paused = owner.pause(); releaseSlow(); await paused; await owner.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("the actual runtime factory pins the row Manager when config changes after the owner check", async t => {
  const { configPath, root } = fixture(t), original = { schemaVersion: 1, nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid", nodeCredential: "fixture-only", agents: [],
    defaultWorkspace: root, allowedWorkspaces: [root], releasePublicKeySha256: "a".repeat(64) };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const runtime = new __test.RabiAgentRuntime(original, configPath); runtime.publishDesktop = () => {};
  const owner = runtime.startDeliveryOwner(); owner.paused = true;
  const check = owner.ensureManagerBinding.bind(owner);
  owner.ensureManagerBinding = async row => {
    const verified = await check(row);
    fs.writeFileSync(configPath, JSON.stringify({ ...original, managerGuid: "manager-B", managerUrl: "http://b.invalid" }));
    return verified;
  };
  owner.paused = false; owner.submit(intent("binding-race")); await owner.flight;
  assert.equal(owner.store.get("binding-race").attempts, 0, "changed config fails before the HTTP attempt");
  assert.equal(owner.store.raw("binding-race").manager_guid, "manager-A");
  assert.throws(() => owner.client("codex", "source-session", "manager-A"), /Original delivery Manager changed/);
  await owner.close(); runtime.deliveryOwner = null; runtime.stop(); fs.rmSync(root, { recursive: true, force: true });
});

test("a completion keeps its task's original Manager and a different socket cannot transmit or ACK it", async t => {
  const { configPath, root } = fixture(t), config = { nodeId: "node", managerGuid: "manager-A", managerUrl: "http://a.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath);
  try {
  runtime.publishDesktop = () => {}; runtime.connected = true; runtime.socketManagerGuid = "manager-B";
  const wire = []; runtime.sendRaw = event => { wire.push(event); return true; };
  runtime.stateStore.state.tasks.task = { status: "progress", managerGuid: "manager-A" }; runtime.taskByThread.set("thread", "task");
  fs.writeFileSync(configPath, JSON.stringify({ ...config, managerGuid: "manager-B", managerUrl: "http://b.invalid" }));
  assert.equal(runtime.send({ type: "progress", taskId: "task", summary: "original progress" }), false);
  runtime.handleAgentPluginEvent("agent.task-state", { provider: "codex", sessionId: "thread", status: "completed" });
  const owner = runtime.deliveryOwner; await owner.flight;
  const record = owner.query().items[0];
  assert.equal(owner.store.raw(record.intentId).manager_guid, "manager-A"); assert.equal(runtime.stateStore.state.tasks.task.managerGuid, "manager-A"); assert.equal(wire.length, 0);
  runtime.handleManagerMessage(JSON.stringify({ type: "resultAck", eventId: record.intentId, taskId: "task" }));
  assert.notEqual(owner.store.get(record.intentId).state, "delivered");
  fs.writeFileSync(configPath, JSON.stringify(config)); owner.store.update(record.intentId, "unknown"); await owner.tick();
  assert.equal(wire.length, 0, "current config A alone cannot authorize sending through actual socket B");
  owner.store.update(record.intentId, "unknown"); runtime.socketManagerGuid = "manager-A"; await owner.tick();
  assert.equal(wire.length, 1); assert.equal(wire[0].eventId, record.intentId);
  runtime.handleManagerMessage(JSON.stringify({ type: "resultAck", eventId: record.intentId, taskId: "task" }));
  assert.equal(owner.store.get(record.intentId).state, "delivered");
  } finally {
    try { await runtime.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("queued original task cannot execute after socket Manager changes and legacy origin stays blocked", async t => {
  const { configPath, root } = fixture(t), config = { nodeId: "node", managerGuid: "manager-B", managerUrl: "http://b.invalid", nodeCredential: "fixture-only", agents: [] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath);
  try {
  runtime.publishDesktop = () => {}; runtime.connected = true; runtime.socketManagerGuid = "manager-B";
  let entries = 0;
  runtime.agentPluginContext = async () => { entries++; throw new Error("Changed Manager must be rejected before any native Agent is entered."); };
  await runtime.runTask({ taskId: "queued-A", threadId: "thread", message: "fixture" }, "manager-A");
  const owner = runtime.deliveryOwner; await owner.flight;
  const first = owner.query().items.find(item => owner.store.raw(item.intentId).payload.taskId === "queued-A");
  assert.equal(entries, 0); assert.equal(runtime.stateStore.state.tasks["queued-A"].managerGuid, "manager-A"); assert.equal(owner.store.raw(first.intentId).manager_guid, "manager-A");
  runtime.stateStore.state.tasks.legacy = { status: "progress" };
  runtime.send({ type: "taskResult", taskId: "legacy", status: "failed", error: "fixture" }); await owner.flight;
  const legacy = owner.query().items.find(item => owner.store.raw(item.intentId).payload.taskId === "legacy");
  assert.equal(owner.store.get(legacy.intentId).error, "DELIVERY_ORIGINAL_MANAGER_UNKNOWN");
  const firstId = owner.enqueueResult({ type: "taskResult", taskId: "proven-legacy", status: "completed" }, "manager-A");
  const replayId = owner.enqueueResult({ type: "taskResult", taskId: "proven-legacy", status: "completed" }, null);
  assert.equal(replayId, firstId); assert.equal(owner.store.raw(replayId).manager_guid, "manager-A");
  } finally {
    try { await runtime.stop(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

for (const changed of ["origin", "credential"]) test(`first GUID resolution cannot rebind a pending intent after ${changed} changes`, async t => {
 const {configPath,root}=fixture(t);let now=1000,posts=0,switched=true;
 const original={nodeId:"node",managerUrl:"http://original.invalid",nodeCredential:"original-fixture"};let identity={...original};
 const owner=new DeliveryOwner({configPath,config:original,readIdentity:()=>identity,now:()=>now,random:()=>0,
  resolveManagerIdentity:async()=>{
   await new Promise(resolve=>setImmediate(resolve));
   identity=switched ? {...original,...(changed==="origin"?{managerUrl:"http://replacement.invalid"}:{nodeCredential:"replacement-fixture"}),managerGuid:"replacement-guid"} : {...original,managerGuid:"original-guid"};
   return {guid:identity.managerGuid};
  },sendEvent:()=>false,client:(_type,_session,guid)=>({request:async()=>{
   posts++;assert.equal(guid,"original-guid");return response(200,{status:"delivered",delivery:{status:"accepted"}});
  }})});
 t.after(async()=>{await owner.close();fs.rmSync(root,{recursive:true,force:true});});
 owner.submit(intent("original-intent"));await owner.flight;
 assert.equal(posts,0);assert.equal(owner.store.raw("original-intent").manager_guid,null);
 assert.equal(owner.store.get("original-intent").state,"pending");assert.equal(owner.store.get("original-intent").attempts,0);
 assert.equal(owner.store.get("original-intent").error,"DELIVERY_MANAGER_CHANGED");
 switched=false;identity={...original};now+=10000;await owner.tick();
 assert.equal(posts,1);assert.equal(owner.store.raw("original-intent").manager_guid,"original-guid");
 assert.equal(owner.store.get("original-intent").state,"delivered");
});
