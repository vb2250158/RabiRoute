import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedScans } from "./scanController.js";

test("bounded scans return partial results when one probe never settles", async () => {
  const startedAt = Date.now();
  const result = await runBoundedScans([
    {
      key: "healthy",
      run: async () => ({ value: "ready" }),
      fallback: (diagnostic) => ({ value: diagnostic.state })
    },
    {
      key: "stalled",
      run: () => new Promise<{ value: string }>(() => undefined),
      fallback: (diagnostic) => ({ value: diagnostic.state })
    },
    {
      key: "failed",
      run: async () => {
        throw new Error("probe exploded");
      },
      fallback: (diagnostic) => ({ value: diagnostic.state })
    }
  ] as const, { deadlineMs: 40 });

  assert.equal(result.values.healthy.value, "ready");
  assert.equal(result.values.stalled.value, "timeout");
  assert.equal(result.values.failed.value, "error");
  assert.equal(result.diagnostics.healthy.state, "ok");
  assert.equal(result.diagnostics.stalled.state, "timeout");
  assert.equal(result.diagnostics.failed.state, "error");
  assert.match(result.diagnostics.failed.message || "", /probe exploded/);
  assert.equal(result.partial, true);
  assert.ok(Date.now() - startedAt < 250, "the aggregate scan must honor its deadline");
});

test("bounded scans start independent probes concurrently", async () => {
  const starts: number[] = [];
  const run = async (value: number) => {
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 35));
    return value;
  };

  const startedAt = Date.now();
  const result = await runBoundedScans([
    { key: "left", run: () => run(1), fallback: () => -1 },
    { key: "right", run: () => run(2), fallback: () => -1 }
  ] as const, { deadlineMs: 200 });

  assert.deepEqual(result.values, { left: 1, right: 2 });
  assert.equal(result.partial, false);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 20, "probes should begin together");
  assert.ok(Date.now() - startedAt < 100, "probe durations must not add serially");
});
