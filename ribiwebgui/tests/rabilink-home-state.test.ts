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

test("same-scope refresh keeps the rendered snapshot until the replacement arrives", async () => {
  const replacement = deferred<string>();
  const reads = [Promise.resolve("visible devices"), replacement.promise];
  const updates: RabiLinkHomeState<string>[] = [];
  const loader = createRabiLinkHomeLoader(() => reads.shift()!, value => updates.push(value), String);
  await loader.refresh();
  const pending = loader.refresh();
  assert.deepEqual(updates, [
    { phase: "loading" },
    { phase: "ready", data: "visible devices" }
  ]);
  replacement.resolve("updated devices");
  await pending;
  assert.deepEqual(updates.at(-1), { phase: "ready", data: "updated devices" });
});

for (const cause of ["tab switch", "save", "disconnect", "configuration change"]) {
  test(`${cause} invalidates authorized data and rejects delayed responses`, async () => {
    const result = deferred<string>();
    const reads = [Promise.resolve("old-authorized-data"), result.promise];
    let state: RabiLinkHomeState<string> = { phase: "idle" };
    let signal!: AbortSignal;
    const loader = createRabiLinkHomeLoader(value => { signal = value; return reads.shift()!; }, value => { state = value; }, String);
    await loader.refresh();
    const request = loader.refresh();
    assert.deepEqual(state, { phase: "ready", data: "old-authorized-data" });
    loader.invalidate();
    assert.equal(signal.aborted, true);
    result.resolve("old-authorized-data");
    await request;
    assert.deepEqual(state, { phase: "idle" });
  });
}

test("failed read is an error, never an empty successful list", async () => {
  let state: RabiLinkHomeState<string[]> = { phase: "idle" };
  let fail = false;
  const loader = createRabiLinkHomeLoader<string[]>(async () => {
    if (fail) throw new Error("unavailable");
    return ["old"];
  }, value => { state = value; }, () => "读取失败");
  await loader.refresh();
  fail = true;
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
