import assert from "node:assert/strict";
import test from "node:test";
import { KeyedTaskQueue } from "./keyed-task-queue.mjs";

test("same-key operations stay serialized through terminal wait", async () => {
  const queue = new KeyedTaskQueue();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run("thread", async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-terminal");
  });
  const second = queue.run("thread", async () => {
    order.push("second-start");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-terminal", "second-start"]);
});

test("different keys can run concurrently and a rejected operation releases its key", async () => {
  const queue = new KeyedTaskQueue();
  const order = [];
  const failed = queue.run("one", async () => {
    order.push("one");
    throw new Error("expected");
  });
  const parallel = queue.run("two", async () => order.push("two"));
  const recovered = queue.run("one", async () => order.push("one-recovered"));
  await assert.rejects(failed, /expected/);
  await Promise.all([parallel, recovered]);
  assert.ok(order.indexOf("one-recovered") > order.indexOf("one"));
  assert.ok(order.includes("two"));
});
