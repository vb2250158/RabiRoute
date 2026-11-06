import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";

test("current NapCat requires its new host ports before activation while unrelated plugins remain usable", async () => {
  const manifest = parsePluginManifest(JSON.parse(await fs.readFile(new URL("../plugins/io.rabiroute.endpoint.napcat/rabi.plugin.json", import.meta.url), "utf8")));
  assert.ok(manifest.requires.includes("host.message-endpoints@2"));
  const candidate: PluginCandidate = { instanceId: "endpoint:napcat", revision: "current", manifest, config: {}, entry: { execution: "in_process", path: "controlled.mjs" } };
  const unrelated: PluginCandidate = { ...candidate, instanceId: "unrelated", manifest: { ...manifest, id: "io.test.unrelated", provides: ["test.unrelated@1"], requires: [] } };
  let prepared = 0;
  const host = Object.freeze({});
  const runtime = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.message-endpoints@1", value: host }],
    executor: { async prepare(value) { if (value === candidate) prepared++; return { activate(context) { for (const capability of value.manifest.provides) context.services.provide(capability, host); } }; } } });
  try {
    await runtime.switch([candidate, unrelated], { readyRequires: [] });
    assert.equal(prepared, 0);
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === candidate.instanceId)?.status, "waiting_dependency");
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === unrelated.instanceId)?.status, "active");
  } finally { await runtime.shutdown(); }
});
