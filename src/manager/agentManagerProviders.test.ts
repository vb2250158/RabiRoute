import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ownAgentAdapter } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { PluginPackageCatalog, parsePluginProfile } from "../plugin-kernel/profile.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { loadInstalledAgentManagerDescriptors, resolvePublishedAgentManagerProviders } from "./agentManagerProviders.js";

const descriptor = (type: string) => ({
  type,
  capability: `agent.adapter.${type}@1`,
  manifest: { type, label: type, maturity: "experimental", transport: { protocol: "fixture", mode: "original-owner" }, capabilities: {} },
  sessionBinding: { sessionId: `${type}SessionId` }
});

test("installed Agent metadata isolates malformed transport, host, capability and duplicate owners between healthy packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-descriptors-"));
  const values = [descriptor("before"), { ...descriptor("bad"), manifest: { ...descriptor("bad").manifest, transport: null } },
    descriptor("after"), { ...descriptor("host"), manifest: { ...descriptor("host").manifest, host: { name: "bad", required: "yes" } } },
    descriptor("wrong"), descriptor("duplicate"), descriptor("duplicate")];
  const profile = parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: values.map((_value, index) => ({ id: `instance-${index}`, package: `io.fixture.${index}`, version: "1.0.0", enabled: false, config: {} })) });
  const catalog = new PluginPackageCatalog([root]);
  try {
    for (const [index, value] of values.entries()) {
      const directory = path.join(root, `io.fixture.${index}`, "1.0.0");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "agent-adapter.json"), JSON.stringify(value));
      await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: `io.fixture.${index}`, version: "1.0.0",
        entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
        provides: index === 4 ? ["agent.adapter.another@1"] : [value.capability], requires: [], optional: [], permissions: [] }));
    }
    const result = await loadInstalledAgentManagerDescriptors(profile, catalog);
    assert.deepEqual(result.descriptors.map(item => item.type), ["before", "after"]);
    assert.deepEqual(result.diagnostics.map(item => item.instanceId).sort(), ["instance-1", "instance-3", "instance-4", "instance-5", "instance-6"]);
    assert.equal(result.descriptors[0]!.sessionBinding.sessionId, "beforeSessionId");
    assert.equal(Object.isFrozen(result.descriptors[0]!.manifest.transport), true);
    assert.equal(Object.isFrozen(result.descriptors[0]!.manifest.capabilities), true);
  } finally { await catalog.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("Manager uses the native provider projection and excludes only conflicting wire types", async () => {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  function candidate(id: string, type: string): PluginCandidate {
    const capability = `agent.adapter.${id}@1`;
    const item: PluginCandidate = { instanceId: id, revision: "one", config: {}, entry: { execution: "in_process", path: "fixture.mjs" },
      manifest: { schemaVersion: 2, id: `io.fixture.${id}`, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [capability], requires: [], optional: [], permissions: [] } };
    modules.set(item, { activate(context) {
      const scoped = { ...context, contributions: { register(contribution: Parameters<typeof context.contributions.register>[0]) {
        context.contributions.register({ ...contribution, id: `agent.${id}.provider` });
      } } };
      ownAgentAdapter(scoped, { type, capability, manifest: { ...descriptor(type).manifest, maturity: "experimental" }, operations: { scan: () => type } });
    } });
    return item;
  }
  const runtime = new GenerationRuntime({ host: "manager", executor: { async prepare(item) { return modules.get(item)!; } } });
  try {
    await runtime.switch([candidate("good-before", "before"), candidate("bad-one", "conflict"), candidate("good-after", "after"), candidate("bad-two", "conflict")]);
    const providers = resolvePublishedAgentManagerProviders(runtime.current());
    assert.deepEqual(providers.map(item => item.type).sort(), ["after", "before"]);
    assert.equal(await providers.find(item => item.type === "after")!.invoke("scan", {}), "after");
  } finally { await runtime.shutdown(); }
});
