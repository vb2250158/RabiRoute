import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginManifest } from "./manifest.js";

test("parsePluginManifest accepts the unified multi-host contract", () => {
  const manifest = parsePluginManifest({
    schemaVersion: 1,
    id: "io.rabiroute.agent.codex",
    version: "1.0.0",
    entries: { manager: "./manager.mjs", web: "./web.mjs" },
    provides: ["agent.adapter.codex@1"],
    requires: ["agent.delivery@1"],
    optional: ["ui.notifications@1"],
    permissions: ["desktop.ipc.codex"],
    configSchema: { type: "object" },
    stateSchemaVersion: 2
  });
  assert.equal(manifest.entries.manager, "./manager.mjs");
  assert.deepEqual(manifest.provides, ["agent.adapter.codex@1"]);
  assert.equal(manifest.stateSchemaVersion, 2);
});

test("parsePluginManifest rejects old host and entry fields", () => {
  assert.throws(() => parsePluginManifest({
    schemaVersion: 1, id: "old.bundle", version: "1.0.0", hosts: ["manager"], entry: "./index.mjs"
  }), /unsupported fields/i);
});

test("parsePluginManifest rejects capabilities without a major version", () => {
  assert.throws(() => parsePluginManifest({
    schemaVersion: 1, id: "bad.capability", version: "1.0.0", entries: { manager: "./manager.mjs" },
    provides: ["route.policy"], requires: [], optional: [], permissions: []
  }), /name@major/);
});
