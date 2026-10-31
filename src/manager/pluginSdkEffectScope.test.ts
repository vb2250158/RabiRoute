import assert from "node:assert/strict";
import test from "node:test";
const { EffectScope } = await import(new URL("../../plugins/contracts/plugin-sdk/index.mjs", import.meta.url).href) as typeof import("@rabiroute/plugin-sdk");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("SDK disposal joins a pending starter and releases its late resource once", async () => {
  const scope = new EffectScope(), entered = deferred(), release = deferred();
  let cleaned = 0, nextStarted = false, disposed = false;
  scope.add(async () => { entered.resolve(); await release.promise; return () => { cleaned++; }; });
  scope.add(() => { nextStarted = true; return () => {}; });
  const committed = assert.rejects(scope.commit(), /closed/);
  await entered.promise;
  const disposal = scope.dispose().then(() => { disposed = true; });
  assert.equal(scope.signal().aborted, true);
  await Promise.resolve();
  assert.equal(disposed, false);
  release.resolve();
  await Promise.all([committed, disposal]);
  await scope.dispose();
  assert.equal(cleaned, 1);
  assert.equal(nextStarted, false);
});

test("SDK concurrent commits enter each starter once and preserve reverse cleanup", async () => {
  const scope = new EffectScope(), entered = deferred(), release = deferred();
  let starts = 0;
  const cleanup: number[] = [];
  scope.add(async () => { starts++; entered.resolve(); await release.promise; return () => { cleanup.push(1); }; });
  scope.add(() => { starts++; return () => { cleanup.push(2); }; });
  const first = scope.commit(), second = scope.commit();
  await entered.promise;
  assert.equal(starts, 1);
  release.resolve();
  await Promise.all([first, second]);
  await scope.commit();
  assert.equal(starts, 2);
  await scope.dispose();
  assert.deepEqual(cleanup, [2, 1]);
});

test("SDK synchronous cancellation and failed preparation still join acquired cleanup", async () => {
  const scope = new EffectScope();
  let disposal: Promise<void> | undefined, cleaned = false;
  scope.add(() => { disposal = scope.dispose(); return () => { cleaned = true; }; });
  await assert.rejects(scope.commit(), /closed/);
  await disposal;
  assert.equal(cleaned, true);

  const failed = new EffectScope();
  const cleanup: string[] = [];
  failed.add(() => () => { cleanup.push("first"); });
  failed.add(() => { throw new Error("original preparation failure"); });
  await assert.rejects(failed.commit(), /original preparation failure/);
  assert.deepEqual(cleanup, ["first"]);
});

for (const failure of [undefined, null, false]) {
  test(`SDK cleanup preserves ${String(failure)} rejection while releasing other resources`, async () => {
    const scope = new EffectScope();
    let released = false;
    scope.add(() => () => { released = true; });
    scope.add(() => () => { throw failure; });
    await scope.commit();
    const result = await Promise.allSettled([scope.dispose(), scope.dispose()]);
    assert.equal(released, true);
    for (const item of result) {
      assert.equal(item.status, "rejected");
      if (item.status === "rejected") assert.equal(item.reason, failure);
    }
  });
}
