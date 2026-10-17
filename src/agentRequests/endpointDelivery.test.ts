import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRequestStore, type AgentRequestPersistence } from "./store.js";
import type { AgentRequestEndpoint } from "./endpoint.js";
import { executeEndpointAgentDelivery, EndpointDeliveryRecovery, EndpointVerificationError, sourceScopedAgentDeliveryId, type EndpointDeliveryOptions, type EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { executePreparedEndpointDelivery } from "./endpointExecution.js";
import { EndpointTransportReceipts } from "./endpointTransportReceipts.js";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, resolveEndpointExecutionOptions } from "./executionOptions.js";
import { normalizeAgentRequestEndpoint } from "./endpoint.js";
import { agentReplyRequest } from "./replyParameters.js";

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
  assert.equal(f.store.listEndpointDeliveries().length, 2);
});

test("orphaned stable reservation cannot create a replacement after restart, while an undispatched prepared snapshot can complete once", async () => {
  const orphan = fixture();
  const callerDeliveryId = "orphan-operation";
  const deliveryId = sourceScopedAgentDeliveryId(endpoint("a"), callerDeliveryId);
  orphan.store.prepare({ deliveryId, source: party("a"), target: party("b"), responsePolicy: "required", responseInstruction: "Return evidence" });
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
  unknown.store.cancel(unknown.store.list()[0].id);
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
  assert.equal(f.store.listEndpointDeliveries()[0].executionOptions.model, "managed-model-original");
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
  const delivery = f.store.listEndpointDeliveries()[0];
  const persisted = structuredClone(f.persistence.value) as { deliveries: Record<string, typeof delivery> };
  persisted.deliveries[delivery.deliveryId].promptHash = "malformed";
  f.persistence.value = persisted;
  const restarted = new AgentRequestStore(f.persistence);
  assert.equal(restarted.listEndpointDeliveries().length, 0);
  await assert.rejects(() => executeEndpointAgentDelivery(request, { ...f.options, store: restarted }), { code: "AGENT_DELIVERY_RESERVATION_EXISTS" });
  // An unrelated legitimate write must not erase the rejected original ID on the next restart.
  restarted.prepare({ source: party("c"), target: party("b"), responsePolicy: "required", responseInstruction: "Return evidence" });
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
    const delivery = f.store.listEndpointDeliveries().at(-1)!;
    assert.equal(delivery.preparation.target.agentType, originalRole);
    assert.deepEqual(delivery.target, original.source.endpoint);
    assert.deepEqual(delivery.source, original.target.endpoint);
  }
});

test("unknown reply is reserved durably and event recovery does not redispatch", async () => {
  const f = fixture();
  await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0];
  const options = { ...f.options, resolveSource: () => party("b"), resolveTarget: () => party("a"), dispatch: async (delivery: Parameters<EndpointDeliveryOptions["dispatch"]>[0]) => {
    const receipt = await f.options.dispatch(delivery, () => {}); throw new Error("receipt lost");
  } };
  const reply = { ...f.request, sourceThreadId: party("b").threadId, threadId: party("a").threadId,
    messageSource: { ...f.request.messageSource, sessionId: party("b").threadId }, inReplyToRequestId: original.id, result: "verified", nextAction: "continue", responsePolicy: "none" as const };
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  options.store = new AgentRequestStore(f.persistence);
  assert.equal((await executeEndpointAgentDelivery(reply, options)).statusCode, 202);
  assert.equal(f.dispatched(), 2);
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
  f.store.cancel(original.id);
  assert.throws(() => f.store.assertEndpointDeliveryActive(original.deliveryId), /cancel/);
});

test("prepare persistence failure rolls back reply reservation and new record", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const original = f.store.list()[0]; f.persistence.fail = true;
  assert.throws(() => f.store.prepare({ source: party("b"), target: party("a"), responsePolicy: "required", responseInstruction: "reply",
    inReplyToRequestId: original.id, result: "ok", nextAction: "continue" }), /disk unavailable/);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.get(original.id)?.pendingResponseDeliveryId, undefined);
});

test("transport crash/timeout is durable unknown and never automatically replayed", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const delivery = f.store.listEndpointDeliveries()[0];
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
  const delivery = f.store.listEndpointDeliveries()[0];
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
  const delivery = f.store.listEndpointDeliveries()[0];
  assert.throws(() => f.store.abort(delivery.preparation), /cannot release/);
  assert.equal(f.store.get(delivery.preparation.requestId!)?.status, "awaiting_response");
});

test("failed cancellation restores request and endpoint state", async () => {
  const f = fixture(); await executeEndpointAgentDelivery(f.request, f.options);
  const record = f.store.list()[0]; f.persistence.fail = true;
  assert.throws(() => f.store.cancel(record.id), /disk unavailable/);
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
  const delivery = f.store.listEndpointDeliveries()[0];
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
  assert.equal(new AgentRequestStore(f.persistence).listEndpointDeliveries().length, 0);
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
  const delivery = store.listEndpointDeliveries()[0];
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
  const delivery = f.store.listEndpointDeliveries()[0];
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
  const delivery = f.store.listEndpointDeliveries()[0];
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
  assert.deepEqual(f.store.listEndpointDeliveries().at(-1)?.executionOptions, {});
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
  const original = after.store.listEndpointDeliveries()[0];
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
  const original = f.store.listEndpointDeliveries()[0];
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
  assert.equal(f.store.listEndpointDeliveries()[0].state, "prepared");
});
