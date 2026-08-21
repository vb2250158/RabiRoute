import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  getBuiltinManagerPluginHost,
  getBuiltinManagerPluginRuntime
} from "./managerPluginHost.js";
import { normalizeManagerPluginConfig } from "./managerPluginConfig.js";

test("builtin Manager Plugin Host is deduplicated by the Manager root", async () => {
  const [first, second] = await Promise.all([
    getBuiltinManagerPluginHost(),
    getBuiltinManagerPluginHost()
  ]);
  const root = getBuiltinManagerCordisRoot();
  assert.strictEqual(first, second);
  assert.deepEqual(first.runtime.catalog.snapshot().plugins, []);

  const configured = normalizeManagerPluginConfig({
    managerPlugins: { "manager:desktop": { enabled: false } }
  });
  const status = await first.reconciler.reconcile(configured.desired);
  assert.equal(status.state, "idle");
  assert.equal(first.runtime.plugins.has("manager:desktop"), false);
  assert.equal(first.runtime.plugins.has("manager:core"), true);

  await root.dispose();
  assert.deepEqual(first.runtime.catalog.snapshot().plugins, []);
  assert.deepEqual(first.runtime.contributions.catalog().contributions, []);

  const replacement = await getBuiltinManagerPluginHost();
  const replacementRoot = getBuiltinManagerCordisRoot();
  assert.notStrictEqual(replacement, first);
  assert.notStrictEqual(replacementRoot, root);
  await replacementRoot.dispose();
});

test("legacy runtime accessor mounts the default builtin composition", async () => {
  const runtime = await getBuiltinManagerPluginRuntime();
  assert.equal(runtime.catalog.snapshot().plugins.every(item => item.status === "active"), true);
  assert.equal(runtime.plugins.has("manager:core"), true);
  await getBuiltinManagerCordisRoot().dispose();
});
