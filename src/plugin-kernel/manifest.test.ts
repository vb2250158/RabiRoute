import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginManifest } from "./manifest.js";

test("parsePluginManifest accepts the unified multi-host contract", () => {
  const manifest = parsePluginManifest({
    schemaVersion: 2,
    id: "io.rabiroute.agent.codex",
    version: "1.0.0",
    entries: {
      manager: { execution: "in_process", module: "./manager.mjs" },
      web: { execution: "in_process", module: "./web.mjs" }
    },
    provides: ["agent.adapter.codex@1"],
    requires: ["agent.delivery@1"],
    optional: ["ui.notifications@1"],
    permissions: ["desktop.ipc.codex"],
    configSchema: { type: "object" },
    stateSchemaVersion: 2
  });
  assert.deepEqual(manifest.entries.manager, { execution: "in_process", module: "./manager.mjs" });
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
    schemaVersion: 2, id: "bad.capability", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: ["route.policy"], requires: [], optional: [], permissions: []
  }), /name@major/);
});

test("parsePluginManifest rejects executable commands and invalid execution shapes", () => {
  assert.throws(() => parsePluginManifest({
    schemaVersion: 2, id: "bad.command", version: "1.0.0",
    entries: { manager: { execution: "isolated", command: "node", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  }), /unsupported fields/);
  assert.throws(() => parsePluginManifest({
    schemaVersion: 2, id: "bad.declarative", version: "1.0.0",
    entries: { desktop: { execution: "declarative", module: "./desktop.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  }), /unsupported fields/);
});
