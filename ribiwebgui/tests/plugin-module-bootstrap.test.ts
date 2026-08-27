import assert from "node:assert/strict";
import test from "node:test";
import { refreshWebPluginModulesSafely } from "../src/pluginModuleBootstrap";

test("Web plugin bootstrap waits for the initial module graph", async () => {
  const calls: string[] = [];
  const loaded = await refreshWebPluginModulesSafely(async () => { calls.push("refresh"); });
  assert.equal(loaded, true);
  assert.deepEqual(calls, ["refresh"]);
});

test("a failed optional Web Bundle leaves the fixed WebGUI host available", async () => {
  const failures: Array<{ message: string; error: unknown }> = [];
  const error = new Error("broken bundle");
  const loaded = await refreshWebPluginModulesSafely(
    async () => { throw error; },
    (message, cause) => failures.push({ message, error: cause })
  );
  assert.equal(loaded, false);
  assert.deepEqual(failures, [{
    message: "Web plugin module refresh failed; the fixed WebGUI host remains available.",
    error
  }]);
});
