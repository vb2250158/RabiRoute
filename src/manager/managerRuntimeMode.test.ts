import assert from "node:assert/strict";
import test from "node:test";
import {
  managerAutostartEnabled,
  managerConfigWatcherEnabled,
  managerReadOnlyEnabled,
  managerReadOnlyRequestAllowed
} from "./managerRuntimeMode.js";

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

test("Manager read-only mode requires an explicit one", () => {
  assert.equal(managerReadOnlyEnabled(undefined), false);
  assert.equal(managerReadOnlyEnabled("0"), false);
  assert.equal(managerReadOnlyEnabled("true"), false);
  assert.equal(managerReadOnlyEnabled("1"), true);
});

test("Manager read-only mode accepts observation methods and rejects mutations", () => {
  assert.equal(managerReadOnlyRequestAllowed("GET"), true);
  assert.equal(managerReadOnlyRequestAllowed("HEAD"), true);
  assert.equal(managerReadOnlyRequestAllowed("OPTIONS"), true);
  assert.equal(managerReadOnlyRequestAllowed("POST"), false);
  assert.equal(managerReadOnlyRequestAllowed("PUT"), false);
  assert.equal(managerReadOnlyRequestAllowed("PATCH"), false);
  assert.equal(managerReadOnlyRequestAllowed("DELETE"), false);
});
