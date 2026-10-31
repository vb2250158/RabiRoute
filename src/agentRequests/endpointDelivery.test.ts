import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRequestStore, type AgentRequestPersistence } from "./store.js";
import type { AgentRequestEndpoint } from "./endpoint.js";
import { executeEndpointAgentDelivery, EndpointDeliveryRecovery, EndpointVerificationError, sourceScopedAgentDeliveryId, type EndpointDeliveryOptions, type EndpointDeliveryReceipt, type PreparedEndpointDelivery } from "./endpointDelivery.js";
import { executePreparedEndpointDelivery } from "./endpointExecution.js";
import { EndpointTransportReceipts } from "./endpointTransportReceipts.js";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, resolveEndpointExecutionOptions } from "./executionOptions.js";
import { normalizeAgentRequestEndpoint } from "./endpoint.js";
import { agentReplyRequest } from "./replyParameters.js";
import type { AgentThreadRequest } from "../agentThreads.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "../manager/agentEndpointDelivery.js";
import { EndpointDeliveryNotSentError } from "./deliveryFailure.js";

test("a transport acceptance followed by store close stays unconfirmed when both commit and error tracking reject", async () => {
  const f = fixture();
  const result = await executeEndpointAgentDelivery(f.request, { ...f.options, dispatch: async (delivery, guard) => {
    const receipt = await f.options.dispatch(delivery, guard);
    await f.store.close();
    return receipt;
  } });
  assert.equal(f.dispatched(), 1);
  assert.equal(result.statusCode, 202); assert.equal(result.data.status, "delivery_unconfirmed");
  assert.equal((result.data.delivery as { retryable: boolean }).retryable, false);
  assert.equal(f.store.listEndpointDeliveryMetadata()[0]!.state, "dispatching");
  assert.equal(f.store.list()[0]!.status, "pending_delivery");
});

test("reconciliation of an existing sent attempt cannot become not_started when receipt tracking closes", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery(f.request, { ...f.options, dispatch: async delivery => {
    await f.options.dispatch(delivery, () => {}); throw new Error("Original receipt acknowledgement lost.");
  } });
  const id = f.store.listEndpointDeliveryMetadata()[0]!.deliveryId;
  await assert.rejects((async () => {
    const { reconcileEndpointDelivery } = await import("./endpointDelivery.js");
    await reconcileEndpointDelivery(id, { ...f.options, reconcile: async (delivery, guard) => {
      const receipt = await f.options.reconcile(delivery, guard); await f.store.close(); return receipt;
    } });
  })(), { code: "AGENT_REQUEST_COMMIT_UNKNOWN", commitState: "unknown", retryable: false });
  assert.equal(f.dispatched(), 1); assert.equal(f.store.getEndpointDelivery(id)?.state, "dispatching");
});

test("a sticky tracking failure cannot advertise a no-frame attempt as prepared and retryable", async () => {
  for (const boundary of ["mark", "report"] as const) {
    const f = fixture();
    if (boundary === "report") f.store.noteEndpointDeliveryFailure = async () => { throw new Error("Sticky tracking failure."); };
    const result = await executeEndpointAgentDelivery(f.request, { ...f.options, dispatch: async () => {
      if (boundary === "mark") await f.store.close();
      throw new EndpointDeliveryNotSentError("Positive owner no-frame boundary.");
    } });
    assert.equal(result.statusCode, 202); assert.equal(result.data.status, "delivery_unconfirmed");
    assert.equal((result.data.delivery as { retryable: boolean }).retryable, false);
    assert.equal(f.dispatched(), 0);
    assert.equal(f.store.list()[0]!.status, "pending_delivery");
  }
});

test("cancellation while dispatch reservation commits cannot cross the delivery boundary", async () => {
  const f = fixture();
  let reserved!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { reserved = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalMark = f.store.markEndpointDispatching.bind(f.store);
  f.store.markEndpointDispatching = async id => {
    const attemptId = await originalMark(id);
    reserved(); await gate;
    return attemptId;
  };
  const sending = executeEndpointAgentDelivery(f.request, f.options);
  await dispatched;
  const request = f.store.list()[0]!;
  await f.store.cancel(request.id);
  release();
  const result = await sending;
  assert.equal(result.statusCode, 202);
  assert.equal(f.dispatched(), 0);
  assert.equal(f.store.get(request.id)?.status, "cancelled");
  assert.equal(f.store.listEndpointDeliveryMetadata()[0]?.state, "cancelled");
});

test("concurrent retries share the full asynchronous preparation and reject a conflicting intent", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void, preparations = 0;
  const enteredPreparation = new Promise<void>(resolve => { entered = resolve; });
  const preparationGate = new Promise<void>(resolve => { release = resolve; });
  const originalPrepare = f.store.prepare.bind(f.store);
  f.store.prepare = async input => {
    preparations++; entered(); await preparationGate;
    return originalPrepare(input);
  };
  const request = { ...f.request, deliveryId: "async-preparation-intent" };
  const first = executeEndpointAgentDelivery(request, f.options);
  await enteredPreparation;
  const second = executeEndpointAgentDelivery(request, f.options);
  await assert.rejects(executeEndpointAgentDelivery({ ...request, prompt: "A conflicting complete payload." }, f.options), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal(preparations, 1); assert.equal(f.dispatched(), 0);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.statusCode === 200));
  assert.equal(preparations, 1); assert.equal(f.dispatched(), 1);
  assert.equal(results[0]!.data.delivery && (results[0]!.data.delivery as { deliveryId: string }).deliveryId,
    results[1]!.data.delivery && (results[1]!.data.delivery as { deliveryId: string }).deliveryId);
});

test("endpoint recovery stop joins the already entered delivery before its store owner can close", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery({ ...f.request, deliveryId: "recovery-stop-owner" }, { ...f.options,
    refreshEndpoints: async (_identity, phase) => { if (phase === "dispatch") throw new Error("Receiver temporarily unavailable."); } });
  const metadata = f.store.listEndpointDeliveryMetadata()[0]!;
  let entered!: () => void, release!: () => void, stopped = false;
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const dispatchGate = new Promise<void>(resolve => { release = resolve; });
  const recovery = new EndpointDeliveryRecovery({ ...f.options, dispatch: async (delivery, guard) => {
    entered(); await dispatchGate; return f.options.dispatch(delivery, guard);
  } });
  await recovery.start();
  const active = recovery.recover(metadata.deliveryId);
  await sent;
  const stop = recovery.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(await recovery.recover("a-new-delivery-after-stop"), false);
  release(); assert.equal(await active, true); await stop;
  assert.equal(stopped, true);
  assert.equal(f.store.getEndpointDelivery(metadata.deliveryId)?.state, "committed");
});

test("prepared local reservations resume on their persisted deadline without Desktop events, with bounded concurrency and stoppable ownership", async t => {
  const f = fixture();
  const target = { ...party("b"), endpoint: { kind: "local", managerInstanceId: "manager", agentId: "receiver", provider: "dsh", sessionId: party("b").threadId, authorizationIncarnation: "incarnation-1" } as AgentRequestEndpoint };
  const offline = { ...f.options, resolveTarget: () => target, refreshEndpoints: async (_identities: unknown, phase?: string) => {
    if (phase !== "prepare") throw new EndpointVerificationError("target", new Error("fixture Desktop offline"));
  } };
  for (let n = 0; n < 5; n++) await executeEndpointAgentDelivery({ ...f.request, deliveryId: `timer-${n}`, responsePolicy: "none" }, offline);
  await executeEndpointAgentDelivery({ ...f.request, deliveryId: "unknown-timer", responsePolicy: "none" },
    { ...f.options, resolveTarget: () => target, dispatch: async () => { throw new Error("already wrote; result unknown"); } });
  const initial = (await f.store.listEndpointDeliveries());
  const data = f.persistence.value as { deliveries: Record<string, PreparedEndpointDelivery> };
  for (const delivery of Object.values(data.deliveries)) delivery.nextAttemptAt = new Date(Date.now() + 100).toISOString();
  const store = new AgentRequestStore(f.persistence);
  let concurrency = 0, maxConcurrency = 0, dispatches = 0, reconciles = 0;
  const options = { ...f.options, store, resolveTarget: () => target, reconcile: async () => { reconciles++; return undefined; }, dispatch: async (delivery: PreparedEndpointDelivery, guard: () => void) => {
    concurrency++; dispatches++; maxConcurrency = Math.max(maxConcurrency, concurrency);
    await new Promise(resolve => setTimeout(resolve, 35));
    try { return await f.options.dispatch(delivery, guard); } finally { concurrency--; }
  } };
  // Selection must not touch the old full-body list path.
  store.listEndpointDeliveries = () => { throw new Error("full prompt list forbidden for scheduling"); };
  const recovery = new EndpointDeliveryRecovery(options, { minimumDelayMs: 10, maximumBatchSize: 2 });
  t.after(() => recovery.stop()); await recovery.start(); recovery.start();
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(dispatches, 0);
  const deadline = Date.now() + 1500;
  while (store.listEndpointDeliveryMetadata().some(d => d.callerDeliveryId !== "unknown-timer" && d.state !== "committed") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(dispatches, 5); assert.ok(maxConcurrency <= 2);
  assert.equal(reconciles, 0); assert.equal(store.listEndpointDeliveryMetadata().filter(d => d.state === "dispatching").length, 1);
  assert.deepEqual(store.listEndpointDeliveryMetadata().map(d => d.deliveryId), initial.map(d => d.deliveryId));
  await recovery.stop();
  await executeEndpointAgentDelivery({ ...f.request, deliveryId: "after-stop", responsePolicy: "none" }, { ...offline, store });
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(dispatches, 5);
});

test("failed persistence never notifies recovery, observer errors are isolated and failure backoff survives restart", async () => {
  const f = fixture(); let changes = 0;
  const unsubscribe = f.store.onEndpointDeliveryChange(() => { changes++; });
  f.persistence.fail = true;
  await assert.rejects(executeEndpointAgentDelivery({ ...f.request, responsePolicy: "none" }, f.options), /disk unavailable/);
  await Promise.resolve(); assert.equal(changes, 0);
  f.persistence.fail = false;
  f.store.onEndpointDeliveryChange(() => { throw new Error("observer must not invalidate committed state"); });
  const offline = { ...f.options, refreshEndpoints: async (_identities: unknown, phase?: string) => { if (phase !== "prepare") throw new Error("offline"); } };
  const sent = await executeEndpointAgentDelivery({ ...f.request, responsePolicy: "none" }, offline);
  assert.equal(sent.statusCode, 503); await Promise.resolve(); assert.ok(changes > 0);
  const original = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  const restarted = new AgentRequestStore(f.persistence);
  assert.equal(restarted.getEndpointDelivery(original.deliveryId)?.nextAttemptAt, original.nextAttemptAt);
  assert.ok(Date.parse(original.nextAttemptAt!) > Date.parse(original.updatedAt!));
  await restarted.noteEndpointDeliveryFailure(original.deliveryId, new Error("still offline"));
  const next = restarted.getEndpointDelivery(original.deliveryId)!;
  assert.equal(next.retryCount, 2); assert.ok(Date.parse(next.nextAttemptAt!) - Date.parse(next.updatedAt!) >= 2_000);
  unsubscribe();
});

test("generic progress events respect prepared backoff while exact target recovery and HTTP share one dispatch", async () => {
  const f = fixture(); let available = false, preflightChecks = 0;
  const request = { ...f.request, deliveryId: "generic-event-backoff", responsePolicy: "none" as const };
  const options = { ...f.options, refreshEndpoints: async (_identities: unknown, phase?: string) => {
    if (phase !== "prepare") { preflightChecks++; if (!available) throw new Error("owner offline"); }
  } };
  await executeEndpointAgentDelivery(request, options);
  const original = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!; const deadline = original.nextAttemptAt;
  const recovery = new EndpointDeliveryRecovery(options, { maximumBatchSize: 2 });
  await Promise.all(Array.from({ length: 30 }, () => recovery.onEvent()));
  assert.equal(preflightChecks, 1); assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.nextAttemptAt, deadline);
  available = true;
  await Promise.all([recovery.onEvent(original.target), executeEndpointAgentDelivery(request, options), recovery.onEvent(original.target)]);
  assert.equal(f.dispatched(), 1); assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "committed");
});

class Memory implements AgentRequestPersistence {
  value: unknown;
  fail = false;
  read() { return this.value; }
  write(value: unknown) { if (this.fail) throw new Error("disk unavailable"); this.value = structuredClone(value); }
}
const endpoint = (id: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: "manager", instanceId: `instance-${id}`,
  nodeId: `node-${id}`, agentId: `agent-${id}`, provider: "dsh", sessionId: `opaque-${id}-${"x".repeat(700)}`, authorizationIncarnation: "incarnation-1" });
const party = (id: string) => ({ threadId: endpoint(id).sessionId, agentAdapter: "dsh" as const, agentType: "agent", workspace: "workspace", endpoint: endpoint(id) });
function fixture() {
  const persistence = new Memory();
  const store = new AgentRequestStore(persistence);
  let dispatched = 0;
  const receipts = new Map<string, EndpointDeliveryReceipt>();
  const options: EndpointDeliveryOptions = { store, managerInstanceId: "manager", resolveSource: () => party("a"), resolveTarget: () => party("b"), resolveExecutionOptions: request => ({ cwd: request.cwd ?? "workspace" }), authorize: () => {},
    dispatch: async delivery => { dispatched++; const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation,
      promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target, accepted: true, action: "started", transport: "http" }; receipts.set(delivery.deliveryId, receipt); return receipt; },
    reconcile: async delivery => receipts.get(delivery.deliveryId) };
  const request = { action: "send" as const, sourceThreadId: party("a").threadId, sourceAgentType: "agent" as const, threadId: party("b").threadId,
    agentAdapter: "dsh" as const, responsePolicy: "required" as const, responseInstruction: "Return evidence", prompt: "Execute scoped task",
    messageSource: { type: "agent" as const, agentAdapter: "dsh" as const, sessionName: "source", sessionId: party("a").threadId } };
  return { persistence, store, options, request, receipts, dispatched: () => dispatched };
}

test("remote to remote request and authenticated formal reply survive restart with full opaque IDs", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  assert.equal(original.status, "awaiting_response");
  assert.equal(original.source.threadId, party("a").threadId);
  const store = new AgentRequestStore(f.persistence);
  const options = { ...f.options, store, resolveSource: () => party("b"), resolveTarget: () => party("a") };
  await executeEndpointAgentDelivery({ ...f.request, sourceThreadId: party("b").threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: party("b").threadId }, inReplyToRequestId: original.id, result: "verified", nextAction: "continue", responsePolicy: "none" }, options);
  assert.equal(store.get(original.id)?.status, "responded");
  assert.equal(store.get(original.id)?.response?.by.endpoint?.nodeId, endpoint("b").nodeId);
});

test("stable caller deliveryId returns one original delivery across retries, concurrency and restart", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "caller-operation" };
  const concurrent = await Promise.all([executeEndpointAgentDelivery(request, f.options), executeEndpointAgentDelivery(request, f.options)]);
  assert.equal(f.dispatched(), 1);
  const deliveryId = (concurrent[0].data.delivery as { deliveryId: string }).deliveryId;
  assert.equal((concurrent[1].data.delivery as { deliveryId: string }).deliveryId, deliveryId);
  const store = new AgentRequestStore(f.persistence);
  const resumed = await executeEndpointAgentDelivery(request, { ...f.options, store, resolveExecutionOptions: () => { throw new Error("retry must use frozen options"); } });
  assert.equal(resumed.statusCode, 200);
  assert.equal((resumed.data.delivery as { deliveryId: string }).deliveryId, deliveryId);
  assert.equal(store.list().length, 1);
  assert.equal(f.dispatched(), 1);
  assert.equal(store.getEndpointDelivery(deliveryId)?.callerDeliveryId, request.deliveryId);
});

test("instance alias changes retain the original caller intent across restart and reject a changed payload", async () => {
  const f = fixture(), request = { ...f.request, deliveryId: "same-alias-intent" };
  const first = await executeEndpointAgentDelivery(request, f.options);
  const alias = (id: string) => ({ ...party(id), endpoint: { ...endpoint(id), agentId: `new-alias-${id}` } });
  const options = { ...f.options, store: new AgentRequestStore(f.persistence), resolveSource: () => alias("a"), resolveTarget: () => alias("b") };
  const next = await executeEndpointAgentDelivery(request, options);
  assert.equal((next.data.delivery as any).deliveryId, (first.data.delivery as any).deliveryId);
  assert.equal(f.dispatched(), 1);
  await assert.rejects(executeEndpointAgentDelivery({ ...request, prompt: "different intent" }, options), /conflicts/);
  assert.equal(f.dispatched(), 1);
});

test("historical alias-dependent keys and hashes reconcile their exact original receipt without rewriting identity", async () => {
  const f = fixture(), request = { ...f.request, deliveryId: "legacy-alias-intent" };
  const first = await executeEndpointAgentDelivery(request, f.options);
  const currentId = (first.data.delivery as any).deliveryId;
  const raw = f.persistence.value as any, delivery = raw.deliveries[currentId];
  // Captured from the prior implementation with this exact public fixture request.
  const legacyId = "agent-7f10f4bc18d48d9818169ea06c99c0652b85bd3788297fd16ec87015d506d804";
  const legacyHash = "0e76ab18a5679df2d5a611522326c02164df24161c3081f7bf85e270627b9285";
  delete raw.deliveries[currentId];
  delivery.deliveryId = delivery.preparation.deliveryId = delivery.receipt.deliveryId = legacyId;
  delivery.requestHash = legacyHash; raw.deliveries[legacyId] = delivery;
  raw.requests[delivery.preparation.requestId].deliveryId = legacyId;
  const alias = (id: string) => ({ ...party(id), endpoint: { ...endpoint(id), agentId: `renamed-${id}` } });
  const store = new AgentRequestStore(f.persistence);
  const next = await executeEndpointAgentDelivery(request, { ...f.options, store, resolveSource: () => alias("a"), resolveTarget: () => alias("b") });
  assert.equal((next.data.delivery as any).deliveryId, legacyId);
  assert.equal(f.dispatched(), 1); assert.equal(store.list().length, 1);
  assert.equal((f.persistence.value as any).deliveries[legacyId].requestHash, legacyHash);
});

test("ambiguous or damaged historical caller evidence blocks only that intent instead of creating another delivery", async () => {
  for (const damaged of [false, true]) {
    const f = fixture(), request = { ...f.request, deliveryId: "ambiguous-alias-intent" };
    await executeEndpointAgentDelivery(request, f.options);
    const raw = f.persistence.value as any, original = Object.values(raw.deliveries)[0] as any;
    const duplicate = structuredClone(original);
    duplicate.deliveryId = duplicate.preparation.deliveryId = duplicate.receipt.deliveryId = "historical-alias-reservation";
    duplicate.source.agentId = duplicate.preparation.source.endpoint.agentId = "historical-alias";
    if (damaged) duplicate.prompt = null;
    raw.deliveries[duplicate.deliveryId] = duplicate;
    const store = new AgentRequestStore(f.persistence), options = { ...f.options, store };
    await assert.rejects(executeEndpointAgentDelivery(request, options), /ambiguous or damaged/);
    assert.equal(f.dispatched(), 1);
    await executeEndpointAgentDelivery({ ...request, deliveryId: "independent-caller-intent" }, options);
    assert.equal(f.dispatched(), 2);
    assert.ok((f.persistence.value as any).deliveries[duplicate.deliveryId]);
  }
});

test("an old alias request reservation without its delivery body still forbids replay under a new alias", async () => {
  const f = fixture(), request = { ...f.request, deliveryId: "legacy-alias-intent" };
  await f.store.prepare({ source: party("a"), target: party("b"), responsePolicy: "required", responseInstruction: "Return evidence",
    deliveryId: "agent-7f10f4bc18d48d9818169ea06c99c0652b85bd3788297fd16ec87015d506d804" });
  const source = { ...party("a"), endpoint: { ...endpoint("a"), agentId: "renamed-source" } };
  await assert.rejects(executeEndpointAgentDelivery(request, { ...f.options, store: new AgentRequestStore(f.persistence), resolveSource: () => source }), /ambiguous or damaged/);
  assert.equal(f.dispatched(), 0);
});

test("unknown new send acknowledgement only reconciles its original reservation", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "lost-ack", responsePolicy: "none" as const };
  const options = { ...f.options, dispatch: async (delivery: Parameters<EndpointDeliveryOptions["dispatch"]>[0], guard: () => void) => {
    await f.options.dispatch(delivery, guard); throw new Error("lost acknowledgement");
  } };
  assert.equal((await executeEndpointAgentDelivery(request, options)).statusCode, 202);
  const result = await executeEndpointAgentDelivery(request, { ...options, store: new AgentRequestStore(f.persistence) });
  assert.equal(result.statusCode, 200);
  assert.equal(f.dispatched(), 1);
});

test("same caller key rejects content, target, role and explicit execution changes before another dispatch", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "immutable-operation" };
  await executeEndpointAgentDelivery(request, f.options);
  for (const changed of [{ prompt: "different" }, { responsePolicy: "none" as const }, { cwd: "different" }, { model: "different" },
    { reasoningEffort: "high" as const }, { contextBlocks: ["different"] }, { sourceAgentType: "plan_agent" as const }]) {
    const options = changed.sourceAgentType ? { ...f.options, resolveSource: () => ({ ...party("a"), agentType: changed.sourceAgentType! }) } : f.options;
    await assert.rejects(() => executeEndpointAgentDelivery({ ...request, ...changed }, options), { code: "AGENT_DELIVERY_ID_CONFLICT", field: "deliveryId" });
  }
  await assert.rejects(() => executeEndpointAgentDelivery({ ...request, threadId: party("c").threadId }, { ...f.options, resolveTarget: () => party("c") }),
    { code: "AGENT_DELIVERY_ID_CONFLICT" });
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options, resolveSource: () => ({ ...party("a"),
    endpoint: { ...endpoint("a"), authorizationIncarnation: "rebound" } }) }), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal(f.dispatched(), 1);
});

test("cached receipt never bypasses current owner qualification and caller keys are scoped to their real source", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "shared-caller-key" };
  await executeEndpointAgentDelivery(request, f.options);
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options,
    refreshEndpoints: async () => { throw new Error("source revoked"); } }), /source revoked/);
  const other = await executeEndpointAgentDelivery({ ...request, sourceThreadId: party("c").threadId,
    messageSource: { ...request.messageSource, sessionId: party("c").threadId } }, { ...f.options, resolveSource: () => party("c") });
  assert.equal(other.statusCode, 200);
  assert.equal(f.dispatched(), 2);
  assert.equal((await f.store.listEndpointDeliveries()).length, 2);
});

test("orphaned stable reservation cannot create a replacement after restart, while an undispatched prepared snapshot can complete once", async () => {
  const orphan = fixture();
  const callerDeliveryId = "orphan-operation";
  const deliveryId = sourceScopedAgentDeliveryId(endpoint("a"), callerDeliveryId);
  await orphan.store.prepare({ deliveryId, source: party("a"), target: party("b"), responsePolicy: "required", responseInstruction: "Return evidence" });
  await assert.rejects(() => executeEndpointAgentDelivery({ ...orphan.request, deliveryId: callerDeliveryId },
    { ...orphan.options, store: new AgentRequestStore(orphan.persistence) }), { code: "AGENT_DELIVERY_RESERVATION_EXISTS" });
  assert.equal(orphan.dispatched(), 0);

  const prepared = fixture();
  const request = { ...prepared.request, deliveryId: "prepared-operation" };
  const mark = prepared.store.markEndpointDispatching.bind(prepared.store);
  prepared.store.markEndpointDispatching = () => { throw new Error("persist transition unavailable"); };
  await assert.rejects(() => executeEndpointAgentDelivery(request, prepared.options), /persist transition unavailable/);
  assert.equal(prepared.dispatched(), 0);
  prepared.store.markEndpointDispatching = mark;
  const restarted = new AgentRequestStore(prepared.persistence);
  assert.equal((await executeEndpointAgentDelivery(request, { ...prepared.options, store: restarted })).statusCode, 200);
  assert.equal(prepared.dispatched(), 1);
});

test("legacy sends without a caller key retain independent operations", async () => {
  const f = fixture();
  const first = await executeEndpointAgentDelivery(f.request, f.options);
  const second = await executeEndpointAgentDelivery(f.request, f.options);
  assert.notEqual((first.data.delivery as { deliveryId: string }).deliveryId, (second.data.delivery as { deliveryId: string }).deliveryId);
  assert.equal(f.dispatched(), 2);
});

test("stable owner proof ignores object key order and rejects a resolver substituting another target", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "canonical-owner" };
  await executeEndpointAgentDelivery(request, f.options);
  const reordered = Object.fromEntries(Object.entries(endpoint("a")).reverse()) as AgentRequestEndpoint;
  assert.equal((await executeEndpointAgentDelivery(request, { ...f.options, resolveSource: () => ({ ...party("a"), endpoint: reordered }) })).statusCode, 200);
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options, resolveTarget: () => party("c") }), { field: "threadId" });
  assert.equal(f.dispatched(), 1);
});

test("a still-unknown caller retry and a cancelled cached request never dispatch again", async () => {
  const unknown = fixture();
  let sends = 0;
  const options = { ...unknown.options, dispatch: async () => { sends++; throw new Error("unknown without receipt"); } };
  const request = { ...unknown.request, deliveryId: "unknown-operation" };
  assert.equal((await executeEndpointAgentDelivery(request, options)).statusCode, 202);
  assert.equal((await executeEndpointAgentDelivery(request, { ...options, store: new AgentRequestStore(unknown.persistence) })).statusCode, 202);
  assert.equal(sends, 1);
  await unknown.store.cancel(unknown.store.list()[0].id);
  await assert.rejects(() => executeEndpointAgentDelivery(request, options), /cancelled/);
  assert.equal(sends, 1);
});

test("trusted caller execution snapshot keeps managed default drift out of the key while explicit model changes conflict", async () => {
  const f = fixture();
  const target = { ...party("b"), agentAdapter: "codex" as const, endpoint: { ...endpoint("b"), provider: "codex" } };
  const request = { ...f.request, agentAdapter: "codex" as const, deliveryId: "default-model-operation", model: "managed-model-original" };
  const options: EndpointDeliveryOptions = { ...f.options, resolveTarget: () => target, callerExecutionOptions: {},
    resolveExecutionOptions: value => ({ cwd: "workspace", model: value.model }) };
  await executeEndpointAgentDelivery(request, options);
  const retry = await executeEndpointAgentDelivery({ ...request, model: "managed-model-new" }, { ...options,
    resolveExecutionOptions: () => { throw new Error("defaults must not be resolved again"); } });
  assert.equal(retry.statusCode, 200);
  assert.equal((await f.store.listEndpointDeliveries())[0].executionOptions.model, "managed-model-original");
  await assert.rejects(() => executeEndpointAgentDelivery({ ...request, model: "explicit-new-model" },
    { ...options, callerExecutionOptions: { model: "explicit-new-model" } }), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  // A similarly named body property never supplies the strong internal options snapshot.
  await assert.rejects(() => executeEndpointAgentDelivery({ ...request, model: "explicit-new-model", callerExecutionOptions: {} } as typeof request,
    { ...options, callerExecutionOptions: undefined }), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal(f.dispatched(), 1);
});

test("malformed persisted evidence for an untracked send retains its original replay prohibition", async () => {
  const f = fixture();
  const request = { ...f.request, deliveryId: "untracked-evidence", responsePolicy: "none" as const };
  await executeEndpointAgentDelivery(request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  const persisted = structuredClone(f.persistence.value) as { deliveries: Record<string, typeof delivery> };
  persisted.deliveries[delivery.deliveryId].promptHash = "malformed";
  f.persistence.value = persisted;
  const restarted = new AgentRequestStore(f.persistence);
  assert.equal((await restarted.listEndpointDeliveries()).length, 0);
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options, store: restarted }), { code: "AGENT_DELIVERY_RESERVATION_EXISTS" });
  // An unrelated legitimate write must not erase the rejected original ID on the next restart.
  await restarted.prepare({ source: party("c"), target: party("b"), responsePolicy: "required", responseInstruction: "Return evidence" });
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options, store: new AgentRequestStore(f.persistence) }),
    { code: "AGENT_DELIVERY_RESERVATION_EXISTS" });
  assert.equal(f.dispatched(), 1);
});

test("primary persona and plan roles receive formal service replies on the original role and complete endpoint", async () => {
  for (const originalRole of ["primary_persona", "plan_agent"] as const) {
    const f = fixture();
    const source = { ...party("a"), agentAdapter: "codex" as const, agentType: originalRole,
      endpoint: { kind: "local" as const, managerInstanceId: "manager", agentId: "local:codex", provider: "codex", sessionId: party("a").threadId, authorizationIncarnation: "source-epoch" } };
    const service = { agentAdapter: "grokBot" as const, agentType: "agent", threadId: "opaque-cloud-session", threadName: "Native service",
      endpoint: { kind: "service" as const, managerInstanceId: "manager", agentId: "native-bot", provider: "grokBot", sessionId: "opaque-cloud-session", authorizationIncarnation: "native-account-epoch" } };
    const outbound = { ...f.request, agentAdapter: "grokBot" as const, threadId: service.threadId, sourceAgentType: originalRole,
      messageSource: { ...f.request.messageSource, agentAdapter: "codex" as const } };
    await executeEndpointAgentDelivery(outbound, { ...f.options, resolveSource: () => source, resolveTarget: () => service, resolveExecutionOptions: () => ({}) });
    const original = f.store.list()[0];
    const reply = { ...f.request, ...agentReplyRequest({ source: original.source, target: original.target, requestId: original.id }),
      action: "send" as const, agentAdapter: "codex" as const, sourceThreadId: service.threadId, sourceAgentType: "agent" as const,
      threadId: source.threadId, inReplyToRequestId: original.id, responsePolicy: "none" as const, result: "Verified", nextAction: "Continue",
      messageSource: { type: "agent" as const, agentAdapter: "grokBot" as const, sessionId: service.threadId, sessionName: service.threadName } };
    const options = { ...f.options, resolveSource: () => service, resolveTarget: () => ({ ...source, agentType: "agent" }) };
    await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, sourceAgentType: "plan_agent" },
      { ...options, resolveSource: () => ({ ...service, agentType: "plan_agent" }) }), /original target task|exact authenticated endpoints/);
    const foreign = { ...source, threadId: "foreign-owner", endpoint: { ...source.endpoint, sessionId: "foreign-owner" } };
    await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, threadId: foreign.threadId },
      { ...options, resolveTarget: () => foreign }), /original target task|exact authenticated endpoints/);
    const accepted = await executeEndpointAgentDelivery(reply, options);
    assert.equal(accepted.statusCode, 200);
    assert.equal(f.store.get(original.id)?.status, "responded");
    const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries()).at(-1)!)!.deliveryId))!;
    assert.equal(delivery.preparation.target.agentType, originalRole);
    assert.deepEqual(delivery.target, original.source.endpoint);
    assert.deepEqual(delivery.source, original.target.endpoint);
  }
});

test("unknown reply is reserved durably and event recovery does not redispatch", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"), dispatch: async (delivery: Parameters<EndpointDeliveryOptions["dispatch"]>[0]) => {
    const receipt = await f.options.dispatch(delivery, () => {}); throw new Error("receipt lost");
  }, reconcile: async () => undefined as EndpointDeliveryReceipt | undefined };
  const reply = { ...f.request, sourceThreadId: party("b").threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: party("b").threadId }, inReplyToRequestId: original.id, result: "verified", nextAction: "continue", responsePolicy: "none" as const };
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  options.store = new AgentRequestStore(f.persistence);
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  assert.equal(f.dispatched(), 2);
  options.reconcile = f.options.reconcile;
  const recovery = new EndpointDeliveryRecovery(options);
  await Promise.all([recovery.onEvent(), recovery.onEvent()]);
  assert.equal(options.store.get(original.id)?.status, "responded");
  assert.equal(f.dispatched(), 2);
});

test("changed incarnation, spoofed source and cancelled reservations fail closed", async () => {
  const f = fixture();
  await assert.rejects(executeEndpointAgentDelivery({ ...f.request, sourceThreadId: "forged" }, f.options), /source/);
  await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const changed = { ...party("b"), endpoint: { ...endpoint("b"), authorizationIncarnation: "incarnation-2" } };
  await assert.rejects(executeEndpointAgentDelivery({ ...f.request, sourceThreadId: changed.threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: changed.threadId }, inReplyToRequestId: original.id, result: "ok", nextAction: "continue" },
  { ...f.options, resolveSource: () => changed, resolveTarget: () => party("a") }), /original target/);
  await f.store.cancel(original.id);
  assert.throws(() => f.store.assertEndpointDeliveryActive(original.deliveryId), /cancel/);
});

test("prepare persistence failure rolls back reply reservation and new record", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0]; f.persistence.fail = true;
  await assert.rejects(async () => (await f.store.prepare({ source: party("b"), target: party("a"), responsePolicy: "required", responseInstruction: "reply",
    inReplyToRequestId: original.id, result: "ok", nextAction: "continue" })), /disk unavailable/);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.get(original.id)?.pendingResponseDeliveryId, undefined);
});

test("transport crash/timeout is durable unknown and never automatically replayed", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-receipts-"));
  const ledger = new EndpointTransportReceipts(directory);
  let sends = 0;
  const context = { endpoint: delivery.target, assertAuthorized: () => {}, readReceipt: (d: typeof delivery) => ledger.readReceipt(d),
    beginAttempt: (d: typeof delivery) => ledger.beginAttempt(d), writeReceipt: (d: typeof delivery, r: EndpointDeliveryReceipt) => ledger.writeReceipt(d, r),
    send: async () => { sends++; throw new Error("unknown transport result"); } };
  await assert.rejects(executePreparedEndpointDelivery(delivery, context), /unknown transport/);
  assert.equal(await executePreparedEndpointDelivery(delivery, context), undefined);
  assert.equal(await executePreparedEndpointDelivery(delivery, context, true), undefined);
  assert.equal(sends, 1);
});

test("mismatched receipt never commits and failed commit retains recoverable reservation", async () => {
  const f = fixture();
  const options = { ...f.options, dispatch: async (delivery: Parameters<EndpointDeliveryOptions["dispatch"]>[0]) => ({
    ...(await f.options.dispatch(delivery, () => {})), generation: "forged-generation" }) };
  assert.equal((await executeEndpointAgentDelivery(f.request, options)).statusCode, 202);
  const original = f.store.list()[0];
  assert.equal(original.status, "pending_delivery");
  const recovery = new EndpointDeliveryRecovery(f.options);
  f.persistence.fail = true;
  assert.equal(await recovery.recover(original.deliveryId).catch(() => false), false);
  assert.equal(f.store.get(original.id)?.status, "pending_delivery");
  assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "dispatching");
  f.persistence.fail = false;
  assert.equal(await recovery.recover(original.deliveryId), true);
  assert.equal(f.dispatched(), 1);
});

test("recovery can persist exact owner receipt without replay when transport ledger was lost", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  const ledger = new EndpointTransportReceipts(fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-recovered-")));
  let sends = 0;
  const context = { endpoint: delivery.target, assertAuthorized: () => {}, readReceipt: (d: typeof delivery) => ledger.readReceipt(d),
    beginAttempt: (d: typeof delivery) => ledger.beginAttempt(d), writeReceipt: (d: typeof delivery, r: EndpointDeliveryReceipt) => ledger.writeReceipt(d, r),
    recoverReceipt: async () => f.receipts.get(delivery.deliveryId),
    send: async () => { sends++; throw new Error("must not send"); } };
  assert.equal((await executePreparedEndpointDelivery(delivery, context, true))?.deliveryId, delivery.deliveryId);
  assert.equal((await ledger.readReceipt(delivery))?.generation, delivery.generation);
  assert.equal(sends, 0);
});

test("formal reply recovers original lost acknowledgement from exact endpoint evidence before preparing reply", async () => {
  const f = fixture();
  const options = { ...f.options, dispatch: async (delivery: Parameters<EndpointDeliveryOptions["dispatch"]>[0]) => {
    await f.options.dispatch(delivery, () => {}); throw new Error("lost acknowledgement"); } };
  assert.equal((await executeEndpointAgentDelivery(f.request, options)).statusCode, 202);
  const original = f.store.list()[0];
  assert.equal(original.status, "pending_delivery");
  await executeEndpointAgentDelivery({ ...f.request, sourceThreadId: party("b").threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: party("b").threadId }, inReplyToRequestId: original.id,
    result: "verified", nextAction: "continue", responsePolicy: "none" }, { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a") });
  assert.equal(f.store.get(original.id)?.status, "responded");
  assert.equal(f.dispatched(), 2);
});

test("abort cannot release a dispatched endpoint reservation", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  await assert.rejects(async () => (await f.store.abort(delivery.preparation)), /cannot release/);
  assert.equal(f.store.get(delivery.preparation.requestId!)?.status, "awaiting_response");
});

test("failed cancellation restores request and endpoint state", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const record = f.store.list()[0]; f.persistence.fail = true;
  await assert.rejects(async () => (await f.store.cancel(record.id)), /disk unavailable/);
  assert.equal(f.store.get(record.id)?.status, "awaiting_response");
  assert.equal(f.store.getEndpointDelivery(record.deliveryId)?.state, "committed");
});

test("execution options canonicalize and explicit model never inherits unrelated reasoning defaults", () => {
  const request = { action: "send" as const, agentAdapter: "codex" as const };
  assert.deepEqual(resolveEndpointExecutionOptions(request, "owner", { model: "route-model", reasoningEffort: "high" }),
    { cwd: "owner", model: "route-model", reasoningEffort: "high" });
  assert.deepEqual(resolveEndpointExecutionOptions({ ...request, cwd: "execution", model: "explicit-model" }, "owner",
    { model: "route-model", reasoningEffort: "high" }), { cwd: "execution", model: "explicit-model" });
  assert.deepEqual(resolveEndpointExecutionOptions(request, "owner", undefined), { cwd: "owner" });
  assert.equal(endpointExecutionOptionsHash({ model: "model", cwd: "workspace" }),
    endpointExecutionOptionsHash({ cwd: "workspace", model: "model" }));
  assert.throws(() => normalizeEndpointExecutionOptions({ cwd: "workspace", unknown: true }), /Unsupported/);
  assert.throws(() => resolveEndpointExecutionOptions({ ...request, agentAdapter: "dsh", model: "model" }, "owner", undefined), /cannot apply/);
  assert.throws(() => resolveEndpointExecutionOptions({ ...request, reasoningEffort: "high" }, "owner", undefined), /requires/);
});

test("options tampering is rejected before transport IO and malformed persisted evidence cannot recover", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  let io = 0;
  await assert.rejects(executePreparedEndpointDelivery({ ...delivery, executionOptions: { cwd: "different" } }, {
    endpoint: delivery.target, assertAuthorized: () => {}, readReceipt: async () => { io++; return undefined; },
    beginAttempt: async () => { io++; return true; }, writeReceipt: async () => { io++; },
    send: async () => { io++; return { threadId: delivery.target.sessionId, action: "started", transport: "http" }; }
  }), /hash mismatch/);
  assert.equal(io, 0);
  const persisted = structuredClone(f.persistence.value) as { deliveries: Record<string, typeof delivery> };
  persisted.deliveries[delivery.deliveryId].executionOptions.cwd = "different";
  f.persistence.value = persisted;
  assert.equal((await new AgentRequestStore(f.persistence).listEndpointDeliveries()).length, 0);
});

test("restart recovery retains frozen defaults, ignores changed resolvers and never resends", async () => {
  const f = fixture();
  const frozen = { cwd: "execution", model: "original-model", reasoningEffort: "high" as const };
  f.options.resolveExecutionOptions = () => frozen;
  f.options.dispatch = async () => { throw new Error("receipt lost"); };
  const result = await executeEndpointAgentDelivery(f.request, f.options);
  assert.equal(result.statusCode, 202);
  frozen.model = "changed-model";
  const store = new AgentRequestStore(f.persistence);
  const delivery = (await store.readEndpointDelivery(((await store.listEndpointDeliveries())[0])!.deliveryId))!;
  assert.deepEqual(delivery.executionOptions, { cwd: "execution", model: "original-model", reasoningEffort: "high" });
  let sends = 0, resolutions = 0, reconciliations = 0;
  const recovery = new EndpointDeliveryRecovery({ ...f.options, store,
    resolveExecutionOptions: () => { resolutions++; return { cwd: "changed" }; },
    dispatch: async () => { sends++; throw new Error("must not replay"); },
    reconcile: async saved => { reconciliations++; assert.deepEqual(saved.executionOptions, delivery.executionOptions);
      return { deliveryId: saved.deliveryId, generation: saved.generation, promptHash: saved.promptHash,
        executionOptionsHash: saved.executionOptionsHash, endpoint: saved.target, accepted: true, action: "recovered", transport: "http" }; }
  });
  await recovery.onEvent();
  assert.equal(store.getEndpointDelivery(delivery.deliveryId)?.state, "committed");
  assert.equal(reconciliations, 1); assert.equal(sends, 0); assert.equal(resolutions, 0);
});

test("receipt options hash mismatch stays unconfirmed and transport ledger rejects changed options", async () => {
  const f = fixture();
  const dispatch = f.options.dispatch;
  f.options.dispatch = async (delivery, guard) => ({ ...await dispatch(delivery, guard), executionOptionsHash: "wrong" });
  assert.equal((await executeEndpointAgentDelivery(f.request, f.options)).statusCode, 202);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  assert.equal(delivery.state, "dispatching");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-options-"));
  try {
    const ledger = new EndpointTransportReceipts(directory);
    assert.equal(await ledger.beginAttempt(delivery), true);
    const changed = { ...delivery, executionOptions: { cwd: "different" }, executionOptionsHash: endpointExecutionOptionsHash({ cwd: "different" }) };
    await assert.rejects(ledger.beginAttempt(changed), /identity|match/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("authority revoked after async receipt IO prevents send", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  let authorized = true, sends = 0;
  await assert.rejects(executePreparedEndpointDelivery(delivery, { endpoint: delivery.target,
    assertAuthorized: () => { if (!authorized) throw new Error("revoked"); }, readReceipt: async () => { authorized = false; return undefined; },
    beginAttempt: async () => true, writeReceipt: async () => {}, send: async () => { sends++; return { threadId: delivery.target.sessionId, action: "started", transport: "http" }; } }), /revoked/);
  assert.equal(sends, 0);
});

test("device source has no workspace requirement and formal replies preserve its exact owner", async () => {
  const f = fixture();
  const deviceEndpoint: AgentRequestEndpoint = { kind: "device", managerInstanceId: "manager", instanceId: "manager", agentId: "glasses", provider: "deviceAgent", sessionId: "device-session", authorizationIncarnation: "device-epoch" };
  const deviceParty = { endpoint: deviceEndpoint, threadId: deviceEndpoint.sessionId, agentAdapter: "deviceAgent" as const, agentType: "agent" };
  assert.deepEqual(normalizeAgentRequestEndpoint(deviceEndpoint), deviceEndpoint);
  assert.throws(() => normalizeAgentRequestEndpoint({ ...deviceEndpoint, nodeId: "forged" }), /device endpoint/);
  f.options.resolveSource = () => deviceParty;
  const source = { type: "agent" as const, agentAdapter: "deviceAgent" as const, sessionName: "Glasses", sessionId: deviceEndpoint.sessionId };
  await executeEndpointAgentDelivery({ ...f.request, sourceThreadId: deviceEndpoint.sessionId, messageSource: source }, f.options);
  const original = f.store.list()[0];
  assert.equal(original.source.workspace, undefined);
  const reply = agentReplyRequest({ source: original.source, target: original.target, requestId: original.id });
  assert.deepEqual(reply.instanceBinding, { instanceId: "manager", agentId: "glasses" });
  assert.equal(reply.agentAdapter, "deviceAgent");
  const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => deviceParty, resolveExecutionOptions: () => ({}) };
  await executeEndpointAgentDelivery({ ...f.request, agentAdapter: "deviceAgent", sourceThreadId: party("b").threadId, threadId: deviceEndpoint.sessionId,
    messageSource: f.request.messageSource.type === "agent" ? { ...f.request.messageSource, sessionId: party("b").threadId } : f.request.messageSource,
    inReplyToRequestId: original.id, result: "Verified", nextAction: "Continue", responsePolicy: "none" }, options);
  assert.equal(f.store.get(original.id)?.status, "responded");
  assert.deepEqual((await f.store.listEndpointDeliveries()).at(-1)?.executionOptions, {});
});

test("device execution snapshots omit PC cwd while PC execution still requires its owner context", () => {
  assert.deepEqual(resolveEndpointExecutionOptions({ action: "send", agentAdapter: "deviceAgent" }, undefined, undefined), {});
  assert.throws(() => resolveEndpointExecutionOptions({ action: "send", agentAdapter: "deviceAgent", model: "PC model" }, undefined, undefined), /own runtime/);
  assert.throws(() => resolveEndpointExecutionOptions({ action: "send", agentAdapter: "codex" }, undefined, undefined), /actual owner/);
  assert.deepEqual(normalizeEndpointExecutionOptions({}), {});
});

test("formal endpoint replies keep original Agent types without treating directory metadata as identity", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const reply = { ...f.request, sourceThreadId: party("b").threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: party("b").threadId }, inReplyToRequestId: original.id,
    result: "Verified", nextAction: "Continue", responsePolicy: "none" as const };
  const changedDirectories = { ...f.options, resolveSource: () => ({ ...party("b"), workspace: "updated-owner-directory" }),
    resolveTarget: () => ({ ...party("a"), workspace: undefined }) };
  await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, sourceAgentType: "plan_agent" }, {
    ...changedDirectories, resolveSource: () => ({ ...party("b"), workspace: "updated-owner-directory", agentType: "plan_agent" })
  }), /original target task|exact authenticated endpoints/);
  assert.equal(f.store.get(original.id)?.status, "awaiting_response");
  const result = await executeEndpointAgentDelivery(reply, changedDirectories);
  assert.equal(result.statusCode, 200);
  assert.equal(f.store.get(original.id)?.status, "responded");
  assert.equal(f.store.get(original.id)?.response?.by.agentType, "agent");
});

test("fresh endpoint proofs reject revocation before preparation and after owner IO without replacing original identity", async () => {
  const before = fixture();
  before.options.refreshEndpoints = async identities => {
    assert.equal(Object.isFrozen(identities.source), true);
    assert.equal(identities.source.authorizationIncarnation, "incarnation-1");
    throw new Error("source proof revoked");
  };
  await assert.rejects(() => executeEndpointAgentDelivery(before.request, before.options), /source proof revoked/);
  assert.equal(before.store.list().length, 0);
  assert.equal(before.dispatched(), 0);

  const after = fixture();
  let refreshes = 0;
  after.options.refreshEndpoints = async () => { if (++refreshes === 3) throw new Error("target proof revoked after IO"); };
  const result = await executeEndpointAgentDelivery(after.request, after.options);
  assert.equal(result.statusCode, 202);
  assert.equal(after.dispatched(), 1);
  const original = (await after.store.readEndpointDelivery(((await after.store.listEndpointDeliveries())[0])!.deliveryId))!;
  assert.equal(original.state, "dispatching");
  const restarted = new AgentRequestStore(after.persistence);
  const options = { ...after.options, store: restarted, refreshEndpoints: async () => { throw new Error("original incarnation revoked"); } };
  await assert.rejects(() => new EndpointDeliveryRecovery(options).recover(original.deliveryId), /original incarnation revoked/);
  assert.equal(restarted.getEndpointDelivery(original.deliveryId)?.state, "dispatching");
  assert.equal(after.dispatched(), 1);
});

test("source qualification is rechecked after target lookup while target loading is not an ingress requirement", async () => {
  const f = fixture();
  let sourceLoaded = true;
  const roles: string[] = [];
  f.options.authorize = (_endpoint, role) => {
    roles.push(role || "missing");
    if (role === "source" && !sourceLoaded) throw new Error("source owner is no longer loaded");
  };
  f.options.resolveTarget = async () => { await Promise.resolve(); sourceLoaded = false; return party("b"); };
  await assert.rejects(() => executeEndpointAgentDelivery(f.request, f.options), /source owner is no longer loaded/);
  assert.equal(f.store.list().length, 0);
  assert.equal(f.dispatched(), 0);
  sourceLoaded = true;
  f.options.resolveTarget = () => party("b");
  const result = await executeEndpointAgentDelivery(f.request, f.options);
  assert.equal(result.statusCode, 200);
  assert.equal(roles.includes("target"), true);
  assert.equal(roles.includes("missing"), false);
});

test("pre-send verification failure leaves the delivery prepared and the same deliveryId really sends on retry", async () => {
  const f = fixture();
  let refreshes = 0;
  let failing = true;
  f.options.refreshEndpoints = async () => { if (++refreshes === 2 && failing) throw new EndpointVerificationError("source", new Error("GROK_BOT_HTTP_FAILED:429 (GetGrokBotAgent)")); };
  const request = { ...f.request, deliveryId: "caller-verify-first" };
  const first = await executeEndpointAgentDelivery(request, f.options);
  assert.equal(first.statusCode, 503);
  assert.equal(f.dispatched(), 0);
  const error = first.data.error as { stage: string; retryable: boolean; message: string };
  assert.equal(error.stage, "source_verification");
  assert.equal(error.retryable, true);
  assert.equal((first.data.delivery as { status: string; retryable: boolean }).retryable, true);
  const original = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  assert.equal(original.state, "prepared");
  failing = false;
  const retried = await executeEndpointAgentDelivery(request, f.options);
  assert.equal(retried.statusCode, 200);
  assert.equal(f.dispatched(), 1);
  assert.equal((retried.data.delivery as { deliveryId: string }).deliveryId, original.deliveryId);
  assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "committed");
});

test("target authorization failure before send reports target_verification", async () => {
  const f = fixture();
  let calls = 0;
  f.options.authorize = (_endpoint, role) => { if (role === "target" && ++calls === 3) throw new Error("target owner unloaded"); };
  const outcome = await executeEndpointAgentDelivery({ ...f.request, deliveryId: "caller-target" }, f.options);
  assert.equal(f.dispatched(), 0);
  assert.equal((outcome.data.error as { stage: string }).stage, "target_verification");
  assert.equal((await f.store.listEndpointDeliveries())[0].state, "prepared");
});

test("an unmodified generated remote reply template resolves the original provider through the real Manager resolver", async () => {
  for (const provider of ["codex", "dsh"] as const) {
    const source = { ...party("a"), agentAdapter: provider, endpoint: { ...endpoint("a"), provider, instanceId: "node-a" } };
    const reply = agentReplyRequest({ source, target: party("b"), requestId: "original-request" }) as AgentThreadRequest;
    const context = {
      store: new AgentRequestStore(new Memory()), registry: { localInstanceId: "manager", getInstanceAgent: () => ({ provider, name: "Original owner" }) },
      authority: { getNodeAuthorization: () => ({ incarnation: "lease" }) }, config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "policy" }) },
      receiptDirectory: "unused-fixture-receipts", localOptions: () => ({}), readLocal: async () => { throw new Error("must not substitute a local task"); }
    } as unknown as AgentEndpointDeliveryContext;
    const target = await createAgentEndpointDelivery(context).options().resolveTarget(reply);
    assert.equal(reply.agentAdapter, provider);
    assert.equal(target.endpoint?.provider, provider);
    assert.equal(target.endpoint?.nodeId, source.endpoint.nodeId);
    assert.equal(target.threadId, source.threadId);
  }
});

test("prepared formal replies preserve their ID and payload across concurrency, restart and completed retries", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const reply = { ...agentReplyRequest({ source: original.source, target: original.target, requestId: original.id }),
    result: "Exact evidence", nextAction: "Continue original task", prompt: "Additional details" } as AgentThreadRequest;
  let refreshes = 0;
  const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"),
    refreshEndpoints: async () => { if (++refreshes === 2) throw new EndpointVerificationError("source", new Error("transient qualification failure")); } };
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 503);
  const deliveryId = f.store.get(original.id)!.pendingResponseDeliveryId!;
  const frozen = (await f.store.readEndpointDelivery(deliveryId))!;
  assert.equal(frozen.state, "prepared");
  assert.equal(frozen.lastError?.message, "transient qualification failure");
  assert.equal(frozen.blockedReason, undefined);
  assert.match(frozen.requestHash!, /^[a-f0-9]{64}$/);
  for (const changed of [{ prompt: "Different details" }, { result: "Different result" }, { nextAction: "Different action" },
    { responsePolicy: "required" as const, responseInstruction: "Return again" }, { contextBlocks: ["New context"] }, { model: "different-model" }]) {
    await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, ...changed }, options), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  }
  assert.equal(f.dispatched(), 1);
  const restarted = new AgentRequestStore(f.persistence);
  const restored = { ...options, store: restarted, resolveExecutionOptions: () => { throw new Error("retry must retain frozen options"); } };
  const outcomes = await Promise.all([executeEndpointAgentDelivery(reply, restored), executeEndpointAgentDelivery(reply, restored)]);
  assert.ok(outcomes.every(value => value.statusCode === 200));
  assert.equal(restarted.get(original.id)?.status, "responded");
  assert.equal(f.dispatched(), 2);
  assert.equal((await restarted.readEndpointDelivery(deliveryId))?.prompt, frozen.prompt);
  assert.equal(restarted.getEndpointDelivery(deliveryId)?.generation, frozen.generation);
  assert.equal((await executeEndpointAgentDelivery(reply, restored)).statusCode, 200);
  await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, result: "Changed completed result" }, restored), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal(f.dispatched(), 2);
});

test("legacy prepared replies can prove their frozen payload without a semantic hash or current template metadata", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const reply = { ...agentReplyRequest({ source: original.source, target: original.target, requestId: original.id }), result: "Verified", nextAction: "Continue",
    responsePolicy: "required", responseInstruction: "Return follow-up evidence", prompt: "Legacy evidence", contextBlocks: ["Original context"] } as AgentThreadRequest;
  let refreshes = 0;
  const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"),
    refreshEndpoints: async () => { if (++refreshes === 2) throw new EndpointVerificationError("target", new Error("owner unavailable")); } };
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 503);
  const deliveryId = f.store.get(original.id)!.pendingResponseDeliveryId!;
  assert.equal(f.store.getEndpointDelivery(deliveryId)?.lastError?.message, "owner unavailable");
  const persisted = f.persistence.value as { deliveries: Record<string, PreparedEndpointDelivery> };
  const legacy = persisted.deliveries[deliveryId];
  delete legacy.requestHash;
  const footerAt = legacy.prompt.lastIndexOf("[回传参数]\n");
  const parameters = JSON.parse(legacy.prompt.slice(footerAt + "[回传参数]\n".length));
  delete parameters.request.agentAdapter;
  legacy.prompt = legacy.prompt.slice(0, footerAt) + "[回传参数]\n" + JSON.stringify(parameters, null, 2);
  legacy.promptHash = (await import("./store.js")).agentDeliveryPromptHash(legacy.prompt);
  const frozenPrompt = legacy.prompt;
  const store = new AgentRequestStore(f.persistence);
  const restored = { ...options, store, resolveExecutionOptions: () => { throw new Error("legacy retry must retain its execution snapshot"); } };
  await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, result: "Changed legacy result" }, restored), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal((await executeEndpointAgentDelivery(reply, restored)).statusCode, 200);
  assert.equal((await store.readEndpointDelivery(deliveryId))?.prompt, frozenPrompt);
  assert.equal(store.get(original.id)?.status, "responded");
  assert.equal(f.dispatched(), 2);
});

test("formal reply retries reconcile dispatching evidence without resending or replacing a changed payload", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const reply = { ...agentReplyRequest({ source: original.source, target: original.target, requestId: original.id }), result: "Verified", nextAction: "Continue", prompt: "Exact reply" } as AgentThreadRequest;
  let reconciliations = 0;
  const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"),
    dispatch: async delivery => { await f.options.dispatch(delivery, () => {}); throw new Error("acceptance ACK lost"); },
    reconcile: async () => { reconciliations++; return undefined; } };
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  const deliveryId = f.store.get(original.id)!.pendingResponseDeliveryId!;
  assert.equal(f.store.getEndpointDelivery(deliveryId)?.lastError?.message, "acceptance ACK lost");
  options.store = new AgentRequestStore(f.persistence);
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  assert.equal(options.store.getEndpointDelivery(deliveryId)?.state, "dispatching");
  assert.equal(f.dispatched(), 2);
  assert.equal(reconciliations, 1);
  await assert.rejects(() => executeEndpointAgentDelivery({ ...reply, prompt: "Different" }, options), { code: "AGENT_DELIVERY_ID_CONFLICT" });
  assert.equal(reconciliations, 1);
  options.reconcile = f.options.reconcile;
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 200);
  assert.equal(f.dispatched(), 2);
  assert.equal(options.store.get(original.id)?.status, "responded");
});

test("exact target reconnect events resume prepared snapshots once and never revive cancelled replies", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
    const original = f.store.list()[0];
    const reply = { ...agentReplyRequest({ source: original.source, target: original.target, requestId: original.id }), result: "Verified", nextAction: "Continue", prompt: "Exact reply" } as AgentThreadRequest;
    let refreshes = 0;
    const options: EndpointDeliveryOptions = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"),
      refreshEndpoints: async () => { if (++refreshes === 2) throw new EndpointVerificationError("source", new Error("temporarily unloaded")); } };
    assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 503);
    const deliveryId = f.store.get(original.id)!.pendingResponseDeliveryId!;
    if (cancelled) await f.store.cancel(original.id, "fixture cancellation");
    const store = new AgentRequestStore(f.persistence);
    const recovery = new EndpointDeliveryRecovery({ ...options, store });
    const target = store.getEndpointDelivery(deliveryId)!.target;
    await Promise.all([recovery.onEvent(target), recovery.onEvent(target)]);
    assert.equal(f.dispatched(), cancelled ? 1 : 2);
    assert.equal(store.getEndpointDelivery(deliveryId)?.state, cancelled ? "cancelled" : "committed");
    if (cancelled) await assert.rejects(() => recovery.recover(deliveryId), /cancelled/);
  }
});

test("a failed attempt-error persistence propagates while retaining the original prepared reservation", async () => {
  const f = fixture();
  let refreshes = 0;
  f.options.refreshEndpoints = async () => {
    if (++refreshes === 2) { f.persistence.fail = true; throw new EndpointVerificationError("source", new Error("preflight unavailable")); }
  };
  await assert.rejects(() => executeEndpointAgentDelivery({ ...f.request, deliveryId: "error-persistence" }, f.options), /disk unavailable/);
  assert.equal(f.dispatched(), 0);
  const delivery = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
  assert.equal(delivery.state, "prepared");
  assert.equal(delivery.lastError, undefined);
  f.persistence.fail = false;
  const restarted = new AgentRequestStore(f.persistence);
  const recovery = new EndpointDeliveryRecovery({ ...f.options, store: restarted });
  assert.equal(await recovery.recover(delivery.deliveryId), true);
  assert.equal(f.dispatched(), 1);
});

test("only positive no-frame proof restores a dispatch reservation to prepared for automatic same-ID recovery", async () => {
  for (const provenUnsent of [true, false]) {
    const f = fixture(); let unavailable = true;
    const options: EndpointDeliveryOptions = { ...f.options, dispatch: async (delivery, guard) => {
      if (unavailable) {
        const failure = new Error("connection lost between preflight and dispatch");
        throw provenUnsent ? new EndpointDeliveryNotSentError(failure) : failure;
      }
      return f.options.dispatch(delivery, guard);
    } };
    const first = await executeEndpointAgentDelivery({ ...f.request, deliveryId: "original-operation" }, options);
    const original = (await f.store.readEndpointDelivery(((await f.store.listEndpointDeliveries())[0])!.deliveryId))!;
    assert.equal(first.statusCode, provenUnsent ? 503 : 202);
    assert.equal(original.state, provenUnsent ? "prepared" : "dispatching");
    assert.equal((first.data.error as { stage: string }).stage, provenUnsent ? "target_verification" : "target_delivery");
    unavailable = false;
    const store = new AgentRequestStore(f.persistence);
    await new EndpointDeliveryRecovery({ ...options, store }).onEvent(original.target);
    assert.equal(f.dispatched(), provenUnsent ? 1 : 0);
    assert.equal(store.getEndpointDelivery(original.deliveryId)?.state, provenUnsent ? "committed" : "dispatching");
  }
});
