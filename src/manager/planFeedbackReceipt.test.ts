import assert from "node:assert/strict";
import test from "node:test";
import { AgentRequestStore, type AgentRequestPersistence } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryOptions, type EndpointDeliveryReceipt, type PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import type { AgentRequestEndpoint, AgentConnectionSource } from "../agentRequests/endpoint.js";
import { inspectOriginalPlanFeedbackReceipt } from "./planFeedbackReceipt.js";

class Memory implements AgentRequestPersistence {
  value: unknown;
  read() { return this.value; }
  write(value: unknown) { this.value = structuredClone(value); }
}
const managerId = "stable-fixture-manager";
const callerId = "original-feedback-once";
const connection: AgentConnectionSource = { kind: "connection", transport: "local", managerInstanceId: managerId, id: managerId };
const endpoint = (instanceId: string): AgentRequestEndpoint => ({ kind: "instance", managerInstanceId: managerId, instanceId, nodeId: instanceId,
  agentId: "fixture-native", provider: "codex", sessionId: "same-original-session", authorizationIncarnation: "original-epoch" });

async function fixture(state: "committed" | "prepared" | "dispatching" = "committed") {
  const persistence = new Memory(), store = new AgentRequestStore(persistence);
  let sends = 0;
  const originalTarget = endpoint("computer-a");
  const options: EndpointDeliveryOptions = { store, managerInstanceId: managerId,
    resolveSource: () => ({ connection, threadId: "", agentType: "plan_agent" }),
    resolveTarget: () => ({ endpoint: originalTarget, threadId: originalTarget.sessionId, agentAdapter: "codex", agentType: "agent", workspace: "F:/Fixture/OriginalProject" }),
    resolveExecutionOptions: () => ({ cwd: "F:/Fixture/OriginalProject" }), authorize: () => {},
    refreshEndpoints: async (_identities, phase) => { if (state === "prepared" && phase === "dispatch") throw new Error("Original owner unavailable before send"); },
    dispatch: async delivery => {
      sends++;
      if (state === "dispatching") throw new Error("Original dispatch acknowledgement lost");
      const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation, promptHash: delivery.promptHash,
        executionOptionsHash: delivery.executionOptionsHash, endpoint: delivery.target, accepted: true, action: "received", transport: "fixture" };
      return receipt;
    }, reconcile: async () => undefined };
  const response = await executeEndpointAgentDelivery({ action: "send", agentAdapter: "codex", threadId: originalTarget.sessionId,
    deliveryId: callerId, responsePolicy: "none", cwd: "F:/Fixture/OriginalProject", prompt: "Apply this already-authorized original fixture feedback" }, options);
  assert.equal(response.statusCode, state === "committed" ? 200 : state === "prepared" ? 503 : 202);
  const original = await store.readCallerEndpointDelivery(connection, callerId);
  assert.ok(original);
  assert.equal(original.state, state);
  return { store, persistence, original, sends: () => sends };
}

test("a same-ID rebind to B still reads the accepted frozen A receipt after store restart without querying B", async t => {
  const f = await fixture();
  const restarted = new AgentRequestStore(f.persistence);
  t.after(async () => { await f.store.close(); await restarted.close(); });
  const rebound = { agentType: "codex", sessionId: endpoint("computer-b").sessionId, instanceBinding: { instanceId: "computer-b", agentId: "fixture-native" } };
  let currentBindingReads = 0;
  const inspect = async () => {
    const original = await inspectOriginalPlanFeedbackReceipt(restarted, managerId, callerId);
    if (original !== undefined) return original;
    currentBindingReads++;
    assert.equal(rebound.instanceBinding.instanceId, "computer-b");
    return "missing";
  };
  assert.equal(await inspect(), "accepted");
  assert.equal(currentBindingReads, 0);
  assert.equal(f.sends(), 1);
  const original = await restarted.readCallerEndpointDelivery(connection, callerId);
  assert.equal(original!.target.instanceId, "computer-a");
  assert.equal(original!.receipt!.endpoint.instanceId, "computer-a");
  assert.equal(original!.target.sessionId, rebound.sessionId);
});

for (const state of ["prepared", "dispatching"] as const) test(`an original ${state} receipt remains in progress and never probes or sends to rebound B`, async t => {
  const f = await fixture(state);
  t.after(() => f.store.close());
  let currentBindingReads = 0, replays = 0;
  const result = await inspectOriginalPlanFeedbackReceipt(f.store, managerId, callerId);
  if (result === undefined) { currentBindingReads++; replays++; }
  assert.equal(result, "in_progress");
  assert.equal(currentBindingReads, 0);
  assert.equal(replays, 0);
  assert.equal(f.sends(), state === "prepared" ? 0 : 1);
  assert.equal((await f.store.readCallerEndpointDelivery(connection, callerId))!.state, state);
});

test("the original caller lookup is scoped to the stable Manager local connection", async t => {
  const f = await fixture();
  t.after(() => f.store.close());
  assert.equal(await inspectOriginalPlanFeedbackReceipt(f.store, "different-manager", callerId), undefined);
  assert.equal(await inspectOriginalPlanFeedbackReceipt(f.store, managerId, "not-the-original-caller"), undefined);
  let query: { source: unknown; caller: string } | undefined;
  assert.equal(await inspectOriginalPlanFeedbackReceipt({ readCallerEndpointDelivery: async (source, caller) => { query = { source, caller }; return f.original; } }, managerId, callerId), "accepted");
  assert.deepEqual(query, { source: connection, caller: callerId });
  assert.equal(f.sends(), 1);
});

test("cancelled or incomplete original receipts cannot be treated as acceptance at the new binding", async t => {
  const f = await fixture();
  t.after(() => f.store.close());
  const variants: Array<{ name: string; original: PreparedEndpointDelivery }> = [
    { name: "cancelled", original: { ...f.original, state: "cancelled" } },
    { name: "receipt absent", original: { ...f.original, receipt: undefined } },
    ...(["deliveryId", "generation", "promptHash", "executionOptionsHash"] as const).map(key => ({ name: key,
      original: { ...f.original, receipt: { ...f.original.receipt!, [key]: "different-original-proof" } } })),
    { name: "different target", original: { ...f.original, receipt: { ...f.original.receipt!, endpoint: endpoint("computer-b") } } }
  ];
  for (const variant of variants) {
    let queries = 0;
    const store = { readCallerEndpointDelivery: async () => { queries++; return variant.original; } };
    await assert.rejects(inspectOriginalPlanFeedbackReceipt(store, managerId, callerId), /cancelled|incomplete/, variant.name);
    assert.equal(queries, 1);
  }
  assert.equal(f.sends(), 1);
});
