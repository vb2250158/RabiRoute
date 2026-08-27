import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import { getManagerPluginRuntimeHost } from "./managerPluginRuntimeHost.js";

test("Manager Plugin Runtime Host is deduplicated by the Manager root without eager plugin activation", async () => {
  const [first, second] = await Promise.all([
    getManagerPluginRuntimeHost(),
    getManagerPluginRuntimeHost()
  ]);
  const root = getBuiltinManagerCordisRoot();
  assert.strictEqual(first, second);
  assert.deepEqual(first.runtime.catalog.snapshot().plugins, []);
  assert.deepEqual(first.runtime.contributions.catalog().contributions, []);

  await root.dispose();
  assert.deepEqual(first.runtime.catalog.snapshot().plugins, []);
  assert.deepEqual(first.runtime.contributions.catalog().contributions, []);

  const replacement = await getManagerPluginRuntimeHost();
  const replacementRoot = getBuiltinManagerCordisRoot();
  assert.notStrictEqual(replacement, first);
  assert.notStrictEqual(replacementRoot, root);
  assert.deepEqual(replacement.runtime.catalog.snapshot().plugins, []);
  await replacementRoot.dispose();
});

test("Manager Plugin Host exposes no legacy eager-runtime accessor", () => {
  const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "managerPluginRuntimeHost.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(source, /getBuiltinManagerPluginRuntime/);
  assert.doesNotMatch(source, /managerBasePluginDefinitions/);
});
