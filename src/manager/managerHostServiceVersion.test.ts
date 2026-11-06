import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";

test("an old manager host blocks only the canonical plugin requiring shared ports v2 before executing it", async () => {
  const directory = path.resolve("src/plugins/io.rabiroute.manager.agent-state-control");
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(directory, "rabi.plugin.json"), "utf8")));
  assert.ok(manifest.requires.includes("host.manager.agent-state-control@2"));
  let prepared = false, unrelatedActive = false;
  const canonical: PluginCandidate = { instanceId: "manager:agent-state-control", revision: "current", manifest, config: {},
    entry: { execution: "in_process", path: path.join(directory, "manager.mjs") } };
  const unrelated: PluginCandidate = { instanceId: "fixture:unrelated", revision: "one", config: {},
    manifest: { schemaVersion: 2, id: "io.test.unrelated", version: "1.0.0", entries: { manager: { execution: "in_process", module: "fixture.mjs" } },
      provides: ["fixture.unrelated@1"], requires: [], optional: [], permissions: [] }, entry: { execution: "in_process", path: "fixture.mjs" } };
  const runtime = new GenerationRuntime({ host: "manager", hostServices: [
    { capability: "host.manager.agent-state-control@1", value: {} },
    ...manifest.requires.filter(capability => capability !== "host.manager.agent-state-control@2").map(capability => ({ capability, value: {} }))
  ], executor: { async prepare(candidate) {
    if (candidate === canonical) { prepared = true; throw new Error("An incompatible plugin must not execute."); }
    return { activate(context) { unrelatedActive = true; context.services.provide("fixture.unrelated@1", {}); } };
  } } });
  try {
    await runtime.switch([canonical, unrelated]);
    const record = runtime.current().records.find(row => row.identity.instanceId === canonical.instanceId)!;
    assert.equal(record.status, "waiting_dependency");
    assert.deepEqual(record.missingCapabilities, ["host.manager.agent-state-control@2"]);
    assert.equal(prepared, false);
    assert.equal(unrelatedActive, true);
    assert.equal(runtime.current().records.find(row => row.identity.instanceId === unrelated.instanceId)?.status, "active");
  } finally { await runtime.dispose(); }
});
