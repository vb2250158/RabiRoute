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

test("required Agent messages create a tracked request only after delivery is committed", () => {
  const persistence = new MemoryPersistence();
  const store = new AgentRequestStore(persistence, () => new Date("2026-08-07T00:00:00.000Z"));
  const prepared = store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请审批并说明下一步"
  });
  assert.equal(store.get(prepared.requestId || "")?.status, "pending_delivery");
  const committed = store.commit(prepared, { action: "started", transport: "desktop-ipc" });
  assert.equal(committed.request?.status, "awaiting_response");
  assert.equal(committed.request?.deliveryAction, "started");
});

test("a response closes the old request and can create a new required request in the same delivery", () => {
  let now = new Date("2026-08-07T00:00:00.000Z");
  const store = new AgentRequestStore(new MemoryPersistence(), () => now);
  const first = store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请审批"
  });
  store.commit(first);
  now = new Date("2026-08-07T00:01:00.000Z");
  const response = store.prepare({
    source: parties().target,
    target: parties().source,
    inReplyToRequestId: first.requestId,
    result: "approved",
    nextAction: "继续实现并返回验证结果",
    responsePolicy: "required",
    responseInstruction: "完成后回复实现与验证结果"
  });
  const committed = store.commit(response);
  assert.equal(store.get(first.requestId || "")?.status, "responded");
  assert.equal(store.get(first.requestId || "")?.response?.nextAction, "继续实现并返回验证结果");
  assert.equal(committed.request?.status, "awaiting_response");
  assert.notEqual(response.requestId, first.requestId);
});

test("ending a target turn schedules a reminder five minutes later and a delivered reminder waits for the next Stop", () => {
  const times = [
    new Date("2026-08-07T00:00:00.000Z"),
    new Date("2026-08-07T00:06:00.000Z")
  ];
  let index = 0;
  const store = new AgentRequestStore(new MemoryPersistence(), () => times[index]);
  const prepared = store.prepare({
    ...parties(),
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  store.commit(prepared);
  const ended = new Date("2026-08-07T00:01:00.000Z");
  const scheduled = store.recordTargetTurnEnded("target", "C:\\repo", "turn-1", ended);
  assert.equal(Date.parse(scheduled[0].nextReminderAt || "") - ended.getTime(), AGENT_REQUEST_REMINDER_MS);
  index = 1;
  assert.equal(store.dueReminders().length, 1);
  const reminded = store.recordReminderResult(prepared.requestId || "", true);
  assert.equal(reminded.nextReminderAt, undefined);
  assert.equal(reminded.reminderCount, 1);
});

test("responses fail closed when source, target, or required fields do not match", () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const prepared = store.prepare({ ...parties(), responsePolicy: "required", responseInstruction: "请回复" });
  store.commit(prepared);
  assert.throws(() => store.prepare({
    source: parties().source,
    target: parties().target,
    inReplyToRequestId: prepared.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  }), /original target task back to the original source task/);
  assert.throws(() => store.prepare({
    source: parties().target,
    target: parties().source,
    inReplyToRequestId: prepared.requestId,
    result: "done",
    responsePolicy: "none"
  }), /nextAction is required/);
});

test("responses accept equivalent normal and extended Windows workspace paths", () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const prepared = store.prepare({
    source: { ...parties().source, workspace: "\\\\?\\C:\\Data\\CottonProject\\RabiRoute" },
    target: { ...parties().target, workspace: "C:\\Data\\CottonProject\\RabiRoute" },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  store.commit(prepared);

  const response = store.prepare({
    source: { ...parties().target, workspace: "\\\\?\\C:\\Data\\CottonProject\\RabiRoute" },
    target: { ...parties().source, workspace: "C:\\Data\\CottonProject\\RabiRoute\\" },
    inReplyToRequestId: prepared.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none"
  });
  assert.equal(response.inReplyToRequestId, prepared.requestId);
});

test("equivalent workspace replies reserve, release, and commit pendingResponseDeliveryId", () => {
  const store = new AgentRequestStore(new MemoryPersistence());
  const request = store.prepare({
    source: { ...parties().source, workspace: "\\\\?\\C:\\Data\\CottonProject\\RabiRoute" },
    target: { ...parties().target, workspace: "C:\\Data\\CottonProject\\RabiRoute" },
    responsePolicy: "required",
    responseInstruction: "请回复"
  });
  store.commit(request);

  const responseInput = {
    source: { ...parties().target, workspace: "\\\\?\\C:\\Data\\CottonProject\\RabiRoute" },
    target: { ...parties().source, workspace: "C:\\Data\\CottonProject\\RabiRoute\\" },
    inReplyToRequestId: request.requestId,
    result: "done",
    nextAction: "none",
    responsePolicy: "none" as const
  };
  const firstAttempt = store.prepare(responseInput);
  assert.equal(store.get(request.requestId || "")?.pendingResponseDeliveryId, firstAttempt.deliveryId);
  assert.throws(() => store.prepare(responseInput), /response delivery in progress/);

  store.abort(firstAttempt);
  assert.equal(store.get(request.requestId || "")?.pendingResponseDeliveryId, undefined);

  const retry = store.prepare(responseInput);
  store.commit(retry, { action: "steered", transport: "desktop-ipc" });
  const completed = store.get(request.requestId || "");
  assert.equal(completed?.status, "responded");
  assert.equal(completed?.pendingResponseDeliveryId, undefined);
  assert.equal(completed?.response?.deliveryId, retry.deliveryId);
});
