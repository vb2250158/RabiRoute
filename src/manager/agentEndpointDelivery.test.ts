import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext, type AgentServiceSourcePrincipal } from "./agentEndpointDelivery.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentThreadRequest } from "../agentThreads.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { executeEndpointAgentDelivery, type EndpointDeliveryReceipt, type PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";

test("factory accepts a source without cwd, freezes trusted device identity and confines cwd requirements to host targets", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-factory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let authorized = true;
  const deviceRoles: string[] = [];
  const device: AgentRequestEndpoint = { kind: "device", managerInstanceId: "manager", instanceId: "pc-owner", agentId: "glasses", provider: "deviceAgent", sessionId: "device-session", authorizationIncarnation: "epoch" };
  const deviceParty = { endpoint: device, threadId: device.sessionId, agentAdapter: "deviceAgent" as const, agentType: "agent" };
  const context = {
    store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: directory,
    readLocal: async (_provider: unknown, id: string) => ({ id, title: "Exact task", updatedAt: "", archived: false }),
    localOptions: () => ({ allowedWorkspaces: [] }),
    device: {
      resolveSource: async (request: AgentThreadRequest, principal?: { sourceDeviceId: string }) => {
        if (request.messageSource?.type !== "agent" || request.messageSource.agentAdapter !== "deviceAgent") return undefined;
        assert.equal(principal?.sourceDeviceId, "binding-original"); return deviceParty;
      },
      resolveTarget: async (request: AgentThreadRequest) => request.agentAdapter === "deviceAgent" ? deviceParty : undefined,
      authorize: (_endpoint: AgentRequestEndpoint, role?: "source" | "target") => { deviceRoles.push(role || "missing"); if (!authorized) throw new Error("revoked"); }, transport: async () => undefined
    }
  } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  const source: AgentThreadRequest = { action: "send", sourceThreadId: "source", sourceAgentType: "agent", agentAdapter: "deviceAgent", threadId: device.sessionId,
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source", sessionName: "Source" } };
  const options = factory.options();
  assert.equal((await options.resolveSource(source)).workspace, undefined);
  const target = await options.resolveTarget(source);
  assert.deepEqual(options.resolveExecutionOptions(source, target), {});
  await assert.rejects(async () => options.resolveTarget({ ...source, agentAdapter: "codex", threadId: "host-task" }), /existing absolute/);
  assert.throws(() => factory.options(undefined, undefined, { scope: "app", sourceDeviceId: "binding-original", deviceOwner: true }), /HTTP admission/);
  const principal = { scope: "app", sourceDeviceId: "binding-original", deviceOwner: true };
  const fromDevice = factory.options(undefined, () => { if (!authorized) throw new Error("revoked"); }, principal);
  principal.sourceDeviceId = "binding-replacement";
  assert.equal((await fromDevice.resolveSource({ ...source, sourceThreadId: device.sessionId,
    messageSource: { type: "agent", agentAdapter: "deviceAgent", sessionId: device.sessionId, sessionName: "Glasses" } })).endpoint?.kind, "device");
  await assert.rejects(async () => fromDevice.resolveSource(source), /source substitution is forbidden/);
  await factory.refreshEndpoints({ source: device, target: device });
  assert.deepEqual(deviceRoles.slice(-2), ["target", "source"]);
  authorized = false;
  assert.throws(() => fromDevice.authorize(device), /revoked/);
});

test("factory rejects missing source, unsupported system ownership and invalid source roles with explicit repair fields", async () => {
  let reads = 0;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: "unused-memory-receipts",
    readLocal: async (_provider: unknown, id: string) => { reads++; return { id, title: "Source", updatedAt: "", archived: false }; },
    localOptions: () => ({ allowedWorkspaces: [] }) } as unknown as AgentEndpointDeliveryContext;
  const options = createAgentEndpointDelivery(context).options();
  const system = { type: "system" as const, eventType: "test", eventName: "Test", eventId: "event" };
  await assert.rejects(async () => options.resolveSource({ sourceAgentType: "agent", messageSource: system }),
    { field: "sourceThreadId", stage: "source_verification" });
  await assert.rejects(async () => options.resolveSource({ sourceThreadId: "source", sourceAgentType: "agent", messageSource: system }),
    error => { assert.equal((error as { field: string }).field, "messageSource"); assert.match((error as { repair: string }).repair, /system/); return true; });
  await assert.rejects(async () => options.resolveSource({ sourceThreadId: "source", sourceAgentType: "system" as "agent",
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source", sessionName: "Source" } }), { field: "sourceAgentType" });
  assert.equal(reads, 0);
});

test("registered service bridge preserves its authenticated owner and delivers without PC directory requirements", async () => {
  const endpoint: AgentRequestEndpoint = { kind: "local", managerInstanceId: "manager", agentId: "cloud-owner", provider: "astrbot",
    sessionId: "cloud-session", authorizationIncarnation: "cloud-epoch" };
  const party = { endpoint, agentAdapter: "astrbot" as const, agentType: "agent", threadId: endpoint.sessionId, threadName: "Cloud task" };
  const roles: string[] = [];
  let transports = 0;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: "unused-service-receipts",
    readLocal: async () => { throw new Error("service must not read a Desktop owner"); }, localOptions: () => ({ allowedWorkspaces: [] }),
    service: { owns: (value: AgentRequestEndpoint) => value.provider === "astrbot" && value.agentId === endpoint.agentId,
      resolveSource: async (_request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal) => {
        assert.equal(principal?.agentId, "cloud-owner"); return party;
      }, resolveTarget: async () => party,
      authorize: (_value: AgentRequestEndpoint, role?: string) => { roles.push(role || "missing"); },
      refresh: async () => {}, resolveExecutionOptions: () => ({}), transport: async () => { transports++; return undefined; } }
  } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  const principal = { provider: "astrbot" as const, agentId: endpoint.agentId, sessionId: endpoint.sessionId, authorizationIncarnation: endpoint.authorizationIncarnation };
  assert.throws(() => factory.options(undefined, undefined, undefined, principal), /HTTP admission/);
  const callerExecutionOptions = { model: "original-explicit-model" };
  const options = factory.options(undefined, () => {}, undefined, principal, callerExecutionOptions);
  principal.agentId = "replacement";
  callerExecutionOptions.model = "replacement";
  assert.equal(options.callerExecutionOptions?.model, "original-explicit-model");
  assert.equal(Object.isFrozen(options.callerExecutionOptions), true);
  const request: AgentThreadRequest = { sourceThreadId: endpoint.sessionId, sourceAgentType: "agent", threadId: endpoint.sessionId,
    agentAdapter: "astrbot", messageSource: { type: "agent", agentAdapter: "astrbot", sessionName: "Cloud task", sessionId: endpoint.sessionId } };
  assert.equal((await options.resolveSource(request)).workspace, undefined);
  const target = await options.resolveTarget(request);
  assert.deepEqual(options.resolveExecutionOptions(request, target), {});
  await factory.refreshEndpoints({ source: endpoint, target: endpoint });
  assert.deepEqual(roles, ["target", "source"]);
  await options.dispatch({ target: endpoint } as Parameters<typeof options.dispatch>[0], () => {}).catch(error => assert.match(error.message, /No exact owner receipt/));
  assert.equal(transports, 1);
});

test("refresh visits each endpoint once and reuses a fresh Grok Bot source proof", async () => {
  const refreshed: string[] = [];
  const grok: AgentRequestEndpoint = { kind: "service", managerInstanceId: "manager", agentId: "grok-agent", provider: "grokBot", sessionId: "grok-session", authorizationIncarnation: "epoch" };
  const target: AgentRequestEndpoint = { kind: "service", managerInstanceId: "manager", agentId: "other-agent", provider: "grokBot", sessionId: "target-session", authorizationIncarnation: "epoch" };
  let fail = false;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: "unused-memory-receipts",
    readLocal: async () => { throw new Error("unused"); }, localOptions: () => ({ allowedWorkspaces: [] }),
    service: { owns: (endpoint: AgentRequestEndpoint) => endpoint.provider === "grokBot", authorize: () => {},
      refresh: async (endpoint: AgentRequestEndpoint, role?: string) => { refreshed.push(role + ":" + endpoint.sessionId); if (fail) throw new Error("GROK_BOT_HTTP_FAILED:429"); },
      resolveSource: async () => undefined, resolveTarget: async () => undefined, resolveExecutionOptions: () => ({}), transport: async () => undefined } } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  await factory.refreshEndpoints({ source: grok, target });
  assert.deepEqual(refreshed, ["target:target-session", "source:grok-session"]);
  await factory.refreshEndpoints({ source: grok, target });
  assert.deepEqual(refreshed.slice(2), ["target:target-session"]);
  fail = true;
  await assert.rejects(() => factory.refreshEndpoints({ source: target, target: grok }), (error: { role?: string }) => error.role === "target");
});

function remoteDeliveryFixture(initial: "offline" | "disconnect-before-frame" | "timeout-after-frame" | "unproven-not-sent" | "accepted-before-disconnect") {
  let connected = initial !== "offline";
  let failure: string | undefined = initial === "offline" ? undefined : initial;
  let persisted: unknown;
  const store = new AgentRequestStore({ read: () => persisted, write: value => { persisted = structuredClone(value); } });
  const calls: Array<{ operation: string; deliveryId: string }> = [];
  const ownerReceipts = new Map<string, EndpointDeliveryReceipt>();
  let sentFrames = 0;
  const connectionListeners: Array<() => Promise<void>> = [];
  const registry = {
    localInstanceId: "manager",
    listNodes: () => [{ nodeId: "source-node", connected: true }, { nodeId: "target-node", connected }],
    getInstanceAgent: () => ({ provider: "dsh", name: "Exact remote owner", workspace: "C:/fixture" }),
    onDeliveryRecoveryEvent: (listener: () => Promise<void>) => { connectionListeners.push(listener); },
    manageAgent: async (_instanceId: string, operation: string, parameters: { delivery: PreparedEndpointDelivery }, _timeout: number, assertAuthorized: () => void) => {
      assertAuthorized(); const delivery = parameters.delivery;
      calls.push({ operation, deliveryId: delivery.deliveryId });
      if (operation === "reconcile_prepared_delivery") return ownerReceipts.get(delivery.deliveryId);
      assert.equal(operation, "prepared_delivery");
      if (failure === "disconnect-before-frame") {
        connected = false;
        throw Object.assign(new Error("Original connection disappeared before management send"), { code: "LAN_AGENT_MANAGEMENT_NOT_SENT", deliveryFrameSent: false });
      }
      sentFrames++;
      if (failure === "timeout-after-frame") throw new Error("Management timed out after sending the original frame");
      if (failure === "unproven-not-sent") throw Object.assign(new Error("No positive frame proof"), { code: "LAN_AGENT_MANAGEMENT_NOT_SENT" });
      const receipt: EndpointDeliveryReceipt = { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target,
        promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true, action: "started", transport: "fixture-owner" };
      ownerReceipts.set(delivery.deliveryId, receipt);
      if (failure === "accepted-before-disconnect") connected = false;
      return receipt;
    }
  };
  const context = { store, registry, authority: { getNodeAuthorization: () => ({ incarnation: "original-node-lease" }) },
    config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "original-policy" }) }, receiptDirectory: "unused-factory-race-receipts",
    readLocal: async () => { throw new Error("Must not substitute a local owner"); }, localOptions: () => ({}) } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  registry.onDeliveryRecoveryEvent(() => factory.recovery.onEvent(connected ? store.listEndpointDeliveryMetadata()[0]?.target : undefined));
  const options = factory.options({ nodeId: "source-node", agentId: "source-backend", sessionId: "source-session", sessionName: "Original source", provider: "dsh" }, () => {});
  const request: AgentThreadRequest = { action: "send", sourceThreadId: "source-session", sourceAgentType: "agent", threadId: "target-session",
    agentAdapter: "dsh", instanceBinding: { instanceId: "target-node", agentId: "target-backend" }, deliveryId: "original-durable-intent",
    responsePolicy: "none", prompt: "Exact fixture payload", messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "source-session", sessionName: "Original source" } };
  return { factory, options, request, store, calls, sentFrames: () => sentFrames,
    reconnect: async () => { connected = true; failure = undefined; await Promise.all(connectionListeners.map(listener => listener())); },
    notifyConnection: async () => { await Promise.all(connectionListeners.map(listener => listener())); } };
}

test("an initially offline remote target is durably prepared through the factory without invoking management transport", async () => {
  const f = remoteDeliveryFixture("offline");
  const outcome = await executeEndpointAgentDelivery(f.request, f.options);
  assert.equal(outcome.statusCode, 503);
  assert.equal((outcome.data.error as { stage: string }).stage, "target_verification");
  const original = (await f.store.listEndpointDeliveries())[0];
  assert.equal(original.state, "prepared");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sentFrames(), 0);
  await Promise.all([f.reconnect(), f.notifyConnection()]);
  const recovered = (await f.store.readEndpointDelivery(original.deliveryId))!;
  assert.equal(recovered.state, "committed");
  assert.equal(recovered.generation, original.generation);
  assert.equal(recovered.prompt, original.prompt);
  assert.equal(f.sentFrames(), 1);
  assert.deepEqual(f.calls, [{ operation: "prepared_delivery", deliveryId: original.deliveryId }]);
});

test("a proven disconnect after remote preflight returns the original factory delivery to prepared and reconnect resumes it once", async () => {
  const f = remoteDeliveryFixture("disconnect-before-frame");
  const outcome = await executeEndpointAgentDelivery(f.request, f.options);
  assert.equal(outcome.statusCode, 503);
  assert.equal((outcome.data.error as { stage: string }).stage, "target_verification");
  const original = (await f.store.listEndpointDeliveries())[0];
  assert.equal(original.state, "prepared");
  assert.equal(f.calls.length, 1);
  assert.equal(f.sentFrames(), 0);
  await Promise.all([f.reconnect(), f.notifyConnection()]);
  const recovered = (await f.store.readEndpointDelivery(original.deliveryId))!;
  assert.equal(recovered.state, "committed");
  assert.equal(recovered.generation, original.generation);
  assert.equal(recovered.promptHash, original.promptHash);
  assert.equal(f.sentFrames(), 1);
  assert.deepEqual(f.calls.map(call => call.deliveryId), [original.deliveryId, original.deliveryId]);
  assert.equal((await executeEndpointAgentDelivery(f.request, f.options)).statusCode, 200);
  assert.equal(f.sentFrames(), 1);
});

test("factory timeouts and unproven no-send claims remain dispatching and reconnect never replays the frame", async () => {
  for (const failure of ["timeout-after-frame", "unproven-not-sent"] as const) {
    const f = remoteDeliveryFixture(failure);
    assert.equal((await executeEndpointAgentDelivery(f.request, f.options)).statusCode, 202);
    const original = (await f.store.listEndpointDeliveries())[0];
    assert.equal(original.state, "dispatching");
    assert.equal(f.sentFrames(), 1);
    await f.reconnect(); await f.notifyConnection();
    assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "dispatching");
    assert.equal(f.sentFrames(), 1);
    assert.deepEqual(f.calls.map(call => call.operation), ["prepared_delivery", "reconcile_prepared_delivery", "reconcile_prepared_delivery"]);
    assert.ok(f.calls.every(call => call.deliveryId === original.deliveryId));
  }
});

test("a remote disconnect after owner acceptance stays uncertain and reconnect recovers its receipt without a second send", async () => {
  const f = remoteDeliveryFixture("accepted-before-disconnect");
  assert.equal((await executeEndpointAgentDelivery(f.request, f.options)).statusCode, 202);
  const original = (await f.store.listEndpointDeliveries())[0];
  assert.equal(original.state, "dispatching");
  assert.equal(f.sentFrames(), 1);
  await f.reconnect();
  assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "committed");
  assert.equal(f.sentFrames(), 1);
  assert.deepEqual(f.calls.map(call => call.operation), ["prepared_delivery", "reconcile_prepared_delivery"]);
});
