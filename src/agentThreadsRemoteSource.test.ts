import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentThreadRequest, type AgentThreadDriver, type AgentThreadRequest, type AgentThreadRemoteSource } from "./agentThreads.js";
import { createAgentThreadControlOwner, type AgentThreadControlRoutesContext } from "./manager/agentThreadControlRoutes.js";
import type http from "node:http";

const sessionId = "019f0000-0000-7000-8000-000000000001";
const remote: AgentThreadRemoteSource = { nodeId: "test-node", agentId: "test-agent", provider: "codex", sessionId, sessionName: "Approved remote session", workspace: "/remote/workspace", authorizationIncarnation: "captured-connection-incarnation" };
const request: AgentThreadRequest = {
  action: "send", threadId: sessionId, sourceThreadId: sessionId, sourceAgentType: "agent",
  prompt: "A remote handoff", responsePolicy: "none", cwd: process.cwd(),
  messageSource: { type: "agent", agentAdapter: "codex", sessionId, sessionName: "Untrusted display name" }
};
function fixture() {
  const reads: string[] = [];
  const sends: unknown[] = [];
  const driver: AgentThreadDriver = {
    read: async id => { reads.push(id); return { id, title: "Local collision", updatedAt: "" }; },
    create: async () => { throw new Error("Unexpected create"); },
    send: async value => { sends.push(value); }
  };
  return { reads, sends, driver };
}

test("connected source uses declared metadata and original session without local reads", async () => {
  const { reads, sends, driver } = fixture(); let history: AgentThreadRequest | undefined;
  const result = await handleAgentThreadRequest(request, { allowedWorkspaces: [process.cwd()], remoteSource: remote,
    onChatHistoryDelivery: async value => { history = value; } }, driver);
  assert.equal(result.data.status, "delivered"); assert.deepEqual(reads, []); assert.equal(sends.length, 1);
  assert.deepEqual(result.data.source, { agentAdapter: "codex", agentType: "agent", agentLabel: "Agent", threadId: sessionId,
    threadName: "Untrusted display name", workspace: remote.workspace, nodeId: remote.nodeId, agentId: remote.agentId });
  assert.equal(history?.sourceThreadId, sessionId);
  assert.equal(history?.messageSource?.type === "agent" && history.messageSource.sessionId, sessionId);
});

test("source endpoint uses captured ingress incarnation without a lease or owner lookup", async () => {
  const { reads, sends, driver } = fixture(); let constructed = 0;
  await assert.rejects(handleAgentThreadRequest({ ...request, responsePolicy: "required", responseInstruction: "Reply." }, {
    allowedWorkspaces: [process.cwd()], remoteSource: remote,
    remoteEndpoint: (nodeId, agentId, id, provider, incarnation) => {
      constructed++; assert.deepEqual([nodeId,agentId,id,provider,incarnation],
        [remote.nodeId,remote.agentId,sessionId,"codex",remote.authorizationIncarnation]);
      return { kind: "instance", managerInstanceId: "manager", instanceId: nodeId, nodeId, agentId, provider: provider!, sessionId: id,
        authorizationIncarnation: incarnation! };
    }
  }, driver), /Agent request tracking is unavailable/);
  assert.equal(constructed, 1); assert.deepEqual(reads, []); assert.deepEqual(sends, []);
});

test("connected calls do not require matching source declarations or Agent-only attribution", async () => {
  for (const patch of [ { sourceThreadId: "other-session" },
    { messageSource: { ...request.messageSource, sessionId: "other-session" } },
    { messageSource: { ...request.messageSource, agentAdapter: "dsh" } },
    { messageSource: { type: "system", eventType: "test", eventName: "test", eventId: "event" } },
    { responsePolicy: undefined } ]) {
    const { reads, sends, driver } = fixture();
    const result = await handleAgentThreadRequest({ ...request, ...patch } as AgentThreadRequest,
      { allowedWorkspaces: [process.cwd()], remoteSource: remote }, driver);
    assert.equal(result.data.status, "delivered"); assert.deepEqual(reads, []); assert.equal(sends.length, 1);
  }
});

test("local declared sources never read their owner", async () => {
  const { reads, sends, driver } = fixture();
  await handleAgentThreadRequest({ ...request, threadId: "019f0000-0000-7000-8000-000000000002" }, { allowedWorkspaces: [process.cwd()] }, driver);
  assert.deepEqual(reads, []); assert.equal(sends.length, 1);
});

test("thread ingress takes connector authority from context and explicit session display metadata from the canonical source", async () => {
  for (const trusted of [undefined, remote]) {
    const incoming = { method: "POST" } as http.IncomingMessage;
    let captured: unknown;
    const context = {
      applyManagedAgentThreadDefaults: (body: AgentThreadRequest) => body,
      // The real Manager merges the route's overrides over its own defaults. The stub must
      // do the same, otherwise a leaked default would be indistinguishable from the truth.
      agentThreadRequestOptions: (_body: unknown, extra: { remoteSource?: unknown } = {}) => ({
        allowedWorkspaces: [], remoteSource: remote, ...extra
      }),
      getTrustedRemoteSource: (value: http.IncomingMessage) => { assert.equal(value, incoming); return trusted; },
      handleAgentThreadRequest: async (_body: unknown, options: { remoteSource?: unknown }) => {
        captured = options.remoteSource; return { statusCode: 200, data: {} };
      },
      refreshAgentRequestReminderTimers: () => {},
      agentThreadRequestFailureData: (error: unknown) => { throw error; }
    } as unknown as AgentThreadControlRoutesContext;
    const result = await createAgentThreadControlOwner(context).prepare(incoming).execute({ ...request, ...{ remoteSource: remote } });
    assert.equal(result.status, 200);
    assert.deepEqual(captured, trusted ? { ...trusted, sessionId: request.sourceThreadId, sessionName: request.messageSource?.type === "agent" ? request.messageSource.sessionName : trusted.sessionName } : undefined);
  }
});


test("legacy create and send accept SDK source coordinates without a display name or cwd",async()=>{
  const {reads,sends,driver}=fixture();
  const partial={...request,messageSource:{type:"agent",agentAdapter:"codex",sessionId}} as AgentThreadRequest;
  const result=await handleAgentThreadRequest(partial,{allowedWorkspaces:[process.cwd()],remoteSource:{nodeId:"node-a"}},driver);
  assert.equal(result.data.status,"delivered");assert.deepEqual(reads,[]);assert.equal(sends.length,1);
  assert.equal((result.data.source as {threadName:string}).threadName,sessionId);
  let creates=0;
  const created=await handleAgentThreadRequest({...partial,action:"create",title:"SDK create"},{allowedWorkspaces:[process.cwd()],remoteSource:{nodeId:"node-a"}},
    {...driver,create:async value=>{creates++;return {id:sessionId,title:value.title,updatedAt:"",source:"test",initialTurnStatus:"started"};}});
  assert.equal(created.statusCode,201);assert.equal(creates,1);assert.deepEqual(reads,[]);
});
