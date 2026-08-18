import assert from "node:assert/strict";
import test from "node:test";
import {
  installPerformanceOperationSink,
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
