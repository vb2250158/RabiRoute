import assert from "node:assert/strict";
import test from "node:test";
import { managerAutostartEnabled, managerConfigWatcherEnabled } from "./managerRuntimeMode.js";

test("Manager autostart is enabled by default and disabled only by explicit zero", () => {
  assert.equal(managerAutostartEnabled(undefined), true);
  assert.equal(managerAutostartEnabled("1"), true);
  assert.equal(managerAutostartEnabled("false"), true);
  assert.equal(managerAutostartEnabled("0"), false);
});

test("knowledge-only Manager mode disables route config polling", () => {
  assert.equal(managerConfigWatcherEnabled(undefined), true);
  assert.equal(managerConfigWatcherEnabled("1"), true);
  assert.equal(managerConfigWatcherEnabled("0"), false);
});
