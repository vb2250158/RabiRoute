import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { __test } from "../rabi-agent.mjs";
import { EndpointTransportReceipts } from "../runtime/management.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rabi-management-recovery-")));
  const configPath = path.join(directory, "config.json");
  const identity = { guid: "fixture-manager-guid", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager-instance" };
  const config = { schemaVersion: 1, managerUrl: "http://fixture.invalid:54321", managerGuid: identity.guid,
    applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId,
    releasePublicKeySha256: "a".repeat(64), nodeId: "fixture-node", nodeCredential: "fixture-only-credential",
    defaultWorkspace: directory, allowedWorkspaces: [directory], agents: [], autoUpdate: false };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtime = new __test.RabiAgentRuntime(config, configPath), replies = [];
  runtime.connected = true; runtime.socket = { close() {} }; runtime.socketManagerGuid = identity.guid;
  runtime.send = message => { replies.push(message); return true; };
  runtime.sendRaw = runtime.send;
  const target = { kind: "instance", managerInstanceId: "fixture-ledger", instanceId: config.nodeId, nodeId: config.nodeId,
    agentId: "fixture-backend", provider: "codex", sessionId: "fixture-task", authorizationIncarnation: "fixture-incarnation" };
  const source = { kind: "local", managerInstanceId: "fixture-ledger", agentId: "local:codex", provider: "codex",
    sessionId: "fixture-source", authorizationIncarnation: "fixture-source-incarnation" };
  const executionOptions = { cwd: directory }, prompt = "Fixture native operation; never sent to a real owner.";
  const delivery = { deliveryId: "original-delivery", generation: "original-delivery-generation", dispatchAttemptId: randomUUID(),
    source, target, prompt, promptHash: hash(prompt), executionOptions, executionOptionsHash: hash(JSON.stringify(executionOptions)), state: "dispatching",
    preparation: { deliveryId: "original-delivery", responsePolicy: "none", source: { threadId: source.sessionId, endpoint: source }, target: { threadId: target.sessionId, endpoint: target } } };
  let authorityReads = 0;
  t.mock.method(globalThis, "fetch", async url => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/agent/delivery-authority") {
      authorityReads++;
      return Response.json({ code: 0, data: { authorized: true, deliveryId: delivery.deliveryId, generation: delivery.generation,
        promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, endpoint: target, state: "dispatching" } });
    }
    assert.ok(["/.well-known/rabiroute-manager", "/meta", "/api/lan-agent/self"].includes(pathname), "unexpected network request: " + pathname);
    return Response.json({ code: 0, ...identity, rabiGuid: identity.guid, health: { live: true, state: "healthy", requiredReady: true },
      data: { ...identity, nodeId: config.nodeId, protocolVersion: 1, health: { live: true, state: "healthy", requiredReady: true } } });
  });
  t.after(async () => { await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const receipts = new EndpointTransportReceipts(path.join(directory, "endpoint-transport-receipts"));
  const message = operation => JSON.stringify({ type: "manageAgent", requestId: randomUUID(), operation, params: { agentAdapter: "codex", delivery } });
  return { directory, configPath, runtime, delivery, replies, receipts, message, authorityReads: () => authorityReads };
}

function lateSubscriptionFixture(t, f, observationMs) {
  const listeners = new Set(), observe = f.runtime.observeLatePreparedReceipt;
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  t.mock.method(f.runtime, "observeLatePreparedReceipt", function (delivery, connection, nativeSubscribe, nativeWindow) {
    assert.equal(typeof nativeSubscribe, "function", "the official management bundle must export its original IPC subscriber");
    assert.equal(nativeWindow, 60_000, "connector observation shares the producer's existing default window");
    return observe.call(this, delivery, connection, subscribe, observationMs ?? nativeWindow);
  });
  return { listeners, emit: event => { for (const listener of [...listeners]) listener(event); },
    event: method => ({ stage: "delivery_receipt_confirmed", outcome: "confirmed", late: true,
      deliveryMarker: f.delivery.deliveryId, threadId: f.delivery.target.sessionId, method }) };
}

async function finishUnconfirmedFixtureCall(t, f) {
  // Simulate an original attempted frame with no receipt. This boundary cannot
  // enter a real Desktop/native send, while the actual runtime and SDK still execute.
  t.mock.method(EndpointTransportReceipts.prototype, "beginAttempt", async () => false);
  f.runtime.handleManagerMessage(f.message("prepared_delivery"));
  await Promise.all([...f.runtime.preparedDeliveries]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replies.filter(message => message.type === "deliveryRecovery").length, 1);
  assert.equal(await f.receipts.readReceipt(f.delivery), undefined, "the first completion hint still finds no durable receipt");
}

for (const evidence of ["missing", "accepted", "not_sent"]) test(`a busy original delivery exposes only its durable ${evidence} snapshot without waiting or writing`, async t => {
  const f = fixture(t), gate = deferred();
  const pluginContext = t.mock.method(f.runtime, "agentPluginContext", async () => { throw new Error("Snapshot must not initialize an execution plugin."); });
  const held = f.runtime.withReceiptOperation(f.delivery.deliveryId, () => gate.promise);
  await Promise.resolve();
  let filename, before;
  if (evidence !== "missing") {
    await f.receipts.beginAttempt(f.delivery);
    filename = path.join(f.directory, "endpoint-transport-receipts", hash(f.delivery.deliveryId) + ".json");
    if (evidence === "accepted") await f.receipts.writeReceipt(f.delivery, { deliveryId: f.delivery.deliveryId, generation: f.delivery.generation,
      promptHash: f.delivery.promptHash, executionOptionsHash: f.delivery.executionOptionsHash, endpoint: f.delivery.target,
      accepted: true, action: "started", transport: "fixture-original-owner" });
    else {
      const original = JSON.parse(fs.readFileSync(filename, "utf8"));
      fs.writeFileSync(filename, JSON.stringify({ ...original, state: "not_sent",
        noFrameProof: { kind: "no-prompt-frame", attemptId: original.attemptId, observedAt: new Date().toISOString() } }));
    }
    before = fs.readFileSync(filename);
  }
  try {
    f.runtime.handleManagerMessage(f.message("reconcile_prepared_delivery"));
    await Promise.all([...f.runtime.receiptRecoveries]);
    assert.equal(f.runtime.receiptOperations.size, 1, "native owner remains unfinished");
    assert.equal(pluginContext.mock.calls.length, 0, "durable receipt reads do not wait for native initialization");
    assert.equal(f.authorityReads(), 1, "unchanged snapshot only needs its original authority proof once");
    const reply = f.replies.find(item => item.type === "managementResult");
    assert.ok(reply?.result, JSON.stringify(f.replies));
    if (evidence === "missing") {
      assert.deepEqual(reply.result, { status: "in_progress", deliveryId: f.delivery.deliveryId, generation: f.delivery.generation });
      assert.equal(fs.existsSync(path.join(f.directory, "endpoint-transport-receipts")), false);
    } else {
      assert.deepEqual(fs.readFileSync(filename), before, "snapshot must not allocate another attempt or mutate evidence");
      assert.equal(evidence === "accepted" ? reply.result.accepted : reply.result.status, evidence === "accepted" ? true : "not_sent");
    }
  } finally { gate.resolve(); await held; }
});

test("draining keeps original receipt snapshots readable while refusing new execution and uncommitted candidates", async t => {
  const f = fixture(t);
  const pluginContext = t.mock.method(f.runtime, "agentPluginContext", async () => { throw new Error("Draining snapshots must not restart an execution plugin."); });
  f.runtime.draining = true;
  f.runtime.handleManagerMessage(f.message("reconcile_prepared_delivery"));
  await Promise.all([...f.runtime.receiptRecoveries]);
  assert.equal(f.replies.at(-1).result.status, "in_progress");
  f.runtime.handleManagerMessage(f.message("prepared_delivery"));
  assert.match(f.replies.at(-1).error, /not accepted/);
  f.runtime.candidatePending = true;
  f.runtime.handleManagerMessage(f.message("reconcile_prepared_delivery"));
  assert.match(f.replies.at(-1).error, /not accepted/);
  assert.equal(f.authorityReads(), 1);
  assert.equal(pluginContext.mock.calls.length, 0);
});

for (const operation of ["list", "configure"]) for (const change of ["socket", "credential"]) test(`queued ${operation} cannot start or return its response after replacing its ${change}`, async t => {
  const f = fixture(t), gate = deferred(), before = fs.readFileSync(f.configPath);
  const queued = operation === "list" ? f.runtime.queueManagementRead.bind(f.runtime) : f.runtime.queueManagementWrite.bind(f.runtime);
  const method = operation === "list" ? "queueManagementRead" : "queueManagementWrite";
  f.runtime[method] = (run, ...args) => queued(async () => { await gate.promise; return run(); }, ...args);
  f.runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "original-management", operation,
    params: { provider: "codex-desktop", agentId: "new-backend", name: "Should not be saved" } }));
  if (change === "socket") f.runtime.socket = { close() {} };
  else f.runtime.config.nodeCredential = "replacement-credential";
  gate.resolve();
  await Promise.all([...f.runtime.managementReads, ...f.runtime.managementMutations]);
  assert.equal(f.replies.some(item => item.type === "managementResult" || item.type === "agentCatalog"), false);
  assert.deepEqual(fs.readFileSync(f.configPath), before);
});

for (const change of ["same-manager", "other-manager", "other-credential", "offline"]) test(`an old prepared operation finishing after ${change} sends only an eligible recovery hint after releasing its lock`, async t => {
  const f = fixture(t), entered = deferred(), gate = deferred();
  t.mock.method(EndpointTransportReceipts.prototype, "readReceipt", async () => { entered.resolve(); await gate.promise; return undefined; });
  const send = f.runtime.send;
  f.runtime.send = message => {
    if (message.type === "deliveryRecovery") assert.equal(f.runtime.receiptOperations.size, 0, "wake must follow actual owner release");
    return send(message);
  };
  f.runtime.handleManagerMessage(f.message("prepared_delivery"));
  await entered.promise;
  f.runtime.socket = { close() {} };
  if (change === "other-manager") f.runtime.socketManagerGuid = "replacement-manager-guid";
  if (change === "other-credential") f.runtime.config.nodeCredential = "replacement-credential";
  if (change === "offline") f.runtime.connected = false;
  gate.resolve();
  await Promise.all([...f.runtime.preparedDeliveries]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replies.some(item => item.type === "managementResult"), false, "original result must not leak onto a new connection");
  const hints = f.replies.filter(item => item.type === "deliveryRecovery");
  assert.equal(hints.length, change === "same-manager" ? 1 : 0);
  if (hints.length) assert.deepEqual(hints[0], { type: "deliveryRecovery", deliveryId: f.delivery.deliveryId, generation: f.delivery.generation });
  assert.equal(fs.existsSync(path.join(f.directory, "endpoint-transport-receipts")), false, "fixture stops before any native prompt attempt");
});

test("same-socket completion still hints after a lost Manager correlation and reconciliation cannot hint-loop", async t => {
  const f = fixture(t), entered = deferred(), gate = deferred();
  t.mock.method(EndpointTransportReceipts.prototype, "readReceipt", async delivery => {
    entered.resolve(); await gate.promise;
    return { deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash,
      executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target,
      accepted: true, action: "started", transport: "fixture-original-owner" };
  });
  let ignoredResults = 0;
  const send = f.runtime.send;
  f.runtime.send = message => {
    // The Manager may have evicted/expired its original request while this socket stays live.
    if (message.type === "managementResult") { ignoredResults++; return true; }
    if (message.type === "deliveryRecovery") assert.equal(f.runtime.receiptOperations.size, 0);
    return send(message);
  };
  const originalSocket = f.runtime.socket;
  f.runtime.handleManagerMessage(f.message("prepared_delivery"));
  await entered.promise;
  assert.equal(f.replies.length, 0);
  gate.resolve(); await Promise.all([...f.runtime.preparedDeliveries]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.socket, originalSocket); assert.equal(ignoredResults, 1);
  assert.deepEqual(f.replies, [{ type: "deliveryRecovery", deliveryId: f.delivery.deliveryId, generation: f.delivery.generation }]);
  f.runtime.handleManagerMessage(f.message("reconcile_prepared_delivery"));
  await Promise.all([...f.runtime.receiptRecoveries]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ignoredResults, 2); assert.equal(f.replies.length, 1, "read-only recovery must not emit another completion hint");
  assert.equal(fs.existsSync(path.join(f.directory, "endpoint-transport-receipts")), false, "cached evidence never sends a real prompt");
});

test("draining delivery records query keeps its existing paused owner and does not admit new submissions", async t => {
  const f = fixture(t); let queries = 0;
  f.runtime.deliveryOwner = { query: () => { queries++; return { items: [] }; }, close: async () => {} };
  f.runtime.draining = true;
  assert.deepEqual(f.runtime.deliveryControl("query", {}), { ok: true, items: [] });
  assert.equal(queries, 1);
  assert.throws(() => f.runtime.deliveryControl("submit", {}), /UNAVAILABLE/);
});

for (const change of ["socket", "credential"]) test(`late delivery-records results cannot return after replacing the original ${change}`, async t => {
  const f = fixture(t), entered = deferred(), gate = deferred();
  f.runtime.deliveryOwner = { query: () => { entered.resolve(); return gate.promise; }, close: async () => {} };
  // Query results are normally synchronous; exercise the independent async control owner instead.
  f.runtime.deliveryOwner.control = async () => { entered.resolve(); await gate.promise; return { state: "cancelled" }; };
  f.runtime.handleManagerMessage(JSON.stringify({ type: "manageAgent", requestId: "original-control", operation: "delivery_records", params: { action: "cancel", intentId: "original-intent" } }));
  await entered.promise;
  if (change === "socket") f.runtime.socket = { close() {} };
  else f.runtime.config.nodeCredential = "replacement-credential";
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replies.length, 0);
});

test("delivery-records mutations are guarded before dispatch and draining admits only original read-only queries", async t => {
  const f = fixture(t); let mutations = 0, queries = 0;
  f.runtime.deliveryOwner = { query: () => { queries++; return { items: [] }; },
    control: async () => { mutations++; return { state: "cancelled" }; }, close: async () => {} };
  const message = action => JSON.stringify({ type: "manageAgent", requestId: "original-control", operation: "delivery_records", params: { action } });
  f.runtime.handleManagerMessage(message("cancel"));
  f.runtime.config.nodeCredential = "replacement-credential";
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, 0); assert.equal(f.replies.length, 0);
  f.runtime.draining = true;
  f.runtime.handleManagerMessage(message("reconcile"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, 0); assert.match(f.replies.at(-1).error, /not accepted/);
  f.runtime.handleManagerMessage(message("query"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 1); assert.deepEqual(f.replies.at(-1).result, { ok: true, items: [] });
  f.runtime.candidatePending = true;
  const before = f.replies.length;
  f.runtime.handleManagerMessage(message("query"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 1); assert.equal(f.replies.length, before);
});

for (const method of ["thread-follower-start-turn", "thread-follower-steer-turn"]) test(`a later ${method} receipt wakes the original delivery again after its first unconfirmed hint found nothing`, async t => {
  const f = fixture(t), subscription = lateSubscriptionFixture(t, f);
  await finishUnconfirmedFixtureCall(t, f);
  assert.equal(subscription.listeners.size, 1); assert.equal(f.runtime.latePreparedObservations.size, 1);
  subscription.emit(subscription.event(method));
  assert.deepEqual(f.replies.filter(message => message.type === "deliveryRecovery"), [
    { type: "deliveryRecovery", deliveryId: f.delivery.deliveryId, generation: f.delivery.generation },
    { type: "deliveryRecovery", deliveryId: f.delivery.deliveryId, generation: f.delivery.generation }
  ]);
  assert.equal(subscription.listeners.size, 0); assert.equal(f.runtime.latePreparedObservations.size, 0);
  assert.equal(await f.receipts.readReceipt(f.delivery), undefined, "an event only wakes reconciliation; it must not manufacture an execution receipt");
  subscription.emit(subscription.event(method));
  assert.equal(f.replies.filter(message => message.type === "deliveryRecovery").length, 2, "the late association retires after one confirmation");
});

for (const mismatch of ["delivery", "thread", "manager", "credential", "stop"]) test(`late native evidence cannot wake a mismatched ${mismatch} context`, async t => {
  const f = fixture(t), subscription = lateSubscriptionFixture(t, f);
  await finishUnconfirmedFixtureCall(t, f);
  const event = subscription.event("thread-follower-steer-turn");
  if (mismatch === "delivery") event.deliveryMarker = "another-delivery";
  if (mismatch === "thread") event.threadId = "another-thread";
  if (mismatch === "manager") f.runtime.socketManagerGuid = "another-manager";
  if (mismatch === "credential") f.runtime.config.nodeCredential = "replacement-credential";
  if (mismatch === "stop") await f.runtime.stop();
  subscription.emit(event);
  assert.equal(f.replies.filter(message => message.type === "deliveryRecovery").length, 1);
  if (mismatch === "stop") { assert.equal(subscription.listeners.size, 0); assert.equal(f.runtime.latePreparedObservations.size, 0); }
});

test("late associations are replaced per original receipt owner and expire from operation settlement", async t => {
  const f = fixture(t), listeners = new Set();
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const connection = { managerGuid: f.runtime.socketManagerGuid, credential: f.runtime.config.nodeCredential };
  const first = f.runtime.observeLatePreparedReceipt(f.delivery, connection, subscribe, 20);
  assert.equal(listeners.size, 1);
  const second = f.runtime.observeLatePreparedReceipt(f.delivery, connection, subscribe, 20);
  assert.equal(listeners.size, 1); first.settle();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(listeners.size, 1, "an unsettled native operation has not started its observation deadline");
  second.settle(); await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(listeners.size, 0); assert.equal(f.runtime.latePreparedObservations.size, 0);
});

for (const evidence of ["accepted", "not_sent"]) test(`durable ${evidence} evidence immediately removes its native late listener`, async t => {
  const f = fixture(t), subscription = lateSubscriptionFixture(t, f);
  if (evidence === "accepted") t.mock.method(EndpointTransportReceipts.prototype, "readReceipt", async delivery => ({
    deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash,
    executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target, accepted: true, action: "started", transport: "fixture-original-owner"
  }));
  else {
    t.mock.method(EndpointTransportReceipts.prototype, "beginAttempt", async () => false);
    t.mock.method(EndpointTransportReceipts.prototype, "readNotSentProof", async delivery => ({ kind: "no-prompt-frame",
      deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash,
      executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target, dispatchAttemptId: delivery.dispatchAttemptId,
      attemptId: randomUUID(), attemptSequence: 1, observedAt: new Date().toISOString() }));
  }
  f.runtime.handleManagerMessage(f.message("prepared_delivery"));
  await Promise.all([...f.runtime.preparedDeliveries]); await new Promise(resolve => setImmediate(resolve));
  const result = f.replies.find(message => message.type === "managementResult");
  assert.equal(evidence === "accepted" ? result?.result?.accepted : result?.result?.status, evidence === "accepted" ? true : "not_sent", JSON.stringify(f.replies));
  assert.equal(subscription.listeners.size, 0); assert.equal(f.runtime.latePreparedObservations.size, 0);
});
