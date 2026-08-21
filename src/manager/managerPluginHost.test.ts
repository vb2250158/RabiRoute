import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import { getBuiltinManagerPluginRuntime } from "./managerPluginHost.js";

test("builtin Manager Plugin Runtime is deduplicated by the Manager root", async () => {
  const [first, second] = await Promise.all([
    getBuiltinManagerPluginRuntime(),
    getBuiltinManagerPluginRuntime()
  ]);
  const root = getBuiltinManagerCordisRoot();
  assert.strictEqual(first, second);
  assert.equal(first.catalog.snapshot().plugins.every(item => item.status === "active"), true);

  await root.dispose();
  assert.deepEqual(first.catalog.snapshot().plugins, []);
  assert.deepEqual(first.contributions.catalog().contributions, []);

  const replacement = await getBuiltinManagerPluginRuntime();
  const replacementRoot = getBuiltinManagerCordisRoot();
  assert.notStrictEqual(replacement, first);
  assert.notStrictEqual(replacementRoot, root);
  await replacementRoot.dispose();
});
