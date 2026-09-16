import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleAgentThreadRequest, type AgentThreadDriver, type AgentThreadRequest, type AgentThreadRemoteSource } from "./agentThreads.js";
import { handleAgentThreadControlApi, type AgentThreadControlRoutesContext } from "./manager/agentThreadControlRoutes.js";
import type http from "node:http";

const sessionId = "019f0000-0000-7000-8000-000000000001";
const remote: AgentThreadRemoteSource = { nodeId: "test-node", agentId: "test-agent", provider: "codex", sessionId, sessionName: "Approved remote session", workspace: "/remote/workspace" };
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

test("trusted remote source bypasses local reads even with an identical local target ID", async () => {
  const { reads, sends, driver } = fixture();
  let history: AgentThreadRequest | undefined;
  const result = await handleAgentThreadRequest(request, {
    allowedWorkspaces: [process.cwd()], remoteSource: remote,
    onChatHistoryDelivery: async value => { history = value; }
  }, driver);
  const namespace = `instance-${createHash("sha256").update(JSON.stringify([remote.nodeId, remote.agentId, sessionId])).digest("hex")}`;
  assert.equal(result.data.status, "delivered");
  assert.deepEqual(reads, []);
  assert.equal(sends.length, 1);
  assert.equal(result.data.threadId, sessionId);
  assert.deepEqual(result.data.source, { agentAdapter: "codex", agentType: "agent", agentLabel: "Agent", threadId: namespace, threadName: remote.sessionName, workspace: remote.workspace, nodeId: remote.nodeId, agentId: remote.agentId });
  assert.equal(history?.sourceThreadId, namespace);
  assert.equal(history?.messageSource?.type === "agent" && history.messageSource.sessionId, namespace);
});

test("remote source mismatches and unsupported reply contracts fail before local reads or delivery", async () => {
  for (const patch of [
    { sourceThreadId: "other-session" },
    { messageSource: { ...request.messageSource, sessionId: "other-session" } },
    { messageSource: { ...request.messageSource, agentAdapter: "dsh" } },
    { messageSource: { type: "system", eventType: "test", eventName: "test", eventId: "test-event" } },
    { responsePolicy: "required" },
    { responsePolicy: undefined },
    { inReplyToRequestId: "request-id" }
  ]) {
    const { reads, sends, driver } = fixture();
    await assert.rejects(handleAgentThreadRequest({ ...request, ...patch } as AgentThreadRequest, {
      allowedWorkspaces: [process.cwd()], remoteSource: remote
    }, driver), /trusted remote|Trusted remote/);
    assert.deepEqual(reads, []);
    assert.deepEqual(sends, []);
  }
});

test("without trusted options source verification still reads local owner", async () => {
  const { reads, driver } = fixture();
  await handleAgentThreadRequest({ ...request, threadId: "019f0000-0000-7000-8000-000000000002" }, {
    allowedWorkspaces: [process.cwd()]
  }, driver);
  assert.deepEqual(reads, [sessionId]);
});

test("HTTP route takes remoteSource exclusively from request context, not body or options defaults", async () => {
  for (const trusted of [undefined, remote]) {
    const incoming = { method: "POST" } as http.IncomingMessage;
    let captured: unknown;
    let operation: Promise<unknown> | undefined;
    const context = {
      readJsonBody: async () => ({ ...request, remoteSource: remote }),
      jsonResponse: () => {},
      applyManagedAgentThreadDefaults: (body: AgentThreadRequest) => body,
      agentThreadRequestOptions: () => ({ allowedWorkspaces: [], remoteSource: remote }),
      getTrustedRemoteSource: (value: http.IncomingMessage) => { assert.equal(value, incoming); return trusted; },
      handleAgentThreadRequest: async (_body: unknown, options: { remoteSource?: unknown }) => {
        captured = options.remoteSource; return { statusCode: 200, data: {} };
      },
      refreshAgentRequestReminderTimers: () => {},
      agentThreadRequestFailureData: (error: unknown) => { throw error; }
    } as unknown as AgentThreadControlRoutesContext;
    assert.equal(handleAgentThreadControlApi(incoming, new URL("http://localhost/api/agent/threads"), {} as http.ServerResponse, context, promise => {
      operation = promise; return promise;
    }), true);
    await operation;
    assert.equal(captured, trusted);
  }
});
