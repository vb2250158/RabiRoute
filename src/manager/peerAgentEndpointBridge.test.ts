import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { AgentRequestStore } from "../agentRequests/store.js";
import { executeEndpointAgentDelivery } from "../agentRequests/endpointDelivery.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { createPeerAgentEndpointBridge, type PeerAgentEndpointBridge, type PeerAgentEndpointOptions } from "./peerAgentEndpointBridge.js";
import type { AgentThreadRequest, AgentThreadRemoteSource } from "../agentThreads.js";
import { agentReplyRequest } from "../agentRequests/replyParameters.js";
import { remoteAgentTargetKey, resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";
import { normalizeAgentInstanceBinding } from "../shared/agentInstance.js";

test("peer target keys retain owning PC while old connector identities remain unchanged", () => {
  const binding = { ownerDeviceId: "pc-b", instanceId: "instance", agentId: "codex" };
  assert.deepEqual(normalizeAgentInstanceBinding(binding), binding);
  assert.equal(remoteAgentTargetKey({ instanceId: "instance", agentId: "codex" }), "remote:instance:codex");
  assert.notEqual(remoteAgentTargetKey(binding), remoteAgentTargetKey({ ...binding, ownerDeviceId: "pc-c" }));
  const id = remoteAgentTargetKey(binding);
  assert.deepEqual(resolvePrimaryAgentTarget({ agentAdapters: [], remoteAgentTargets: [{ ...binding, id, provider: "codex" }], primaryAgentTarget: id })?.binding, binding);
});

test("connected native Peer source can start a new conversation on A and receive its formal reply", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-initiator-"));
  const store = new AgentRequestStore(path.join(directory, "a.json")), targetStore = new AgentRequestStore(path.join(directory, "b.json"));
  t.after(async () => { await Promise.all([store.close(), targetStore.close()]); fs.rmSync(directory, { recursive: true, force: true }); });
  const scope = () => "connected-app", guard = () => {};
  let executesA = 0, repliesB = 0;
  const readLocal: PeerAgentEndpointOptions["readLocal"] = async (_provider, id) => ({ id, title: id, cwd: directory, updatedAt: "" });
  const b = createPeerAgentEndpointBridge({ managerInstanceId: "instance-b", localDeviceId: () => "pc-b", scope,
    store: targetStore, receiptDirectory: path.join(directory, "b-receipts"), readLocal, localOptions: () => ({ allowedWorkspaces: [directory] }),
    principal: () => ({ scope: scope(), sourceDeviceId: "pc-a", deviceOwner: true }), request: async () => { throw new Error("No extra lookup is needed on B."); },
    executeOwner: async delivery => { repliesB++; return { threadId: delivery.target.sessionId, action: "started", transport: "test-native-b" }; } });
  const a = createPeerAgentEndpointBridge({ managerInstanceId: "instance-a", localDeviceId: () => "pc-a", scope,
    store, receiptDirectory: path.join(directory, "a-receipts"), readLocal, localOptions: () => ({ allowedWorkspaces: [directory] }), principal: () => undefined,
    request: async (device, method, pathname, body) => {
      assert.equal(device, "pc-b");
      if (method === "GET") return { code: 0, instances: [{ instanceId: "instance-b", local: true, agents: [] }] };
      if (pathname === "/api/agent/threads") return { code: 0, thread: await readLocal("codex", (body as AgentThreadRequest).threadId!) };
      return { code: 0, receipt: await b.prepareExecution({} as IncomingMessage)(body as Parameters<ReturnType<typeof b.prepareExecution>>[0], pathname.endsWith("/reconcile")) };
    } });
  const owner = createAgentEndpointDelivery({ store, registry: { localInstanceId: "instance-a" }, authority: {}, config: {},
    receiptDirectory: path.join(directory, "native-a"), readLocal, localOptions: () => ({ allowedWorkspaces: [directory] }), peer: a } as unknown as AgentEndpointDeliveryContext);
  const options = owner.options(undefined, guard, { scope: scope(), sourceDeviceId: "pc-b", deviceOwner: true });
  options.dispatch = async delivery => { executesA++; return { deliveryId: delivery.deliveryId, generation: delivery.generation,
    endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
    accepted: true, action: "started", transport: "test-native-a" }; };
  const initial = await executeEndpointAgentDelivery({ action: "send", agentAdapter: "codex", agentTargetId: "local:codex", threadId: "target-a",
    sourceThreadId: "source-b", sourceAgentType: "agent", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source-b", sessionName: "B" },
    prompt: "B starts a new message", deliveryId: "new-from-b", responsePolicy: "required", responseInstruction: "Reply to B" }, options);
  assert.equal(initial.data.status, "delivered"); assert.equal(executesA, 1);
  const delivered = store.getEndpointDelivery((initial.data.delivery as { deliveryId: string }).deliveryId)!;
  assert.notEqual(delivered.source.kind, "connection");
  if (delivered.source.kind === "connection") throw new Error("Expected the original task source");
  assert.equal(delivered.source.ownerDeviceId, "pc-b"); assert.equal(delivered.source.ledgerOwnerDeviceId, "pc-a");
  const reply = { ...agentReplyRequest(delivered.preparation), result: "A finished", nextAction: "Read", deliveryId: "reply-from-a" } as AgentThreadRequest;
  const response = await executeEndpointAgentDelivery(reply, owner.options());
  assert.equal(response.data.status, "delivered"); assert.equal(repliesB, 1);
  assert.equal(store.get(delivered.preparation.requestId!)?.status, "responded");
  await targetStore.ready();
  await targetStore.ready();
  assert.equal(targetStore.get(delivered.preparation.requestId!), undefined);
});

for (const sourceKind of ["local", "connector"] as const) test(`two delivery owners reconcile the original intent and reply to its ${sourceKind} source task`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-agent-"));
  const aStore = new AgentRequestStore(path.join(directory, "a.json")), bStore = new AgentRequestStore(path.join(directory, "b.json"));
  t.after(async () => { await aStore.close(); await bStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await Promise.all([aStore.ready(), bStore.ready()]);
  const guard = () => {}, scope = () => "application-scope";
  let executes = 0, loseResponse = true, replyExecutions = 0;
  let a: PeerAgentEndpointBridge, b: PeerAgentEndpointBridge;
  let deliveryOwner: ReturnType<typeof createAgentEndpointDelivery>;
  const readLocal: PeerAgentEndpointOptions["readLocal"] = async (_provider, id) => ({ id, title: id, cwd: directory, updatedAt: "" });
  const base = { scope, receiptDirectory: path.join(directory, "receipts"), readLocal, localOptions: () => ({ allowedWorkspaces: [directory] }),
    principal: () => ({ scope: scope(), sourceDeviceId: "pc-a", deviceOwner: true }) };
  a = createPeerAgentEndpointBridge({ ...base, managerInstanceId: "instance-a", localDeviceId: () => "pc-a", store: aStore,
    request: async (device, method, pathname, body: any) => {
      assert.equal(device, "pc-b");
      if (method === "GET") return { code: 0, instances: [{ local: true, instanceId: "instance-b", agents: [] }] };
      if (pathname === "/api/agent/threads") return { code: 0, thread: await readLocal("codex", body.threadId) };
      const receipt = await b.prepareExecution({} as IncomingMessage)(body, pathname.endsWith("/reconcile"));
      if (loseResponse) { loseResponse = false; throw new Error("response lost after exact owner accepted"); }
      return { code: 0, receipt };
    } });
  let acceptedPrompt = "";
  b = createPeerAgentEndpointBridge({ ...base, receiptDirectory: path.join(directory, "b-receipts"), managerInstanceId: "instance-b", localDeviceId: () => "pc-b", store: bStore,
    request: async (device, _method, pathname, body: any) => {
      assert.equal(device, "pc-a"); assert.equal(pathname, "/api/agent/threads");
      return (await executeEndpointAgentDelivery(body, deliveryOwner.options(undefined, guard, { scope: scope(), sourceDeviceId: "pc-b", deviceOwner: true }))).data;
    }, executeOwner: async value => { acceptedPrompt = value.prompt; executes++; return { threadId: value.target.sessionId, action: "started", transport: "test-native-owner" }; }, recoverOwner: async () => undefined });
  deliveryOwner = createAgentEndpointDelivery({ store: aStore, registry: { localInstanceId: "instance-a", getInstanceAgent: () => undefined,
    listNodes: () => [{ nodeId: "connector-a", connected: true }], manageAgent: async (_instance: string, operation: string, body: { threadId: string }) => {
      assert.equal(operation, "threads"); return { statusCode: 200, data: { thread: await readLocal("codex", body.threadId) } };
    } }, authority: { getNodeAuthorization: () => ({ incarnation: "original-lease" }) },
    config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "original-policy" }) },
    receiptDirectory: path.join(directory, "a-receipts"), readLocal, localOptions: () => ({}), peer: a } as unknown as AgentEndpointDeliveryContext);
  const request: AgentThreadRequest = { action: "send", agentAdapter: "codex", instanceBinding: { ownerDeviceId: "pc-b", instanceId: "instance-b", agentId: "unregistered-alias" },
    threadId: "target-b", sourceThreadId: "source-a", sourceAgentType: "agent", messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source-a", sessionName: "Source A" },
    deliveryId: "original-caller-id", prompt: "Work on the exact original task", responsePolicy: "required", responseInstruction: "Return the result" };
  const connectorSource: AgentThreadRemoteSource | undefined = sourceKind === "connector"
    ? { nodeId: "connector-a", agentId: "source-agent", provider: "codex", sessionId: "source-a", sessionName: "Source A", authorizationIncarnation: "captured-connection-incarnation" } : undefined;
  const initial = await executeEndpointAgentDelivery(request, deliveryOwner.options(connectorSource, guard));
  assert.equal(initial.data.status, "delivery_unconfirmed"); assert.equal(executes, 1);
  const confirmed = await executeEndpointAgentDelivery(request, deliveryOwner.options(connectorSource, guard));
  assert.equal(confirmed.data.status, "delivered"); assert.equal(executes, 1, "lost response must reconcile the same receipt, never resend");
  const delivery = aStore.getEndpointDelivery((confirmed.data.delivery as any).deliveryId)!;
  assert.equal(bStore.get(delivery.preparation.requestId!), undefined, "receiver must not create another formal business request");
  const archivedReceiver = createPeerAgentEndpointBridge({ ...base, receiptDirectory: path.join(directory, "b-receipts"),
    managerInstanceId: "instance-b", localDeviceId: () => "pc-b", store: bStore,
    readLocal: async () => { throw new Error("Accepted task is now archived; historical receipts do not need a live task."); },
    request: async () => { throw new Error("Historical receipt is local."); },
    executeOwner: async () => { throw new Error("Historical reconciliation must not execute."); } });
  const historical = await archivedReceiver.prepareExecution({} as IncomingMessage)({ ledgerOwnerDeviceId: "pc-a", delivery: { ...delivery, prompt: acceptedPrompt } }, true);
  assert.equal(historical?.accepted, true); assert.equal(executes, 1);

  const reply = { ...agentReplyRequest(delivery.preparation), result: "Done", nextAction: "Review", deliveryId: "formal-reply" } as AgentThreadRequest;
  assert.equal(reply.ledgerOwnerDeviceId, "pc-a");
  if (sourceKind === "connector") assert.equal(reply.instanceBinding?.instanceId, "connector-a", "formal reply retains its original connector task owner");
  // Inject the original local owner instead of a real Desktop process.
  const originalOptions = deliveryOwner.options.bind(deliveryOwner);
  deliveryOwner.options = ((...args: Parameters<typeof originalOptions>) => ({ ...originalOptions(...args), dispatch: async value => {
    replyExecutions++; return { deliveryId: value.deliveryId, generation: value.generation, endpoint: value.target, promptHash: value.promptHash,
      executionOptionsHash: value.executionOptionsHash, accepted: true, action: "started", transport: "test-source-owner" };
  } })) as typeof deliveryOwner.options;
  const response = await b.forwardReply(reply, guard);
  assert.equal(response?.data.status, "delivered"); assert.equal(replyExecutions, 1);
  assert.equal(aStore.get(delivery.preparation.requestId!)?.status, "responded");
  const routed = await a.resolveSource({ ...reply, sourceThreadId: "another-task" }, { scope: scope(), sourceDeviceId: "pc-b", deviceOwner: true });
  assert.equal(routed?.threadId, "another-task");
  assert.equal(routed?.endpoint?.ownerDeviceId, "pc-b");
});


test("Peer source, reply and original caller lookup use coordinates without reading any source owner", async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"peer-source-metadata-")),store=new AgentRequestStore(path.join(directory,"requests.json"));
  t.after(async()=>{await store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const calls: Array<{device:string;method:string;path:string;body:unknown}>=[];
  const bridge=createPeerAgentEndpointBridge({managerInstanceId:"a",localDeviceId:()=>"pc-a",scope:()=>"scope",store,
    receiptDirectory:path.join(directory,"receipts"),readLocal:async()=>{throw new Error("No local source owner reads");},localOptions:()=>({allowedWorkspaces:[]}),principal:()=>undefined,
    request:async(device,method,path,body)=>{calls.push({device,method,path,body});return {ok:true,status:"delivered"};},
    requestResult:async(device,method,path,body)=>{calls.push({device,method,path,body});return {status:404,body:{errorCode:"DELIVERY_NOT_RESERVED"}};} });
  const source=await bridge.resolveSource({action:"send",sourceThreadId:"unregistered-session",messageSource:{type:"agent",agentAdapter:"codex",sessionId:"another-declaration",sessionName:"Declared"}},
    {scope:"scope",sourceDeviceId:"pc-b",deviceOwner:true});
  assert.equal(source?.endpoint?.kind,"local"); assert.equal(source?.endpoint?.ownerDeviceId,"pc-b");
  assert.equal(source?.endpoint?.instanceId,undefined); assert.equal(source?.threadId,"unregistered-session"); assert.equal(calls.length,0);
  assert.equal((await bridge.forwardReply({action:"send",ledgerOwnerDeviceId:"pc-b",inReplyToRequestId:"original"},()=>{}))?.data.status,"delivered");
  assert.equal((await bridge.forwardCallerLookup("original-id",{ledgerOwnerDeviceId:"pc-b"},()=>{}))?.status,404);
  assert.equal(calls.length,2); assert.equal(calls[0]!.device,"pc-b");
  assert.ok(calls[1]!.path.includes("/caller/original-id"));
});


test("a stored peer return address resolves its actual target cwd and rejects another task", async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"peer-return-target-")),store=new AgentRequestStore(path.join(directory,"requests.json"));
  t.after(async()=>{await store.close();fs.rmSync(directory,{recursive:true,force:true});});
  let returnedId="target-b",reads=0,scope="scope";
  const bridge=createPeerAgentEndpointBridge({managerInstanceId:"a",localDeviceId:()=>"pc-a",scope:()=>scope,store,
    receiptDirectory:path.join(directory,"receipts"),readLocal:async()=>{throw new Error("Not a local target");},localOptions:()=>({allowedWorkspaces:[]}),principal:()=>undefined,
    request:async(device,method,path,body)=>{reads++;assert.equal(device,"pc-b");assert.equal(method,"POST");assert.equal(path,"/api/agent/threads");
      assert.deepEqual(body,{action:"read",agentAdapter:"codex",agentTargetId:"local:codex",threadId:"target-b"});
      return {thread:{id:returnedId,title:"B target",cwd:directory,updatedAt:""}};} });
  const address=await bridge.resolveSource({action:"send",sourceThreadId:"target-b",messageSource:{type:"agent",agentAdapter:"codex",sessionId:"target-b",sessionName:"B"}},
    {scope:"scope",sourceDeviceId:"pc-b",deviceOwner:true});
  assert.equal(reads,0); assert.equal(address?.workspace,undefined);
  const target=await bridge.resolveStoredTarget(address!);assert.equal(reads,1);assert.equal(target.workspace,directory);
  assert.deepEqual(target.endpoint,address!.endpoint);
  scope="reconnected-scope";
  const reconnected=await bridge.resolveStoredTarget(address!);
  assert.notEqual(reconnected.endpoint?.authorizationIncarnation,address!.endpoint?.authorizationIncarnation);
  assert.equal(reconnected.endpoint?.sessionId,address!.endpoint?.sessionId);
  assert.equal(reconnected.workspace,directory);
  returnedId="another-task";await assert.rejects(bridge.resolveStoredTarget(address!),/Exact peer task owner/);
});
