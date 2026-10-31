import assert from "node:assert/strict";
import test from "node:test";
import {
  installPerformanceOperationSink,
  recordPerformanceOperation,
  performanceOperationStatus,
  measurePerformanceOperation,
  measureSyncPerformanceOperation
} from "./performanceInstrumentation.js";

test("performance instrumentation records successful and failed operation boundaries", async () => {
  const records: Array<{ operation: string; error: boolean; durationMs: number }> = [];
  const uninstall = installPerformanceOperationSink(record => { records.push(record); });
  try {
    assert.equal(measureSyncPerformanceOperation("manager.test.sync", () => 7), 7);
    await assert.rejects(() => measurePerformanceOperation("manager.test.async", async () => {
      throw new Error("expected");
    }));
    assert.deepEqual(records.map(record => [record.operation, record.error]), [
      ["manager.test.sync", false],
      ["manager.test.async", true]
    ]);
    assert.ok(records.every(record => record.durationMs >= 0));
  } finally {
    uninstall();
  }
});


test("disabled instrumentation skips diagnostic allocation and preserves promise identity", async () => {
  const RealDate = globalThis.Date;
  let dates = 0;
  class CountingDate extends RealDate { constructor() { super(); dates += 1; } }
  globalThis.Date = CountingDate as DateConstructor;
  try {
    const result = Promise.resolve(11);
    const action = () => 7;
    for (let i = 0; i < 100; i += 1) {
      recordPerformanceOperation("disabled", 1);
      assert.equal(measureSyncPerformanceOperation("disabled", action), 7);
      assert.equal(measurePerformanceOperation("disabled", () => result), result);
    }
    assert.equal(dates, 0);
    const failure = new Error("original");
    await assert.rejects(measurePerformanceOperation("disabled", () => { throw failure; }), e => e === failure);
  } finally { globalThis.Date = RealDate; }
});

test("failed diagnostic sink cannot change sync or async business results", async () => {
  let records = 0;
  let actions = 0;
  const before = performanceOperationStatus().failedRecords;
  const uninstall = installPerformanceOperationSink(() => { records += 1; throw new Error("sink"); });
  const original = new Error("business");
  try {
    assert.equal(measureSyncPerformanceOperation("ok", () => { actions += 1; return 7; }), 7);
    assert.throws(() => measureSyncPerformanceOperation("fail", () => { actions += 1; throw original; }), e => e === original);
    assert.equal(await measurePerformanceOperation("ok", async () => { actions += 1; return 9; }), 9);
    await assert.rejects(measurePerformanceOperation("fail", async () => { actions += 1; throw original; }), e => e === original);
    assert.equal(actions, 4);
    assert.equal(records, 4);
    assert.equal(performanceOperationStatus().failedRecords, before + 4);
    assert.ok(performanceOperationStatus().lastFailureAt);
  } finally { uninstall(); }
});

test("sink replacement and explicit timestamp retain the original ownership contract", () => {
  const records: unknown[] = [];
  const uninstallOld = installPerformanceOperationSink(() => { throw new Error("old sink"); });
  const uninstallNew = installPerformanceOperationSink(r => records.push(r));
  uninstallOld();
  recordPerformanceOperation("a b", -2, true, "explicit");
  uninstallNew();
  recordPerformanceOperation("disabled", 1);
  assert.deepEqual(records, [{ operation: "a_b", durationMs: 0, error: true, time: "explicit" }]);
});


test("disabled async instrumentation normalizes JavaScript thenables and rejects bad then access", async () => {
  const thenable = { then(resolve: (value: number) => void) { resolve(5); } } as unknown as Promise<number>;
  const result = measurePerformanceOperation("thenable", () => thenable);
  assert.equal(typeof result.catch, "function");
  assert.equal(await result, 5);
  const failure = new Error("then getter");
  const badThenable = { get then() { throw failure; } } as unknown as Promise<number>;
  await assert.rejects(measurePerformanceOperation("bad-then", () => badThenable), e => e === failure);
});
