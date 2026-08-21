import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeCallbackReminderService,
  MAX_KNOWLEDGE_CALLBACK_REMINDER_DELAY_MS
} from "./knowledgeCallbackReminderService.js";

type TestRecord = {
  id: string;
  knowledgeCallbackDueAt?: string;
  pending: boolean;
};

type FakeTimer = {
  callback: () => void | Promise<void>;
  delayMs: number;
  cleared: boolean;
};

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function createTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    scheduleTimer(callback: () => void | Promise<void>, delayMs: number): FakeTimer {
      let timer!: FakeTimer;
      timer = {
        callback: () => {
          timer.cleared = true;
          return callback();
        },
        delayMs,
        cleared: false
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer: FakeTimer): void {
      timer.cleared = true;
    },
    active(): FakeTimer[] {
      return timers.filter(timer => !timer.cleared);
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

test("start mounts existing reminders and schedule refreshes one record with bounded delays", async () => {
  const now = 10_000;
  const timerHarness = createTimers();
  const due = { id: "due", knowledgeCallbackDueAt: iso(now + 1_000), pending: true };
  const invalid = { id: "invalid", knowledgeCallbackDueAt: "not-a-date", pending: true };
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [due, invalid],
    getRecord: () => undefined,
    isPending: record => record.pending,
    deliverReminder: () => {},
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();

  assert.equal(timerHarness.active().length, 1);
  assert.equal(timerHarness.active()[0]?.delayMs, 1_000);

  const firstTimer = timerHarness.active()[0]!;
  await service.schedule({ ...due, knowledgeCallbackDueAt: iso(now + 3_000) });
  assert.equal(firstTimer.cleared, true);
  assert.equal(timerHarness.active()[0]?.delayMs, 3_000);

  await service.schedule({
    ...due,
    knowledgeCallbackDueAt: iso(now + MAX_KNOWLEDGE_CALLBACK_REMINDER_DELAY_MS + 50_000)
  });
  assert.equal(timerHarness.active()[0]?.delayMs, MAX_KNOWLEDGE_CALLBACK_REMINDER_DELAY_MS);
});

test("timer rereads dueAt and reschedules a reminder that is still in the future", async () => {
  let now = 20_000;
  const timerHarness = createTimers();
  let current: TestRecord = {
    id: "requirement-a",
    knowledgeCallbackDueAt: iso(now + 100),
    pending: true
  };
  let deliveries = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: () => { deliveries += 1; },
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const firstTimer = timerHarness.active()[0]!;
  now += 100;
  current = { ...current, knowledgeCallbackDueAt: iso(now + 900) };

  await firstTimer.callback();

  assert.equal(deliveries, 0);
  assert.equal(timerHarness.active().length, 1);
  assert.equal(timerHarness.active()[0]?.delayMs, 900);
});

test("timer ignores a record that is no longer pending", async () => {
  const now = 30_000;
  const timerHarness = createTimers();
  let current: TestRecord = {
    id: "requirement-b",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  let deliveries = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: () => { deliveries += 1; },
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const timer = timerHarness.active()[0]!;
  current = { ...current, pending: false };
  await timer.callback();

  assert.equal(deliveries, 0);
  assert.equal(timerHarness.active().length, 0);
});

test("timer does not deliver or reschedule when the refreshed dueAt is invalid", async () => {
  const now = 35_000;
  const timerHarness = createTimers();
  let current: TestRecord = {
    id: "requirement-invalid",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  let deliveries = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: () => { deliveries += 1; },
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const timer = timerHarness.active()[0]!;
  current = { ...current, knowledgeCallbackDueAt: "invalid" };
  await timer.callback();

  assert.equal(deliveries, 0);
  assert.equal(timerHarness.active().length, 0);
});
test("successful delivery completes the attempt and schedules the returned record", async () => {
  const now = 40_000;
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-c",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  const events: string[] = [];
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: record => { events.push(`deliver:${record.id}`); },
    completeAttempt: (record, error) => {
      assert.equal(error, undefined);
      events.push(`complete:${record.id}`);
      return { ...record, knowledgeCallbackDueAt: iso(now + 500) };
    },
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  await timerHarness.active()[0]!.callback();

  assert.deepEqual(events, ["deliver:requirement-c", "complete:requirement-c"]);
  assert.equal(timerHarness.active()[0]?.delayMs, 500);
});

test("failed delivery still completes the attempt and suppresses onError rejection", async () => {
  const now = 50_000;
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-d",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  const deliveryError = new Error("Desktop unavailable");
  let completedWith: unknown;
  let errorReports = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: async () => { throw deliveryError; },
    completeAttempt: (_record, error) => {
      completedWith = error;
      return undefined;
    },
    onError: async () => {
      errorReports += 1;
      throw new Error("error sink unavailable");
    },
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  await assert.doesNotReject(Promise.resolve(timerHarness.active()[0]!.callback()));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(completedWith, deliveryError);
  assert.equal(errorReports, 1);
  assert.equal(timerHarness.active().length, 0);
});

test("stop clears timers and stale timer callbacks cannot start a flight", async () => {
  const now = 60_000;
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-e",
    knowledgeCallbackDueAt: iso(now + 100),
    pending: true
  };
  let reads = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => { reads += 1; return current; },
    isPending: record => record.pending,
    deliverReminder: () => {},
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const staleTimer = timerHarness.active()[0]!;
  await service.stop();
  await staleTimer.callback();
  await service.schedule(current);

  assert.equal(staleTimer.cleared, true);
  assert.equal(reads, 0);
  assert.equal(timerHarness.active().length, 0);
});

test("stop waits for an active delivery, completes it, and prevents rescheduling", async () => {
  const now = 70_000;
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-f",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  const delivery = deferred<void>();
  let deliveryStarted = false;
  let completed = false;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: async () => {
      deliveryStarted = true;
      await delivery.promise;
    },
    completeAttempt: record => {
      completed = true;
      return { ...record, knowledgeCallbackDueAt: iso(now + 1_000) };
    },
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const flight = Promise.resolve(timerHarness.active()[0]!.callback());
  while (!deliveryStarted) await new Promise(resolve => setImmediate(resolve));

  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);

  delivery.resolve();
  await Promise.all([flight, stopping]);

  assert.equal(completed, true);
  assert.equal(timerHarness.active().length, 0);
});

test("a flight checks generation after rereading the record", async () => {
  const now = 80_000;
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-g",
    knowledgeCallbackDueAt: iso(now),
    pending: true
  };
  const recordRead = deferred<TestRecord | undefined>();
  let deliveries = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => [current],
    getRecord: () => recordRead.promise,
    isPending: record => record.pending,
    deliverReminder: () => { deliveries += 1; },
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await service.start();
  const flight = Promise.resolve(timerHarness.active()[0]!.callback());
  const stopping = service.stop();
  recordRead.resolve(current);
  await Promise.all([flight, stopping]);

  assert.equal(deliveries, 0);
});

test("stop prevents a pending start from mounting records from an old generation", async () => {
  const now = 90_000;
  const timerHarness = createTimers();
  const existing = deferred<readonly TestRecord[]>();
  const current: TestRecord = {
    id: "requirement-h",
    knowledgeCallbackDueAt: iso(now + 100),
    pending: true
  };
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => existing.promise,
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: () => {},
    completeAttempt: () => undefined,
    onError: () => {},
    now: () => now,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  const starting = service.start();
  await service.stop();
  existing.resolve([current]);
  await starting;

  assert.equal(timerHarness.active().length, 0);
});





test("start fails closed when existing reminders cannot be loaded", async () => {
  const timerHarness = createTimers();
  const current: TestRecord = {
    id: "requirement-start-failure",
    knowledgeCallbackDueAt: iso(100_000),
    pending: true
  };
  let errorReports = 0;
  const service = new KnowledgeCallbackReminderService<TestRecord, FakeTimer>({
    listExisting: () => { throw new Error("load failed"); },
    getRecord: () => current,
    isPending: record => record.pending,
    deliverReminder: () => {},
    completeAttempt: () => undefined,
    onError: () => { errorReports += 1; },
    now: () => 100_000,
    scheduleTimer: timerHarness.scheduleTimer,
    clearTimer: timerHarness.clearTimer
  });

  await assert.rejects(service.start(), /load failed/);
  await service.schedule(current);

  assert.equal(errorReports, 1);
  assert.equal(timerHarness.active().length, 0);
});
