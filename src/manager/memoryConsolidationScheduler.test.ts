import assert from "node:assert/strict";
import test from "node:test";
import { MemoryConsolidationScheduler } from "./memoryConsolidationScheduler.js";

test("memory consolidation scheduler delivers a due run once and schedules the next future deadline", async () => {
  const delivered: string[] = [];
  const deadlines: number[] = [];
  let requestedRunId: string | undefined = "run-due";

  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [
      { gatewayId: "route-a", roleKey: "role-a", roleDir: "C:/roles/a" },
      { gatewayId: "route-a-duplicate", roleKey: "role-a", roleDir: "C:/roles/a" },
      { gatewayId: "route-b", roleKey: "role-b", roleDir: "C:/roles/b" }
    ],
    requestDueRun: target => target.roleKey === "role-a" && requestedRunId
      ? { runId: requestedRunId }
      : null,
    nextTriggerAt: target => target.roleKey === "role-b" ? 20_000 : undefined,
    deliver: async (_target, run) => { delivered.push(run.runId); },
    scheduleDeadline: (_callback, delayMs) => {
      deadlines.push(delayMs);
      return { unref() {} } as NodeJS.Timeout;
    },
    clearDeadline: () => {},
    now: () => 10_000
  });

  await scheduler.runOnce();
  await scheduler.runOnce();

  assert.deepEqual(delivered, ["run-due"]);
  assert.deepEqual(deadlines, [10_000, 10_000]);

  requestedRunId = "run-next";
  scheduler.noteRunCompleted("run-due");
  await scheduler.runOnce();
  assert.deepEqual(delivered, ["run-due", "run-next"]);
});

test("memory consolidation scheduler retries a run after delivery failure", async () => {
  let attempts = 0;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleKey: "role-a", roleDir: "C:/roles/a" }],
    requestDueRun: () => ({ runId: "run-due" }),
    nextTriggerAt: () => undefined,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Desktop unavailable");
    },
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {},
    now: () => 10_000,
    retryDelayMs: 1_000
  });

  await scheduler.runOnce();
  await scheduler.runOnce();

  assert.equal(attempts, 2);
});

test("memory consolidation scheduler does not redeliver a run already accepted before Manager restart", async () => {
  let attempts = 0;
  const scheduler = new MemoryConsolidationScheduler({
    listTargets: () => [{ gatewayId: "route-a", roleKey: "role-a", roleDir: "C:/roles/a" }],
    requestDueRun: () => ({ runId: "run-delivered", delivered: true }),
    nextTriggerAt: () => undefined,
    deliver: async () => { attempts += 1; },
    scheduleDeadline: () => ({ unref() {} } as NodeJS.Timeout),
    clearDeadline: () => {}
  });

  await scheduler.runOnce();

  assert.equal(attempts, 0);
});
