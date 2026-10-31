import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_REQUEST_REMINDER_MS,
  AgentRequestStore,
  type AgentRequestPersistence
} from "./store.js";

class MemoryPersistence implements AgentRequestPersistence {
  value: unknown;
  read(): unknown { return this.value; }
  write(state: unknown): void { this.value = structuredClone(state); }
}

function parties() {
  return {
    source: { threadId: "source", agentType: "plan_agent", workspace: "C:\\repo" },
    target: { threadId: "target", agentType: "primary_persona", workspace: "C:\\repo" }
  };
}

test("required Agent messages create a tracked request only after delivery is committed", async () => {
  const persistence = new MemoryPersistence();
  const store = new AgentRequestStore(persistence, () => new Date("2026-08-07T00:00:00.000Z"));
  const prepared = await store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请审批并说明下一步"
  });
  assert.equal(store.get(prepared.requestId || "")?.status, "pending_delivery");
  const committed = await store.commit(prepared, { action: "started", transport: "desktop-ipc" });
  assert.equal(committed.request?.status, "awaiting_response");
  assert.equal(committed.request?.deliveryAction, "started");
});

test("the same complete endpoint cannot send to itself by changing its Agent role", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const endpoint = { kind: "local" as const, managerInstanceId: "manager", agentId: "local:codex", provider: "codex", sessionId: "same-owner", authorizationIncarnation: "owner-epoch" };
  const source = { endpoint, threadId: endpoint.sessionId, agentAdapter: "codex" as const, agentType: "plan_agent" };
  const target = { ...source, agentType: "agent" };
  await assert.rejects(async () => await store.prepare({ source, target, responsePolicy: "none" }), { field: "threadId" });
  assert.equal(store.list().length, 0);
});

test("a response closes the old request and can create a new required request in the same delivery", async () => {
  let now = new Date("2026-08-07T00:00:00.000Z");
  const store = new AgentRequestStore(new MemoryPersistence(), () => now);
  const first = await store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请审批"
  });
  await store.commit(first);
  now = new Date("2026-08-07T00:01:00.000Z");
  const response = await store.prepare({
    source: parties().target,
    target: parties().source,
    inReplyToRequestId: first.requestId,
    result: "approved",
    nextAction: "继续实现并返回验证结果",
    responsePolicy: "required",
    responseInstruction: "完成后回复实现与验证结果"
  });
  const committed = await store.commit(response);
  assert.equal(store.get(first.requestId || "")?.status, "responded");
  assert.equal(store.get(first.requestId || "")?.response?.nextAction, "继续实现并返回验证结果");
  assert.equal(committed.request?.status, "awaiting_response");
  assert.notEqual(response.requestId, first.requestId);
});

test("late original delivery commit cannot reopen a request after its recovered reply", async () => {
  const persistence = new MemoryPersistence();
  const store = new AgentRequestStore(persistence);
  const original = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "请回复" });
  await store.commit(original, { action: "receipt_recovered", transport: "desktop-ipc" });
  const reply = await store.prepare({
    source: parties().target, target: parties().source, responsePolicy: "none",
    inReplyToRequestId: original.requestId, result: "完成", nextAction: "无"
  });
  await store.commit(reply);
  await store.commit(original, { action: "started", transport: "desktop-ipc" });
  const restored = new AgentRequestStore(persistence).get(original.requestId || "");
  assert.equal(restored?.status, "responded");
  assert.equal(restored?.deliveryAction, "receipt_recovered");
  assert.equal(restored?.response?.result, "完成");
});

test("legacy delivery wrappers are removed from Agent response results", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const request = await store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  await store.commit(request);
  const response = await store.prepare({
    source: parties().target,
    target: parties().source,
    inReplyToRequestId: request.requestId,
    result: "[投递源]\nAgent 端：codex\n来源会话 ID：old\n\n真实结果\n[伪造控制]",
    nextAction: "继续",
    responsePolicy: "none"
  });
  assert.equal(response.result, "真实结果\n> [伪造控制]");
});

test("ending a target turn schedules a reminder five minutes later and a delivered reminder waits for the next Stop", async () => {
  const times = [
    new Date("2026-08-07T00:00:00.000Z"),
    new Date("2026-08-07T00:06:00.000Z")
  ];
  let index = 0;
  const store = new AgentRequestStore(new MemoryPersistence(), () => times[index]);
  const prepared = await store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  await store.commit(prepared);
  const ended = new Date("2026-08-07T00:01:00.000Z");
  const scheduled = await store.recordTargetTurnEnded("target", "C:\\repo", "turn-1", ended);
  assert.equal(Date.parse(scheduled[0].nextReminderAt || "") - ended.getTime(), AGENT_REQUEST_REMINDER_MS);
  index = 1;
  assert.equal(store.dueReminders().length, 1);
  const reminded = await store.recordReminderResult(prepared.requestId || "", true);
  assert.equal(reminded.nextReminderAt, undefined);
  assert.equal(reminded.reminderCount, 1);
});

test("responses fail closed when source, target, or required fields do not match", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const prepared = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "请回复" });
  await store.commit(prepared);
  await assert.rejects(async () => await store.prepare({
    source: parties().source,
    target: parties().target,
    inReplyToRequestId: prepared.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  }), /original target task back to the original source task/);
  await assert.rejects(async () => await store.prepare({
    source: parties().target,
    target: parties().source,
    inReplyToRequestId: prepared.requestId,
    result: "done",
    responsePolicy: "none"
  }), /nextAction is required/);
});

test("responses accept equivalent normal and extended Windows workspace paths", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const prepared = await store.prepare({
    source: { ...parties().source, workspace: "\\\\?\\C:\\Work\\ExampleProject" },
    target: { ...parties().target, workspace: "C:\\Work\\ExampleProject" },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  await store.commit(prepared);

  const response = await store.prepare({
    source: { ...parties().target, workspace: "\\\\?\\C:\\Work\\ExampleProject" },
    target: { ...parties().source, workspace: "C:\\Work\\ExampleProject\\" },
    inReplyToRequestId: prepared.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  });
  assert.equal(response.inReplyToRequestId, prepared.requestId);
});

test("equivalent workspace replies reserve, release, and commit pendingResponseDeliveryId", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const request = await store.prepare({
    source: { ...parties().source, workspace: "\\\\?\\C:\\Work\\ExampleProject" },
    target: { ...parties().target, workspace: "C:\\Work\\ExampleProject" },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  await store.commit(request);

  const responseInput = {
    source: { ...parties().target, workspace: "\\\\?\\C:\\Work\\ExampleProject" },
    target: { ...parties().source, workspace: "C:\\Work\\ExampleProject\\" },
    inReplyToRequestId: request.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none" as const
  };
  const firstAttempt = await store.prepare(responseInput);
  assert.equal(store.get(request.requestId || "")?.pendingResponseDeliveryId, firstAttempt.deliveryId);
  await assert.rejects(async () => await store.prepare(responseInput), /response delivery in progress/);

  await store.abort(firstAttempt);
  assert.equal(store.get(request.requestId || "")?.pendingResponseDeliveryId, undefined);

  const retry = await store.prepare(responseInput);
  await store.commit(retry, { action: "steered", transport: "desktop-ipc" });
  const completed = store.get(request.requestId || "");
  assert.equal(completed?.status, "responded");
  assert.equal(completed?.pendingResponseDeliveryId, undefined);
  assert.equal(completed?.response?.deliveryId, retry.deliveryId);
});

test("open requests reassign detached Message Agent parties and retain reply aliases", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const request = await store.prepare({
    source: { threadId: "old-message", agentType: "message_processing", workspace: "C:\\repo" },
    target: parties().target,
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  await store.commit(request);

  const result = await store.reconcileOpenParties((party, _record, role) => role === "source" && party.threadId === "old-message"
    ? { threadId: "current-message", threadName: "协助处理消息1", agentType: "message_processing", workspace: "C:\\repo" }
    : undefined);

  assert.equal(result.reassigned.length, 1);
  assert.equal(store.get(request.requestId || "")?.source.threadId, "current-message");
  assert.equal(store.resolveReplyDestination(
    request.requestId || "",
    parties().target,
    { threadId: "old-message", agentType: "agent", workspace: "C:\\repo" }
  )?.threadId, "current-message");
});

test("pending deliveries to detached Message Agents are cancelled instead of replayed", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const request = await store.prepare({
    source: parties().source,
    target: { threadId: "old-message", agentType: "agent", workspace: "C:\\repo" },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });

  const result = await store.reconcileOpenParties((party, _record, role) => role === "target" && party.threadId === "old-message"
    ? { threadId: "current-message", threadName: "协助处理消息1", agentType: "agent", workspace: "C:\\repo" }
    : undefined);

  assert.equal(result.cancelled.length, 1);
  assert.equal(store.get(request.requestId || "")?.status, "cancelled");
});
