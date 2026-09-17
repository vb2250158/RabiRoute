import assert from "node:assert/strict";
import test from "node:test";
import { createRabiLinkHomeLoader, type RabiLinkHomeState } from "../src/rabiLinkHomeState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("new refresh replaces old response even when transport ignores abort", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const queue = [first, second];
  let state: RabiLinkHomeState<string> = { phase: "idle" };
  const loader = createRabiLinkHomeLoader(() => queue.shift()!.promise, value => { state = value; }, String);
  const old = loader.refresh();
  const current = loader.refresh();
  second.resolve("current");
  await current;
  first.resolve("stale");
  await old;
  assert.deepEqual(state, { phase: "ready", data: "current" });
});

for (const cause of ["tab switch", "save", "disconnect", "configuration change"]) {
  test(`${cause} invalidates authorized data and rejects delayed responses`, async () => {
    const result = deferred<string>();
    let state: RabiLinkHomeState<string> = { phase: "ready", data: "old-authorized-data" };
    let signal!: AbortSignal;
    const loader = createRabiLinkHomeLoader(value => { signal = value; return result.promise; }, value => { state = value; }, String);
    const request = loader.refresh();
    assert.deepEqual(state, { phase: "loading" });
    loader.invalidate();
    assert.equal(signal.aborted, true);
    result.resolve("old-authorized-data");
    await request;
    assert.deepEqual(state, { phase: "idle" });
  });
}

test("failed read is an error, never an empty successful list", async () => {
  let state: RabiLinkHomeState<string[]> = { phase: "ready", data: ["old"] };
  const loader = createRabiLinkHomeLoader<string[]>(async () => { throw new Error("unavailable"); }, value => { state = value; }, () => "读取失败");
  await loader.refresh();
  assert.deepEqual(state, { phase: "error", error: "读取失败" });
});

test("dispose aborts transport and suppresses success, error and future loads", async () => {
  for (const fail of [false, true]) {
    const result = deferred<string>();
    const updates: RabiLinkHomeState<string>[] = [];
    const loader = createRabiLinkHomeLoader(() => result.promise, value => updates.push(value), String);
    const request = loader.refresh();
    loader.dispose();
    const length = updates.length;
    if (fail) result.reject(new Error("late")); else result.resolve("late");
    await request;
    await loader.refresh();
    assert.equal(updates.length, length);
  }
});
