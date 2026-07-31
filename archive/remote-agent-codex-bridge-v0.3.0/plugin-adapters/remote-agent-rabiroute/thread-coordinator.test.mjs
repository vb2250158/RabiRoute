import assert from "node:assert/strict";
import test from "node:test";
import { CodexThreadCoordinator } from "./thread-coordinator.mjs";

function coordinatorHarness({ resumedThread, terminalResult = { status: "completed", turnStatus: "completed" } }) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: [{ id: "existing", name: "Remote", cwd: "/work", updatedAt: 2 }] };
    if (method === "thread/resume") return { thread: resumedThread };
    if (method === "thread/start") return { thread: { id: "fresh" } };
    if (method === "thread/name/set") return {};
    throw new Error(`unexpected method ${method}`);
  };
  const waits = [];
  const lifecycle = {
    waitForTurnTerminal: async (input) => {
      waits.push(input);
      return terminalResult;
    }
  };
  const busy = [];
  return {
    calls,
    waits,
    busy,
    coordinator: new CodexThreadCoordinator({
      request,
      resolveModel: async () => "default-model",
      lifecycle,
      resumedTurnWaitMs: 25,
      developerInstructions: "instructions",
      onBusyThread: (value) => busy.push(value)
    })
  };
}

test("an in-progress resumed turn reaches terminal before its thread is reused", async () => {
  const harness = coordinatorHarness({ resumedThread: { turns: [{ id: "active", status: "inProgress" }] } });
  assert.equal(await harness.coordinator.ensureThread("Remote", "/work"), "existing");
  assert.deepEqual(harness.waits, [{ turnId: "active", threadId: "existing", timeoutMs: 25 }]);
  assert.equal(harness.calls.some((call) => call.method === "thread/start"), false);
});

test("a stuck resumed turn causes a fresh independent thread", async () => {
  const harness = coordinatorHarness({
    resumedThread: { turns: [{ id: "stuck", status: "inProgress" }] },
    terminalResult: { status: "timeout", turnStatus: "timeout" }
  });
  assert.equal(await harness.coordinator.ensureThread("Remote", "/work"), "fresh");
  assert.equal(harness.busy.length, 1);
  assert.ok(harness.calls.some((call) => call.method === "thread/start"));
  assert.ok(harness.calls.some((call) => call.method === "thread/name/set" && call.params.threadId === "fresh"));
});

test("an idle resumed thread is reused without waiting", async () => {
  const harness = coordinatorHarness({ resumedThread: { turns: [{ id: "done", status: "completed" }] } });
  assert.equal(await harness.coordinator.ensureThread("Remote", "/work"), "existing");
  assert.equal(harness.waits.length, 0);
});
