import assert from "node:assert/strict";
import test from "node:test";
import { agentReplyParameters, agentReplyRequest, agentRequestReminderPrompt } from "./replyParameters.js";
import type { AgentRequestRecord } from "./store.js";

test("connection response locators query the original Peer ledger and never invent a task destination", () => {
  const source = { threadId: "", agentType: "agent", connection: { kind: "connection" as const, managerInstanceId: "manager-a",
    transport: "lan-agent" as const, id: "node-a", ledgerOwnerDeviceId: "pc-a" } };
  const target = { threadId: "actual-task-b", agentAdapter: "codex" as const, agentType: "agent", endpoint: { kind: "local" as const,
    managerInstanceId: "manager-a", ownerDeviceId: "pc-b", agentId: "local:codex", provider: "codex", sessionId: "actual-task-b", authorizationIncarnation: "target-epoch" } };
  const preparation = { deliveryId: "delivery", requestId: "request/opaque", responsePolicy: "required" as const, source, target };
  const parameters = agentReplyParameters(preparation);
  assert.deepEqual(parameters.record, { method: "GET", path: "/api/rabilink/peer/http/pc-a/manager/api/agent/requests/request%2Fopaque", ledgerOwnerDeviceId: "pc-a" });
  const request = agentReplyRequest(preparation);
  assert.equal(request.ledgerOwnerDeviceId, "pc-a"); assert.equal(request.threadId, undefined); assert.equal(request.agentAdapter, undefined);
  assert.equal(request.inReplyToRequestId, preparation.requestId); assert.equal(request.responsePolicy, "none");
  const local = agentReplyParameters({ ...preparation, target: { ...target, endpoint: { ...target.endpoint, ownerDeviceId: "pc-a" } } });
  assert.equal((local.record as { path: string }).path, "/api/agent/requests/request%2Fopaque");
  const noRoute = agentReplyParameters({ ...preparation, source: { ...source, connection: { ...source.connection, ledgerOwnerDeviceId: undefined } } });
  assert.equal((noRoute.record as { path: string }).path, "/api/agent/requests/request%2Fopaque");
  assert.equal(agentReplyParameters({ ...preparation, requestId: undefined, responsePolicy: "none" }).request, undefined);
});

test("reply reminders use the same complete destination and sender contract as original deliveries", () => {
  const source = { threadId: "requester", threadName: "Requester", agentAdapter: "codex" as const, agentType: "agent", workspace: "C:/requester" };
  const target = { threadId: "responder", threadName: "Responder", agentAdapter: "dsh" as const, agentType: "plan_agent", workspace: "C:/responder" };
  const preparation = { deliveryId: "delivery", requestId: "request", responsePolicy: "required" as const,
    responseInstruction: "Return verified results", source, target };
  const parameters = agentReplyParameters(preparation);
  const request = agentReplyRequest(preparation);
  assert.deepEqual(parameters.request, request);
  assert.equal(request.threadId, source.threadId);
  assert.equal(Object.hasOwn(request, "prompt"), false);
  assert.equal(request.sourceThreadId, target.threadId);
  assert.equal(request.cwd, source.workspace);
  assert.deepEqual(request.messageSource, { type: "agent", agentAdapter: "dsh", sessionId: "responder", sessionName: "Responder", workspace: "C:/responder" });
  const record: AgentRequestRecord = { ...preparation, id: "request", status: "awaiting_response",
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", reminderCount: 0 };
  const reminder = agentRequestReminderPrompt(record);
  assert.ok(reminder.includes(JSON.stringify({ requestId: record.id, endpoint: "POST /api/agent/threads", request }, null, 2)));
  assert.match(reminder, /原请求时间：2026-09-01/);
  assert.doesNotMatch(reminder, /协作要求|action=send|当前任务完整 ID/);
});
