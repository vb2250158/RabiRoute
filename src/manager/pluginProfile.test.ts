import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyRabiPluginProfilePatches,
  parseRabiPluginProfile,
  parseRabiPluginProfilePatch,
  rabiPluginProfileEntryRevision,
  readRabiPluginProfile
} from "./pluginProfile.js";

const base = {
  schemaVersion: 1,
  plugins: [{ id: "manager:echo", package: "example.echo", version: "1.0.0", config: { message: "one" } }]
};

test("profile patches preserve stable ids and replace only stated entries", () => {
  const profile = parseRabiPluginProfile(base);
  const patched = applyRabiPluginProfilePatches(profile, [parseRabiPluginProfilePatch({
    schemaVersion: 1,
    operations: [
      { op: "upsert", plugin: { id: "manager:echo", package: "example.echo", version: "1.1.0", enabled: true, config: { message: "two" } } },
      { op: "upsert", plugin: { id: "manager:other", package: "example.other", version: "1", enabled: false } }
    ]
  })]);
  assert.deepEqual(patched.plugins.map(item => [item.id, item.version, item.enabled]), [["manager:echo", "1.1.0", true], ["manager:other", "1", false]]);
});

test("profile loader orders patch files and revision includes config and bundle changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-profile-"));
  await fs.mkdir(path.join(root, "profile.d"));
  await fs.writeFile(path.join(root, "profile.json"), JSON.stringify(base), "utf8");
  await fs.writeFile(path.join(root, "profile.d", "20-disable.json"), JSON.stringify({ schemaVersion: 1, operations: [{ op: "upsert", plugin: { id: "manager:echo", package: "example.echo", version: "1.0.0", enabled: false, config: { message: "one" } } }] }), "utf8");
  const profile = await readRabiPluginProfile(path.join(root, "profile.json"), path.join(root, "profile.d"));
  assert.equal(profile.plugins[0].enabled, false);
  const first = rabiPluginProfileEntryRevision(profile.plugins[0], "bundle-one");
  const second = rabiPluginProfileEntryRevision({ ...profile.plugins[0], enabled: true }, "bundle-one");
  const third = rabiPluginProfileEntryRevision(profile.plugins[0], "bundle-two");
  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test("profile rejects unknown fields and unsafe packages", () => {
  assert.throws(() => parseRabiPluginProfile({ schemaVersion: 1, plugins: [], command: "node anything" }));
  assert.throws(() => parseRabiPluginProfile({ schemaVersion: 1, plugins: [{ id: "manager:x", package: "../../escape", version: "1" }] }));
});
