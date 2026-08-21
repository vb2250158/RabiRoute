import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduledAutomationTask } from "../automation/personaAutomationRuntime.js";
import { createMessageAdapterRuntime } from "../runtime/messageAdapterRuntime.js";
import {
  createHeartbeatAdapter,
  type HeartbeatAdapterDependencies
} from "./heartbeatAdapter.js";
import type { MessageAdapterDefinition, MessageAdapterDispose } from "./messageAdapter.js";

type FakeTimerRecord = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

function scheduledTask(index: number): ScheduledAutomationTask {
  return {
    route: {
      id: `route-${index}`,
      name: `Route ${index}`,
      enabled: true
    },
    rule: {
      id: `rule-${index}`,
      name: `Rule ${index}`,
      enabled: true,
      trigger: {
        type: "schedule",
        schedule: {
          id: `schedule-${index}`,
          name: `Schedule ${index}`,
          enabled: true,
          type: "interval",
          intervalSeconds: 1
        }
      },
      action: {
        type: "deliver_agent",
        message: `tick-${index}`,
        template: ""
      }
    }
  } as unknown as ScheduledAutomationTask;
}

function fakeTimers() {
  const records = new Map<NodeJS.Timeout, FakeTimerRecord>();
  const active = new Set<NodeJS.Timeout>();
  let createdCount = 0;
  let clearedCount = 0;

  return {
    records,
    active,
    get createdCount() { return createdCount; },
    get clearedCount() { return clearedCount; },
    setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
      const timer = { id: ++createdCount } as unknown as NodeJS.Timeout;
      records.set(timer, { callback, delayMs, cleared: false });
      active.add(timer);
      return timer;
    },
    clearTimer(timer: NodeJS.Timeout): void {
      const record = records.get(timer);
      if (!record || record.cleared) return;
      record.cleared = true;
      active.delete(timer);
      clearedCount += 1;
    },
    fire(timer: NodeJS.Timeout): void {
      const record = records.get(timer);
      if (!record || record.cleared) return;
      active.delete(timer);
      record.callback();
    }
  };
}

function readStatus(dataDir: string) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "gateway-status.json"), "utf8"));
}

function definition(dependencies: HeartbeatAdapterDependencies): MessageAdapterDefinition {
  return {
    manifest: {
      type: "heartbeat",
      label: "定时触发",
      host: "gateway",
      transport: "timer",
      lifecycle: "fiber"
    },
    create: () => createHeartbeatAdapter(dependencies)
  };
}

test("Heartbeat disposer clears timers and stale callbacks cannot run or rearm", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-heartbeat-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const timers = fakeTimers();
  let nowMs = Date.parse("2026-08-21T00:00:00.000Z");
  let runCount = 0;
  const adapter = createHeartbeatAdapter({
    collectTasks: () => [scheduledTask(1), scheduledTask(2)],
    dataDir: () => dataDir,
    now: () => new Date(nowMs),
    nextScheduleTime: (_schedule, now, options) => new Date(
      (options?.lastScheduledAt ?? now ?? new Date(0)).getTime() + 1000
    ),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    runTask: () => { runCount += 1; }
  });

  const dispose = await adapter.start() as MessageAdapterDispose;
  assert.equal(typeof dispose, "function");
  assert.equal(timers.active.size, 2);
  assert.equal(timers.createdCount, 2);
  assert.equal(readStatus(dataDir).messageAdapters.heartbeat.status, "running");

  const firstTimer = [...timers.active][0];
  nowMs += 1000;
  timers.fire(firstTimer);
  assert.equal(runCount, 1);
  assert.equal(timers.active.size, 2);
  assert.equal(timers.createdCount, 3);

  const staleCallback = timers.records.get([...timers.active][0])?.callback;
  await dispose();
  assert.equal(timers.active.size, 0);
  assert.equal(timers.clearedCount, 2);
  const disabled = readStatus(dataDir);
  assert.equal(disabled.messageAdapters.heartbeat.status, "disabled");
  assert.equal(disabled.messageAdapters.heartbeat.enabled, false);
  assert.equal(disabled.heartbeat.enabled, false);
  assert.equal(disabled.heartbeat.nextTickAt, undefined);

  const createdBeforeStaleCallback = timers.createdCount;
  staleCallback?.();
  assert.equal(runCount, 1);
  assert.equal(timers.createdCount, createdBeforeStaleCallback);
});

test("Heartbeat Fiber supports repeated mounting without accumulating timers", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-heartbeat-runtime-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const timers = fakeTimers();
  let nowMs = Date.parse("2026-08-21T00:00:00.000Z");
  const dependencies: HeartbeatAdapterDependencies = {
    collectTasks: () => [scheduledTask(1)],
    dataDir: () => dataDir,
    now: () => new Date(nowMs),
    nextScheduleTime: (_schedule, now, options) => new Date(
      (options?.lastScheduledAt ?? now ?? new Date(0)).getTime() + 1000
    ),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    runTask: () => { nowMs += 1000; }
  };
  const runtime = await createMessageAdapterRuntime([definition(dependencies)]);
  t.after(() => runtime.dispose());

  assert.deepEqual(runtime.registry.listManifests(), [definition(dependencies).manifest]);

  const first = await runtime.mount("heartbeat");
  assert.equal(timers.active.size, 1);
  await first.dispose();
  assert.equal(timers.active.size, 0);

  const second = await runtime.mount("heartbeat");
  assert.equal(timers.active.size, 1);
  await second.dispose();
  assert.equal(timers.active.size, 0);
  assert.equal(timers.createdCount, 2);
  assert.equal(timers.clearedCount, 2);
  assert.equal(readStatus(dataDir).messageAdapters.heartbeat.status, "disabled");
});

test("Heartbeat activation failure clears timers created before the failure", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-heartbeat-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const timers = fakeTimers();
  let setTimerCalls = 0;
  const adapter = createHeartbeatAdapter({
    collectTasks: () => [scheduledTask(1), scheduledTask(2)],
    dataDir: () => dataDir,
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    nextScheduleTime: (_schedule, now) => new Date((now ?? new Date(0)).getTime() + 1000),
    setTimer(callback, delayMs) {
      setTimerCalls += 1;
      if (setTimerCalls === 2) throw new Error("timer activation failed");
      return timers.setTimer(callback, delayMs);
    },
    clearTimer: timers.clearTimer,
    runTask: () => {}
  });

  assert.throws(() => adapter.start(), /timer activation failed/);
  assert.equal(timers.active.size, 0);
  assert.equal(timers.clearedCount, 1);
  const status = readStatus(dataDir);
  assert.equal(status.messageAdapters.heartbeat.status, "error");
  assert.equal(status.heartbeat.enabled, false);
});
