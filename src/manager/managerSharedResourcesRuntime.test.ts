import assert from "node:assert/strict";
import test from "node:test";
import { stopManagerSharedResources } from "./managerSharedResourcesRuntime.js";

test("Manager shared resources stop Worker Pools after persistence succeeds", async () => {
  const calls: string[] = [];
  await stopManagerSharedResources(
    { stop: async () => { calls.push("persistence"); } },
    async () => { calls.push("workers"); }
  );
  assert.deepEqual(calls, ["persistence", "workers"]);
});

test("Manager shared resources still stop Worker Pools when persistence fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    stopManagerSharedResources(
      {
        stop: async () => {
          calls.push("persistence");
          throw new Error("persistence failed");
        }
      },
      async () => { calls.push("workers"); }
    ),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 1
      && (error.errors[0] as Error).message === "persistence failed"
  );
  assert.deepEqual(calls, ["persistence", "workers"]);
});

test("Manager shared resources preserve every shutdown failure", async () => {
  await assert.rejects(
    stopManagerSharedResources(
      { stop: async () => { throw new Error("persistence failed"); } },
      async () => { throw new Error("workers failed"); }
    ),
    (error: unknown) => error instanceof AggregateError
      && error.errors.map(item => (item as Error).message).join(",") === "persistence failed,workers failed"
  );
});
