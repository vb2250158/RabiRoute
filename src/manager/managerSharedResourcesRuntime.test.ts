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
    /persistence failed/
  );
  assert.deepEqual(calls, ["persistence", "workers"]);
});
