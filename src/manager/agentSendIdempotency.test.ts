import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSendRequest, AgentSendResult } from "../agentSend.js";
import {
  agentSendReceiptResponse,
  executeIdempotentAgentSend,
  readAgentSendReceipt
} from "./agentSendIdempotency.js";

test("agent send idempotency stores one result for one explicit send request", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-idempotency-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const request: AgentSendRequest = {
    deliveryId: "delivery-explicit-1",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456" },
    payload: { type: "text", text: "hello" }
  };
  let count = 0;
  const deliver = async (): Promise<AgentSendResult> => {
    count += 1;
    return { ok: true, status: "sent", channel: "napcat", routeId: "route-main", target: { groupId: "456" }, sentMessageId: "qq-1" };
  };

  const first = await executeIdempotentAgentSend(request, { rootDir, deliver });
  const duplicate = await executeIdempotentAgentSend(request, { rootDir, deliver });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.body.idempotency.duplicate, true);
  assert.equal(count, 1);
  assert.equal(readAgentSendReceipt(rootDir, "delivery-explicit-1")?.result?.channel, "napcat");
  assert.equal(agentSendReceiptResponse(rootDir, "delivery-explicit-1").body.sentMessageId, "qq-1");
});

test("invalid send requests are rejected before an idempotency reservation is written", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-invalid-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const request: AgentSendRequest = {
    deliveryId: "delivery-invalid-1",
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group" },
    payload: { type: "text", text: "hello" }
  };

  await assert.rejects(
    executeIdempotentAgentSend(request, {
      rootDir,
      deliver: async () => ({ ok: true, status: "sent", channel: "napcat" })
    }),
    /params\.groupId/
  );
  assert.equal(readAgentSendReceipt(rootDir, "delivery-invalid-1"), null);
});
