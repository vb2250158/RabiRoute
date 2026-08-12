import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSendRequest, AgentSendResult } from "../agentSend.js";
import {
  agentSendReceiptResponse,
  executeIdempotentAgentSend,
  findAgentSendTraces,
  readAgentSendReceipt
} from "./agentSendIdempotency.js";

test("agent send idempotency stores one result for one explicit send request", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-idempotency-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const request: AgentSendRequest = {
    deliveryId: "delivery-explicit-1",
    sender: { agentType: "codex", sessionId: "thread-explicit-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "" },
    payload: { type: "text", text: "hello" }
  };
  let count = 0;
  const deliver = async (): Promise<AgentSendResult> => {
    count += 1;
    return {
      ok: true,
      status: "sent",
      channel: "napcat",
      routeId: "route-main",
      target: { groupId: "456" },
      sentMessageId: "qq-1"
    };
  };

  const first = await executeIdempotentAgentSend(request, { rootDir, deliver });
  const duplicate = await executeIdempotentAgentSend(request, { rootDir, deliver });
  const conflict = await executeIdempotentAgentSend({
    ...request,
    sender: { agentType: "codex", sessionId: "thread-explicit-2" }
  }, { rootDir, deliver });
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.body.idempotency.duplicate, true);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.idempotency.state, "conflict");
  assert.equal(count, 1);
  assert.equal(readAgentSendReceipt(rootDir, "delivery-explicit-1")?.result?.channel, "napcat");
  assert.equal(agentSendReceiptResponse(rootDir, "delivery-explicit-1").body.sentMessageId, "qq-1");
  assert.deepEqual(agentSendReceiptResponse(rootDir, "delivery-explicit-1").body.sender, {
    agentType: "codex",
    sessionId: "thread-explicit-1"
  });
  assert.deepEqual(findAgentSendTraces(rootDir, {
    channel: "napcat",
    sentMessageId: "qq-1"
  }).map(item => ({ deliveryId: item.deliveryId, sender: item.result.sender })), [{
    deliveryId: "delivery-explicit-1",
    sender: { agentType: "codex", sessionId: "thread-explicit-1" }
  }]);
});

test("invalid send requests are rejected before an idempotency reservation is written", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-invalid-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const request: AgentSendRequest = {
    deliveryId: "delivery-invalid-1",
    sender: { agentType: "codex", sessionId: "thread-invalid-1" },
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

test("message processing sends with different delivery ids coalesce identical concurrent content", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-content-dedupe-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const baseRequest: Omit<AgentSendRequest, "deliveryId" | "sender"> = {
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-message-1" },
    payload: { type: "text", text: "same progress update" }
  };
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  let deliverCount = 0;
  const deliver = async (): Promise<AgentSendResult> => {
    deliverCount += 1;
    if (deliverCount === 1) await firstCanFinish;
    return {
      ok: true,
      status: "sent",
      channel: "napcat",
      routeId: "route-main",
      target: { target: "group", groupId: "456" },
      sentMessageId: `qq-${deliverCount}`
    };
  };

  const firstPromise = executeIdempotentAgentSend({
    ...baseRequest,
    deliveryId: "content-delivery-1",
    sender: { agentType: "message_processing", sessionId: "message-thread-1" }
  }, { rootDir, deliver });
  await new Promise(resolve => setTimeout(resolve, 20));
  const secondPromise = executeIdempotentAgentSend({
    ...baseRequest,
    deliveryId: "content-delivery-2",
    sender: { agentType: "message_processing", sessionId: "message-thread-2" }
  }, { rootDir, deliver });
  releaseFirst();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(deliverCount, 1);
  assert.equal(first.body.sentMessageId, "qq-1");
  assert.equal(second.body.sentMessageId, "qq-1");
  assert.equal(second.body.idempotency.duplicate, true);
  assert.equal(readAgentSendReceipt(rootDir, "content-delivery-2")?.result?.sentMessageId, "qq-1");
});

test("message processing content dedupe keeps different quoted source messages separate", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-reply-dedupe-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let deliverCount = 0;
  const send = (deliveryId: string, replyToMessageId: string) => executeIdempotentAgentSend({
    deliveryId,
    sender: { agentType: "message_processing", sessionId: `thread-${deliveryId}` },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId },
    payload: { type: "text", text: "same clarification" }
  }, {
    rootDir,
    deliver: async () => ({
      ok: true,
      status: "sent",
      channel: "napcat",
      sentMessageId: `qq-${++deliverCount}`
    })
  });

  await send("reply-delivery-1", "source-message-1");
  await send("reply-delivery-2", "source-message-2");
  assert.equal(deliverCount, 2);
});

test("recent replies to the same quoted group message require an explicit follow-up", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-reply-target-dedupe-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let deliverCount = 0;
  const deliver = async (): Promise<AgentSendResult> => ({
    ok: true,
    status: "sent",
    channel: "napcat",
    sentMessageId: `qq-${++deliverCount}`
  });

  const first = await executeIdempotentAgentSend({
    deliveryId: "reply-target-delivery-1",
    sender: { agentType: "message_processing", sessionId: "message-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-message-1" },
    payload: { type: "text", text: "first correction" }
  }, { rootDir, deliver });
  const accidentalSecond = await executeIdempotentAgentSend({
    deliveryId: "reply-target-delivery-2",
    sender: { agentType: "primary_persona", sessionId: "primary-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-message-1" },
    payload: { type: "text", text: "different wording for the same correction" }
  }, { rootDir, deliver });
  const intentionalFollowUp = await executeIdempotentAgentSend({
    deliveryId: "reply-target-delivery-3",
    sender: { agentType: "primary_persona", sessionId: "primary-thread-1" },
    routeId: "route-main",
    channel: "napcat",
    params: {
      target: "group",
      groupId: "456",
      replyToMessageId: "source-message-1",
      allowAdditionalReply: true
    },
    payload: { type: "text", text: "new evidence that intentionally follows the first reply" }
  }, { rootDir, deliver });

  assert.equal(first.statusCode, 202);
  assert.equal(accidentalSecond.statusCode, 409);
  assert.equal(accidentalSecond.body.idempotency.state, "conflict");
  assert.match(String(accidentalSecond.body.reason), /already received a recent reply/i);
  assert.equal(intentionalFollowUp.statusCode, 202);
  assert.equal(deliverCount, 2);
});

test("a recent persisted reply still blocks a paraphrase after Manager restart", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-send-reply-restart-dedupe-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const receiptDir = path.join(rootDir, "data", "agent-send-idempotency");
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(path.join(receiptDir, "persisted-reply.json"), JSON.stringify({
    version: 1,
    deliveryId: "reply-before-restart",
    requestDigest: "persisted-test-digest",
    state: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: {
      ok: true,
      status: "sent",
      channel: "napcat",
      routeId: "route-main",
      target: {
        target: "group",
        groupId: "456",
        replyToMessageId: "source-before-restart"
      },
      sentMessageId: "qq-before-restart"
    }
  }), "utf8");
  let deliverCount = 0;

  const response = await executeIdempotentAgentSend({
    deliveryId: "reply-after-restart",
    sender: { agentType: "primary_persona", sessionId: "primary-after-restart" },
    routeId: "route-main",
    channel: "napcat",
    params: { target: "group", groupId: "456", replyToMessageId: "source-before-restart" },
    payload: { type: "text", text: "the same answer with different wording" }
  }, {
    rootDir,
    deliver: async () => {
      deliverCount += 1;
      return { ok: true, status: "sent", channel: "napcat" };
    }
  });

  assert.equal(response.statusCode, 409);
  assert.match(String(response.body.reason), /already received a recent reply/i);
  assert.equal(deliverCount, 0);
});
