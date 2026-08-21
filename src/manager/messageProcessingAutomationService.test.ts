import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRequestRecord } from "../agentRequests/store.js";
import {
  MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS,
  MessageProcessingAutomationService
} from "./messageProcessingAutomationService.js";

type FakeTimer = NodeJS.Timeout & {
  id: number;
  cleared: boolean;
  fired: boolean;
};

type ScheduledTimer = {
  callback: () => void;
  delayMs: number;
  timer: FakeTimer;
};

function fakeTimers() {
  const scheduled: ScheduledTimer[] = [];
  let nextId = 1;
  return {
    scheduled,
    schedule(callback: () => void, delayMs: number): NodeJS.Timeout {
      const timer = {
        id: nextId++,
        cleared: false,
        fired: false,
        unref() { return this; }
      } as unknown as FakeTimer;
      scheduled.push({ callback, delayMs, timer });
      return timer;
    },
    clear(timer: NodeJS.Timeout): void {
      (timer as FakeTimer).cleared = true;
    },
    fire(entry: ScheduledTimer): void {
      entry.timer.fired = true;
      entry.callback();
    },
    active(): ScheduledTimer[] {
      return scheduled.filter(entry => !entry.timer.cleared && !entry.timer.fired);
    }
  };
}

function request(
  id: string,
  nextReminderAt: string | undefined,
  status: AgentRequestRecord["status"] = "awaiting_response"
): AgentRequestRecord {
  return {
    id,
    deliveryId: `delivery-${id}`,
    status,
    source: { threadId: `source-${id}`, agentType: "primary_persona" },
    target: { threadId: `target-${id}`, agentType: "message_processing" },
    responseInstruction: "Return the result.",
    createdAt: new Date(0).toISOString(),
    ...(nextReminderAt ? { nextReminderAt } : {}),
    reminderCount: 0,
    updatedAt: new Date(0).toISOString()
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("start restores awaiting Agent requests and remains idempotent", () => {
  const timers = fakeTimers();
  const due = request("due", new Date(2_000).toISOString());
  const completed = request("completed", new Date(2_000).toISOString(), "responded");
  const missingDeadline = request("missing", undefined);
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [due, completed, missingDeadline],
    getRequest: () => undefined,
    deliverReminder: () => {},
    now: () => 1_000,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.start();

  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0]?.delayMs, 1_000);
});

test("schedule keeps one timer per request and stale timer callbacks do nothing", async () => {
  const timers = fakeTimers();
  const delivered: string[] = [];
  let current = request("request-a", new Date(2_000).toISOString());
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: item => {
      delivered.push(item.id);
      current = { ...current, nextReminderAt: undefined };
    },
    now: () => 2_000,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  const stale = timers.active()[0]!;
  current = { ...current, nextReminderAt: new Date(2_000).toISOString() };
  service.schedule(current);
  const active = timers.active()[0]!;

  assert.equal(stale.timer.cleared, true);
  assert.equal(timers.active().length, 1);

  timers.fire(stale);
  timers.fire(active);
  await flushAsync();

  assert.deepEqual(delivered, ["request-a"]);
  assert.equal(timers.active().length, 0);
});

test("long delays use the Node timeout ceiling and recheck before delivery", async () => {
  const timers = fakeTimers();
  const delivered: string[] = [];
  const current = request(
    "long-delay",
    new Date(MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS + 5_000).toISOString()
  );
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: item => { delivered.push(item.id); },
    now: () => 0,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  const first = timers.active()[0]!;
  assert.equal(first.delayMs, MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS);

  timers.fire(first);
  await flushAsync();

  assert.deepEqual(delivered, []);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0]?.delayMs, MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS);
});

test("delivery errors call onError and schedule the latest stored retry", async () => {
  const timers = fakeTimers();
  let now = 1_000;
  let current = request("retry", new Date(now).toISOString());
  const errors: string[] = [];
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: async () => { throw new Error("Desktop unavailable"); },
    onError: (_item, error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      current = { ...current, nextReminderAt: new Date(now + 5_000).toISOString() };
    },
    now: () => now,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  timers.fire(timers.active()[0]!);
  await flushAsync();

  assert.deepEqual(errors, ["Desktop unavailable"]);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0]?.delayMs, 5_000);
});

test("stop clears timers and invalidates callbacks from the stopped generation", async () => {
  const timers = fakeTimers();
  const delivered: string[] = [];
  const current = request("stopped", new Date(0).toISOString());
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: item => { delivered.push(item.id); },
    now: () => 0,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  const stale = timers.active()[0]!;
  service.stop();
  timers.fire(stale);
  await flushAsync();

  assert.equal(stale.timer.cleared, true);
  assert.deepEqual(delivered, []);
  assert.equal(timers.active().length, 0);
});

test("an async delivery completed after stop cannot report or reschedule", async () => {
  const timers = fakeTimers();
  let rejectDelivery!: (error: Error) => void;
  const errors: string[] = [];
  const current = request("in-flight", new Date(0).toISOString());
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: () => new Promise<void>((_resolve, reject) => { rejectDelivery = reject; }),
    onError: (_item, error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    now: () => 0,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  timers.fire(timers.active()[0]!);
  await flushAsync();
  service.stop();
  rejectDelivery(new Error("late failure"));
  await flushAsync();

  assert.deepEqual(errors, []);
  assert.equal(timers.active().length, 0);
});

test("refresh removes missing requests and rearms current records", () => {
  const timers = fakeTimers();
  let current = [request("first", new Date(1_000).toISOString())];
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => current,
    getRequest: requestId => current.find(item => item.id === requestId),
    deliverReminder: () => {},
    now: () => 0,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  const stale = timers.active()[0]!;
  current = [request("second", new Date(2_000).toISOString())];
  service.refresh();

  assert.equal(stale.timer.cleared, true);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0]?.delayMs, 2_000);
});


test("stop waits for an in-flight reminder delivery", async () => {
  const timers = fakeTimers();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = request("drain", new Date(0).toISOString());
  const service = new MessageProcessingAutomationService({
    listExistingRequests: () => [],
    getRequest: () => current,
    deliverReminder: () => gate,
    now: () => 0,
    scheduleTimer: timers.schedule,
    clearTimer: timers.clear
  });

  service.start();
  service.schedule(current);
  timers.fire(timers.active()[0]!);
  await flushAsync();
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await flushAsync();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(stopped, true);
});
