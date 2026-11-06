import assert from "node:assert/strict";
import test from "node:test";
import { agentReplyParameters, agentReplyRequest } from "./replyParameters.js";
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
