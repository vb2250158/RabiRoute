import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_REQUEST_REMINDER_MS,
  AgentRequestStore,
  type AgentRequestPersistence
} from "./store.js";

class MemoryPersistence implements AgentRequestPersistence {
  value: unknown;
  writes = 0;
  read(): unknown { return this.value; }
  write(state: unknown): void { this.writes++; this.value = structuredClone(state); }
}

function parties() {
  return {
    source: { threadId: "source", agentType: "plan_agent", workspace: "C:\\repo" },
    target: { threadId: "target", agentType: "primary_persona", workspace: "C:\\repo" }
  };
}

test("Stop metadata source filters keep same-ID remote owners separate without ledger writes", async () => {
  const persistence = new MemoryPersistence(), store = new AgentRequestStore(persistence);
  const ids: string[] = [];
  for (const instanceId of [undefined, "pc-one", "pc-two"]) {
    const prepared = await store.prepare({ ...parties(), target: { ...parties().target,
      ...(instanceId ? { endpoint: { kind: "instance" as const, managerInstanceId: "manager", instanceId, nodeId: instanceId, agentId: "native", provider: "codex", sessionId: "target", authorizationIncarnation: "epoch" } } : {}) },
      responsePolicy: "required", responseInstruction: "Return actual evidence" });
    await store.commit(prepared); ids.push(prepared.requestId!);
  }
  const writes = persistence.writes;
  assert.deepEqual(store.unansweredTargetRequestIds("target", "C:/repo", party => !party.endpoint), [ids[0]]);
  assert.deepEqual(store.unansweredTargetRequestIds("target", "C:/repo", party => party.endpoint?.instanceId === "pc-one"), [ids[1]]);
  assert.equal(store.hasManagedSession("target", "C:/repo", party => party.endpoint?.instanceId === "pc-two"), true);
  assert.equal(store.hasManagedSession("target", "C:/repo", party => party.endpoint?.instanceId === "missing"), false);
  assert.equal(persistence.writes, writes);
});

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

test("a connected sender may address its own task without a source-role restriction", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const endpoint = { kind: "local" as const, managerInstanceId: "manager", agentId: "local:codex", provider: "codex", sessionId: "same-owner", authorizationIncarnation: "owner-epoch" };
  const source = { endpoint, threadId: endpoint.sessionId, agentAdapter: "codex" as const, agentType: "plan_agent" };
  const target = { ...source, agentType: "agent" };
  const preparation = await store.prepare({ source, target, responsePolicy: "none" });
  assert.equal(preparation.source.threadId, endpoint.sessionId);
  assert.equal(preparation.target.threadId, endpoint.sessionId);
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

test("responses retain their original target and required result fields without restricting the sender", async () => {
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
  }), /back to the original source task/);
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


test("a connected delegate can reply with its actual source attribution and unrelated source workspace", async () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const original = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "Return evidence" });
  await store.commit(original);
  const actualSender = { threadId: "connected-delegate", agentType: "custom_sender", workspace: "D:/separate-owner" };
  assert.deepEqual(store.resolveReplyDestination(original.requestId!, actualSender, parties().source), { ...parties().source, threadName: undefined });
  const response = await store.prepare({ source: actualSender, target: parties().source, responsePolicy: "none",
    inReplyToRequestId: original.requestId, result: "Delegate result", nextAction: "Continue" });
  await store.commit(response);
  assert.deepEqual(store.get(original.requestId!)?.response?.by, { ...actualSender, threadName: undefined });
});

test("Stop reads exact target/workspace unanswered IDs without persisting or changing delivery state", async () => {
  const persistence = new MemoryPersistence();
  const store = new AgentRequestStore(persistence);
  const accepted = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "Return exact result" });
  await store.commit(accepted);
  const outside = await store.prepare({ ...parties(), target: { ...parties().target, workspace: "C:/other" }, responsePolicy: "required", responseInstruction: "Other workspace" });
  await store.commit(outside);
  const pending = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "Not delivered" });
  const terminal = await store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "Cancelled" });
  await store.commit(terminal); await store.cancel(terminal.requestId!);
  const before = JSON.stringify(persistence.value), writesBefore = persistence.writes;
  assert.deepEqual(store.unansweredTargetRequestIds("target", "\\\\?\\C:\\repo"), [accepted.requestId]);
  assert.deepEqual(store.unansweredTargetRequestIds("different-target", "C:/repo"), []);
  assert.deepEqual(store.unansweredTargetRequestIds("target", "C:/other"), [outside.requestId]);
  assert.equal(store.get(pending.requestId!)?.status, "pending_delivery");
  assert.equal(JSON.stringify(persistence.value), before);
  assert.equal(persistence.writes, writesBefore);
});

test("Stop metadata query avoids rewriting a representative 5400-request history", async () => {
  const persistence = new MemoryPersistence();
  const seed = new AgentRequestStore(persistence);
  const prepared = await seed.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "Return actual result" });
  await seed.commit(prepared);
  const raw = JSON.parse(JSON.stringify(persistence.value));
  const example = raw.requests[prepared.requestId!];
  raw.requests = {};
  for (let i = 0; i < 5400; i++) raw.requests["request-scale-" + i] = { ...example, id: "request-scale-" + i,
    deliveryId: "scale-delivery-" + i, target: { ...example.target, threadId: i === 2700 ? "exact-target" : "other-target" } };
  const reader = new MemoryPersistence();reader.value = raw;
  const store = new AgentRequestStore(reader);
  const before = JSON.stringify(reader.value), writesBefore = reader.writes, started = performance.now();
  assert.deepEqual(store.unansweredTargetRequestIds("exact-target", "C:/repo"), ["request-scale-2700"]);
  console.log("Stop 5400 metadata-only query ms:", performance.now() - started);
  assert.equal(JSON.stringify(reader.value), before);
  assert.equal(reader.writes, writesBefore);
});
