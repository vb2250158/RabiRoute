import assert from "node:assert/strict";
import test from "node:test";
import { configureTimeouts, getTimeoutMs, readTimeoutOverrides, validateTimeoutOverrides, registerTimeoutCatalog, readRegisteredTimeoutCatalog } from "./timeoutSettings.js";

test("retiring a replacement restores the active plugin's timeout defaults", () => {
  const entry = { key: "test.plugin.deadline", defaultMs: 1000, label: "Fixture", scope: "fixture", effect: "new-request" };
  const removeOriginal = registerTimeoutCatalog([entry]);
  const removeReplacement = registerTimeoutCatalog([{ ...entry, defaultMs: 2000 }]);
  assert.equal(readRegisteredTimeoutCatalog().find(row => row.key === entry.key)?.defaultMs, 2000);
  removeReplacement(); removeReplacement();
  assert.equal(readRegisteredTimeoutCatalog().find(row => row.key === entry.key)?.defaultMs, 1000);
  removeOriginal();
  assert.equal(readRegisteredTimeoutCatalog().find(row => row.key === entry.key), undefined);
});

test("timeout overrides preserve defaults, isolate snapshots and restore defaults", () => {
  configureTimeouts({});
  assert.equal(getTimeoutMs("test.request", 1200), 1200);
  const source = { "test.request": 45_000 };
  configureTimeouts(source);
  source["test.request"] = 1;
  assert.equal(getTimeoutMs("test.request", 1200), 45_000);
  readTimeoutOverrides()["test.request"] = 2;
  assert.equal(getTimeoutMs("test.request", 1200), 45_000);
  configureTimeouts({});
  assert.equal(getTimeoutMs("test.request", 1200), 1200);
});

test("invalid durations never partially publish a new snapshot", () => {
  configureTimeouts({ "test.request": 99 });
  for (const value of [null, [], { "test.request": 0 }, { "test.request": -1 }, { "test.request": 1.5 }, { "test.request": Infinity }, { "test.request": 2147483648 }, { "test.request": "100" }]) {
    assert.throws(() => validateTimeoutOverrides(value));
    assert.equal(getTimeoutMs("test.request", 1), 99);
  }
  configureTimeouts({});
});
