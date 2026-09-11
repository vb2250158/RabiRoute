import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AutomaticUpdateQueue } from "./automaticUpdateQueue.js";

test("automatic queue coalesces edits without publishing superseded work", async () => {
  let release!: () => void;
  let started!: () => void;
  let completed!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const finishing = new Promise<void>(resolve => { completed = resolve; });
  const blocking = new Promise<void>(resolve => { release = resolve; });
  const published: number[] = [];
  let runs = 0;
  const queue = new AutomaticUpdateQueue(async (sequence, isCurrent) => {
    runs++;
    if (runs === 1) { started(); await blocking; }
    if (isCurrent()) published.push(sequence);
    if (runs === 2) completed();
  }, error => { throw error; }, 1);
  queue.schedule();
  await beginning;
  for (let index = 0; index < 50; index++) queue.schedule();
  release();
  await finishing;
  await queue.stop();
  assert.equal(runs, 2);
  assert.deepEqual(published, [51]);
});

test("a failed input is not retried until a new edit arrives", async () => {
  let runs = 0;
  const errors: unknown[] = [];
  const queue = new AutomaticUpdateQueue(async () => { runs++; throw new Error("invalid input"); }, error => errors.push(error), 1);
  queue.schedule();
  await delay(25);
  assert.equal(runs, 1);
  queue.schedule();
  await delay(25);
  await queue.stop();
  assert.equal(runs, 2);
  assert.equal(errors.length, 2);
});

test("closing the queue cancels pending admission", async () => {
  let runs = 0;
  const queue = new AutomaticUpdateQueue(async () => { runs++; }, () => undefined, 10);
  queue.schedule();
  await queue.stop();
  await delay(20);
  assert.equal(runs, 0);
});
