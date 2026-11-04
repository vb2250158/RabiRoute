import test from "node:test";
import assert from "node:assert/strict";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { agentReplyRequest, agentReplyParameters, agentRequestReminderPrompt } from "../agentRequests/replyParameters.js";
import { AgentRequestStore, type AgentRequestParty } from "../agentRequests/store.js";
import type { AgentThreadRequest } from "../agentThreads.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

function fixture(hasProfileWorkspace = true) {
  let reads = 0;
  const store = new AgentRequestStore({ read: () => undefined, write: () => {} });
  const registry = {
    localInstanceId: "manager",
    getInstanceAgent: () => ({ provider: "codex-desktop", name: "Native Agent", workspace: hasProfileWorkspace ? "F:/Work/Product/Main" : undefined }),
    manageAgent: async (_node: string, operation: string, request: { action: string; threadId: string }, _timeout: number, guard: () => void) => {
      reads++; guard();
      assert.equal(operation, "threads"); assert.equal(request.action, "read"); assert.equal(request.threadId, targetId);
      return { statusCode: 200, data: { thread: { id: targetId, cwd: "F:/Work/Product/Release", archived: false } } };
    }
  };
  const context = {
    store, registry, authority: { getNodeAuthorization: () => ({ incarnation: "original-lease" }) },
    config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "original-policy" }) },
    receiptDirectory: "unused-reply-workspace-receipts", localOptions: () => ({ allowedWorkspaces: [] }),
    readLocal: async () => { throw new Error("No local read expected"); }
  } as unknown as AgentEndpointDeliveryContext;
  return { factory: createAgentEndpointDelivery(context), reads: () => reads };
}

function request(cwd?: string): AgentThreadRequest {
  return {
    action: "send", threadId: targetId, sourceThreadId: sourceId, sourceAgentType: "agent", agentAdapter: "codex",
    instanceBinding: { instanceId: "remote", agentId: "native-agent" }, ...(cwd ? { cwd } : {}),
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: sourceId, sessionName: "Coordinator", workspace: "C:/Work/Coordinator" },
    prompt: "New verified task intent", responsePolicy: "required", responseInstruction: "Reply to the original coordinator"
  };
}

test("remote callback uses the explicit execution workspace while reply destination and reminder identity stay unchanged", async () => {
  const f = fixture(), r = request("F:/Work/Product/Release"), options = f.factory.options(), target = await options.resolveTarget(r);
  const execution = options.resolveExecutionOptions(r, target);
  assert.equal(execution.cwd, r.cwd); assert.equal(target.workspace, execution.cwd);
  const source: AgentRequestParty = {
    threadId: sourceId, threadName: "Coordinator", agentAdapter: "codex", agentType: "agent", workspace: "C:/Work/Coordinator",
    endpoint: { kind: "local", managerInstanceId: "manager", agentId: "local:codex", provider: "codex", sessionId: sourceId, authorizationIncarnation: "local-epoch" }
  };
  const preparation = { source, target, deliveryId: "original-actual", requestId: "original-request", responsePolicy: "required" as const, responseInstruction: "Reply" };
  const reply = agentReplyRequest(preparation);
  assert.equal((reply.messageSource as { workspace: string }).workspace, "F:/Work/Product/Release");
  assert.equal(reply.cwd, "C:/Work/Coordinator"); assert.equal(reply.threadId, sourceId); assert.equal(reply.sourceThreadId, targetId);
  assert.equal(reply.agentTargetId, "local:codex"); assert.equal(reply.inReplyToRequestId, "original-request");
  assert.deepEqual(agentReplyParameters(preparation).request, reply);
  const reminder = agentRequestReminderPrompt({ ...preparation, id: "original-request", status: "awaiting_response", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", reminderCount: 0 });
  assert.ok(reminder.includes("F:/Work/Product/Release")); assert.ok(!reminder.includes("F:/Work/Product/Main"));
  assert.equal(f.reads(), 0, "An explicit delivery workspace does not require an additional owner RPC");
});

test("missing explicit and profile workspace keeps the existing exact owner metadata lookup", async () => {
  const f = fixture(false), target = await f.factory.options().resolveTarget(request());
  assert.equal(target.workspace, "F:/Work/Product/Release"); assert.equal(f.reads(), 1);
});

test("remote source descriptions retain the actual admitted node and epoch without another source qualification", async () => {
  const f = fixture(), r: AgentThreadRequest = { ...request(), sourceThreadId: targetId, messageSource: { type: "agent", agentAdapter: "codex", sessionId: targetId, sessionName: "Untrusted name", workspace: "C:/Untrusted" } };
  const source = await f.factory.options({ nodeId: "remote", agentId: "native-agent", sessionId: targetId, provider: "codex", sessionName: "Actual owner", workspace: "F:/Work/Product/Release", authorizationIncarnation: "actual-ingress-epoch" }, () => {}).resolveSource(r);
  assert.equal(source.workspace, "C:/Untrusted"); assert.equal(source.threadName, "Untrusted name");
  assert.equal(source.endpoint?.nodeId, "remote"); assert.equal(source.endpoint?.instanceId, "remote");
  assert.equal(source.endpoint?.managerInstanceId, "manager"); assert.equal(source.endpoint?.authorizationIncarnation, "actual-ingress-epoch");
  assert.equal(source.threadId, targetId); assert.equal(f.reads(), 0);
});
