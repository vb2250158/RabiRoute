import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext, type AgentServiceSourcePrincipal } from "./agentEndpointDelivery.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentThreadRequest } from "../agentThreads.js";
import { agentReplyParameters } from "../agentRequests/replyParameters.js";
import { sourceScopedAgentDeliveryId, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
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
  assert.equal((await fromDevice.resolveSource(source)).threadId, "source");
  await factory.refreshEndpoints({ source: device, target: device });
  assert.deepEqual(deviceRoles, ["target"]);
  authorized = false;
  assert.throws(() => fromDevice.authorize(device), /revoked/);
});

test("source descriptions do not read a local task or require a registered role", async () => {
  let reads = 0;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager" }, authority: {}, config: {}, receiptDirectory: "unused-memory-receipts",
    readLocal: async () => { reads++; throw new Error("Source metadata owner is archived or unavailable"); },
    localOptions: () => { throw new Error("Source options must not read the host"); } } as unknown as AgentEndpointDeliveryContext;
  const options = createAgentEndpointDelivery(context).options();
  for (const sourceAgentType of [undefined, "system", "custom_connected_agent"]) {
    const source = await options.resolveSource({ sourceThreadId: "source", sourceAgentType,
      messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source", sessionName: "" } });
    assert.equal(source.threadId, "source");
    assert.equal(source.agentType, sourceAgentType || "agent");
    assert.equal(source.workspace, undefined);
  }
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
  assert.deepEqual(roles, ["target"]);
  await options.dispatch({ target: endpoint } as Parameters<typeof options.dispatch>[0], () => {}).catch(error => assert.match(error.message, /No exact owner receipt/));
  assert.equal(transports, 1);
});

test("refresh reads only the target and never a Grok source proof", async () => {
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
  assert.deepEqual(refreshed, ["target:target-session"]);
  await factory.refreshEndpoints({ source: grok, target });
  assert.deepEqual(refreshed, ["target:target-session", "target:target-session"]);
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
  let receiptPending = false;
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
      if (operation === "reconcile_prepared_delivery") return receiptPending
        ? { status: "in_progress", deliveryId: delivery.deliveryId, generation: delivery.generation }
        : ownerReceipts.get(delivery.deliveryId);
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
  const options = factory.options({ nodeId: "source-node", agentId: "source-backend", sessionId: "source-session", sessionName: "Original source", provider: "dsh", authorizationIncarnation: "captured-original-source-incarnation" }, () => {});
  const request: AgentThreadRequest = { action: "send", sourceThreadId: "source-session", sourceAgentType: "agent", threadId: "target-session",
    agentAdapter: "dsh", instanceBinding: { instanceId: "target-node", agentId: "target-backend" }, deliveryId: "original-durable-intent",
    responsePolicy: "none", prompt: "Exact fixture payload", messageSource: { type: "agent", agentAdapter: "dsh", sessionId: "source-session", sessionName: "Original source" } };
  return { factory, options, request, store, calls, sentFrames: () => sentFrames,
    setReceiptPending: () => { receiptPending = true; },
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

test("a still-running connector receipt owner returns uncertainty without a receipt-validation error or a new send", async () => {
  const f = remoteDeliveryFixture("timeout-after-frame");
  assert.equal((await executeEndpointAgentDelivery(f.request, f.options)).statusCode, 202);
  const original = (await f.store.listEndpointDeliveries())[0];
  f.setReceiptPending();
  assert.equal(await f.factory.recovery.recover(original.deliveryId), false);
  assert.equal(f.store.getEndpointDelivery(original.deliveryId)?.state, "dispatching");
  assert.equal(f.sentFrames(), 1);
  assert.deepEqual(f.calls.map(call => call.operation), ["prepared_delivery", "reconcile_prepared_delivery"]);
});


test("ingress source snapshot skips catalog, lease and source policy lookups", async () => {
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", getInstanceAgent: () => { throw new Error("Source catalog unavailable"); } },
    authority: { getNodeAuthorization: () => { throw new Error("Source lease must not be read again"); } },
    config: { getLanAgentDeliveryPolicy: () => { throw new Error("Source policy must not be read again"); } },
    receiptDirectory: "unused-ingress-source-receipts", readLocal: async () => { throw new Error("Source task must not be read"); },
    localOptions: () => ({}) } as unknown as AgentEndpointDeliveryContext;
  const principal = { nodeId: "connected-computer", agentId: "existing-agent", provider: "dsh" as const,
    sessionId: "existing-original-task", sessionName: "", authorizationIncarnation: "existing-ingress-incarnation" };
  const options = createAgentEndpointDelivery(context).options(principal, () => {});
  principal.sessionId = "changed-after-admission";
  const source = await options.resolveSource({ action: "send" });
  assert.equal(source.threadId, "existing-original-task");
  assert.equal(source.endpoint?.authorizationIncarnation, "existing-ingress-incarnation");
  assert.equal(source.workspace, undefined);
});


test("formal replies resolve their real service target from original coordinates without qualifying the delegate", async () => {
  const store = new AgentRequestStore({ read: () => undefined, write: () => {} });
  const sourceEndpoint: AgentRequestEndpoint = { kind: "service", managerInstanceId: "manager", agentId: "native-bot",
    provider: "grokBot", sessionId: "original-service-session", authorizationIncarnation: "source-attribution" };
  const originalSource = { endpoint: sourceEndpoint, threadId: sourceEndpoint.sessionId, agentAdapter: "grokBot" as const, agentType: "agent" };
  const original = await store.prepare({ source: originalSource, target: { threadId: "initial-handler", agentType: "agent" },
    responsePolicy: "required", responseInstruction: "Reply to the service" });
  await store.commit(original);
  let targetReads = 0, sent = 0;
  const actualTarget = { ...originalSource, endpoint: { ...sourceEndpoint, authorizationIncarnation: "current-real-target-account" } };
  const context = { store, registry: { localInstanceId: "manager" }, authority: {}, config: {}, receiptDirectory: "unused-service-target-receipts",
    readLocal: async () => { throw new Error("Delegate source task must not be read"); }, localOptions: () => ({}),
    service: { owns: (endpoint: AgentRequestEndpoint) => endpoint.provider === "grokBot",
      resolveSource: async () => undefined,
      resolveTarget: async (request: AgentThreadRequest) => {
        targetReads++; assert.equal(request.threadId, sourceEndpoint.sessionId); assert.equal(request.agentAdapter, "grokBot");
        assert.equal(request.agentTargetId, "local:grokBot"); assert.equal(request.instanceBinding, undefined); return actualTarget;
      },
      authorize: (endpoint: AgentRequestEndpoint, role?: string) => {
        assert.equal(role, "target"); assert.equal(endpoint.authorizationIncarnation, "current-real-target-account");
      }, resolveExecutionOptions: () => ({}),
      transport: async (delivery: PreparedEndpointDelivery) => {
        sent++; return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target,
          promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash, accepted: true, action: "started", transport: "test-service" };
      } }
  } as unknown as AgentEndpointDeliveryContext;
  const options = createAgentEndpointDelivery(context).options();
  const response = await executeEndpointAgentDelivery({ action: "send", sourceThreadId: "actual-delegate",
    sourceAgentType: "connected_delegate", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "actual-delegate", sessionName: "Delegate" },
    agentAdapter: "grokBot", threadId: sourceEndpoint.sessionId, inReplyToRequestId: original.requestId,
    prompt: "Service reply", result: "Verified", nextAction: "Continue", responsePolicy: "none" }, options);
  assert.equal(response.statusCode, 200); assert.equal(targetReads, 1); assert.equal(sent, 1);
  assert.equal(store.get(original.requestId!)?.response?.by.threadId, "actual-delegate");
  assert.equal(store.listEndpointDeliveryMetadata()[0]!.target.authorizationIncarnation, "current-real-target-account");
});


test("body source coordinates without SDK headers stay scoped to each authenticated connector", async()=>{
  const context={store:new AgentRequestStore({read:()=>undefined,write:()=>{}}),registry:{localInstanceId:"manager"},authority:{},config:{},
    receiptDirectory:"unused-connection-source",readLocal:async()=>{throw new Error("No source owner reads");},localOptions:()=>{throw new Error("No source host options");}} as unknown as AgentEndpointDeliveryContext;
  const factory=createAgentEndpointDelivery(context);
  const body={action:"send",sourceThreadId:"same-source",messageSource:{type:"agent",agentAdapter:"codex",sessionId:"same-source"}} as AgentThreadRequest;
  const a=await factory.options({nodeId:"node-a",authorizationIncarnation:"connection-a"},()=>{}).resolveSource(body);
  const b=await factory.options({nodeId:"node-b",authorizationIncarnation:"connection-b"},()=>{}).resolveSource(body);
  assert.equal(a.endpoint?.kind,"instance");assert.equal(a.endpoint?.nodeId,"node-a");assert.equal(b.endpoint?.nodeId,"node-b");
  assert.equal(a.agentAdapter,"codex");assert.equal(a.threadId,"same-source");assert.equal(a.threadName,"same-source");
  assert.notEqual(sourceScopedAgentDeliveryId(a.endpoint!,"same-caller"),sourceScopedAgentDeliveryId(b.endpoint!,"same-caller"));
});

test("a sessionless caller records its real connection without inventing a task or reading an owner",async()=>{
  const unused=async()=>{throw new Error("No source owner resolution");};
  const context={store:new AgentRequestStore({read:()=>undefined,write:()=>{}}),registry:{localInstanceId:"manager"},authority:{},config:{},
    receiptDirectory:"unused-connection-source",readLocal:unused,localOptions:()=>{throw new Error("No source host options");},
    device:{resolveSource:unused},service:{resolveSource:unused},peer:{resolveSource:unused}} as unknown as AgentEndpointDeliveryContext;
  const factory=createAgentEndpointDelivery(context);
  const cases=[
    {options:factory.options({nodeId:"node-a",authorizationIncarnation:"connection-a"},()=>{}),transport:"lan-agent",id:"node-a"},
    {options:factory.options({nodeId:"node-b",authorizationIncarnation:"connection-b"},()=>{}),transport:"lan-agent",id:"node-b"},
    {options:factory.options(undefined,()=>{},{scope:"scope",sourceDeviceId:"pc-b",deviceOwner:true}),transport:"rabilink",id:"pc-b"},
    {options:factory.options(undefined,()=>{},undefined,{provider:"astrbot",agentId:"service-a",sessionId:"",authorizationIncarnation:"service-connection"}),transport:"service",id:"service-a"}
  ];
  for(const item of cases){const source=await item.options.resolveSource({action:"send"});
    assert.equal(source.threadId,"");assert.equal(source.endpoint,undefined);assert.equal(source.agentAdapter,undefined);
    assert.equal(source.connection?.kind,"connection");assert.equal(source.connection?.managerInstanceId,"manager");
    assert.equal(source.connection?.transport,item.transport);assert.equal(source.connection?.id,item.id);
  }
  const local=await factory.options().resolveSource({action:"send"});
  assert.deepEqual(local,{threadId:"",agentType:"agent",connection:{kind:"connection",managerInstanceId:"manager",transport:"local",id:"manager"}});
});


test("a source-free Peer delivery carries the original ledger address in its formal reply parameters",async()=>{
  const context={store:new AgentRequestStore({read:()=>undefined,write:()=>{}}),registry:{localInstanceId:"manager-a"},authority:{},config:{},
    receiptDirectory:"unused-connection-ledger",readLocal:async()=>{throw new Error("No source owner reads");},localOptions:()=>{throw new Error("No source host options");},
    peer:{localDeviceId:()=>"pc-a",resolveSource:async()=>{throw new Error("No source task resolver");}}} as unknown as AgentEndpointDeliveryContext;
  const source=await createAgentEndpointDelivery(context).options().resolveSource({action:"send",instanceBinding:{ownerDeviceId:"pc-b",instanceId:"manager-b",agentId:"codex"}});
  assert.ok(source.connection);assert.equal(source.connection.ledgerOwnerDeviceId,"pc-a");
  const {ledgerOwnerDeviceId:_route,...identity}=source.connection;
  assert.equal(sourceScopedAgentDeliveryId(source.connection,"caller"),sourceScopedAgentDeliveryId(identity,"caller"));
  const parameters=agentReplyParameters({source,target:{threadId:"target-b",agentAdapter:"codex",agentType:"agent"},deliveryId:"original-delivery",
    requestId:"original-request",responsePolicy:"required",responseInstruction:"Record the result"});
  assert.ok(parameters.request && typeof parameters.request==="object");
  const reply=parameters.request as Record<string,unknown>;
  assert.equal(reply.action,"send");assert.equal(reply.inReplyToRequestId,"original-request");assert.equal(reply.ledgerOwnerDeviceId,"pc-a");
  assert.equal(reply.threadId,undefined,"connection replies do not invent a native task destination");
  assert.equal(reply.agentAdapter,undefined);
});
