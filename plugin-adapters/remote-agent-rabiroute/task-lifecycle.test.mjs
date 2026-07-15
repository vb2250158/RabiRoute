import assert from "node:assert/strict";
import test from "node:test";
import { activeTurnIdFromThread, RemoteTaskLifecycle, replyTextFromCompletedTurn } from "./task-lifecycle.mjs";

function harness() {
  const events = [];
  return { events, lifecycle: new RemoteTaskLifecycle({ emit: (event) => events.push(event) }) };
}

test("app-server completion closes a registered remote task once", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  assert.equal(lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  }), 1);
  assert.equal(events.at(-1)?.status, "completed");
  assert.equal(lifecycle.send({ taskId: "task-1", status: "completed", summary: "duplicate callback" }), false);
  assert.equal(events.length, 1);
});

test("completed turns return final agent messages without requiring callback network", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  lifecycle.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "agentMessage", phase: "commentary", text: "working" },
          { type: "agentMessage", phase: "final_answer", text: "first final section" },
          { type: "agentMessage", phase: "final_answer", text: "second final section" }
        ]
      }
    }
  });
  assert.equal(events.at(-1)?.summary, "first final section\n\nsecond final section");
  assert.equal(events.at(-1)?.data?.replyText, "first final section\n\nsecond final section");
});

test("completed turn reply extraction falls back to the last agent message and truncates", () => {
  assert.equal(replyTextFromCompletedTurn({ items: [
    { type: "agentMessage", phase: "commentary", text: "older" },
    { type: "agentMessage", text: "latest" }
  ] }), "latest");
  const truncated = replyTextFromCompletedTurn({ items: [
    { type: "agentMessage", phase: "final_answer", text: "x".repeat(100) }
  ] }, 40);
  assert.equal(truncated.length, 40);
  assert.match(truncated, /truncated by RabiRoute/);
});

test("failed and interrupted turns close their tasks as failed", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "failed-task", turnId: "failed-turn", threadId: "thread-1" });
  lifecycle.registerTurn({ taskId: "interrupted-task", turnId: "interrupted-turn", threadId: "thread-2" });
  lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "failed-turn", status: "failed", error: { message: "boom" } } }
  });
  lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-2", turn: { id: "interrupted-turn", status: "interrupted" } }
  });
  assert.deepEqual(events.map((event) => event.status), ["failed", "failed"]);
  assert.equal(events[0].error, "boom");
  assert.match(events[1].error, /interrupted/);
});

test("unknown turn/completed statuses fail closed", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "unknown-task", turnId: "unknown-turn", threadId: "thread-1" });
  lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "unknown-turn", status: "mystery" } }
  });
  assert.equal(events.at(-1)?.status, "failed");
  assert.match(events.at(-1)?.error, /mystery/);
});

test("a completion notification received before turn registration is reconciled", () => {
  const { events, lifecycle } = harness();
  lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
  assert.equal(lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" }), false);
  assert.equal(events.at(-1)?.status, "completed");
});

test("app-server exit fails all active tasks and releases terminal waits once", async () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  lifecycle.registerTurn({ taskId: "task-2", turnId: "turn-2", threadId: "thread-2" });
  const taskWait = lifecycle.waitForTaskTerminal("task-1", 1000);
  const turnWait = lifecycle.waitForTurnTerminal({ turnId: "turn-1", threadId: "thread-1", timeoutMs: 1000 });
  assert.equal(lifecycle.handleAppServerExit(new Error("process exited")), 2);
  assert.deepEqual(events.map((event) => event.status), ["failed", "failed"]);
  assert.equal((await taskWait).status, "failed");
  assert.equal((await turnWait).turnStatus, "appServerExit");
  assert.equal(lifecycle.handleAppServerExit(new Error("duplicate exit")), 0);
  assert.equal(events.length, 2);
});

test("an unscoped terminal app-server error fails every active task", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  lifecycle.registerTurn({ taskId: "task-2", turnId: "turn-2", threadId: "thread-2" });
  assert.equal(lifecycle.handleNotification({
    method: "error",
    params: { willRetry: false, error: { message: "runtime failure" } }
  }), 2);
  assert.deepEqual(events.map((event) => event.error), ["runtime failure", "runtime failure"]);
});

test("a thread systemError fails active turns for that thread", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  lifecycle.handleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "systemError" } }
  });
  assert.equal(events.at(-1)?.status, "failed");
  assert.match(events.at(-1)?.error, /systemError/);
});

test("callback completion wins and later app-server completion is deduplicated", () => {
  const { events, lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  assert.equal(lifecycle.send({ taskId: "task-1", status: "completed", summary: "callback summary" }), true);
  assert.equal(lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  }), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "callback summary");
});

test("task and resumed-turn waits settle on terminal notifications", async () => {
  const { lifecycle } = harness();
  lifecycle.registerTurn({ taskId: "task-1", turnId: "turn-1", threadId: "thread-1" });
  const taskWait = lifecycle.waitForTaskTerminal("task-1", 1000);
  const turnWait = lifecycle.waitForTurnTerminal({ turnId: "turn-1", threadId: "thread-1", timeoutMs: 1000 });
  lifecycle.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
  assert.deepEqual(await taskWait, { status: "completed" });
  assert.equal((await turnWait).status, "completed");
});

test("resumed-turn wait is bounded", async () => {
  const { lifecycle } = harness();
  const result = await lifecycle.waitForTurnTerminal({ turnId: "stuck-turn", threadId: "thread-1", timeoutMs: 5 });
  assert.equal(result.status, "timeout");
});

test("activeTurnIdFromThread finds only the latest in-progress turn", () => {
  assert.equal(activeTurnIdFromThread({ turns: [
    { id: "done", status: "completed" },
    { id: "active", status: "inProgress" }
  ] }), "active");
  assert.equal(activeTurnIdFromThread({ turns: [{ id: "done", status: "completed" }] }), "");
});
