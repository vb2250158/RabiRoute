import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { PluginPackageCatalog, loadPluginProfile, parsePluginProfile } from "../plugin-kernel/profile.js";
import { createAgentAdapterHostPorts } from "../runtime/agentAdapterHostPorts.js";
import { resolvePublishedAgentManagerProviders } from "./agentManagerProviders.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import type { AgentManagerHostPorts } from "./agentManagerHostPorts.js";
import { pluginPackagesCandidateForTests } from "./diagnosticsCandidate.fixture.js";
import { canonicalPluginSourceFixture } from "./canonicalPluginSource.fixture.js";

const slugs = ["codex", "copilot-cli", "marvis", "astrbot", "dsh", "workbuddy", "antigravity", "device-agent", "grok-bot"];

test("actual Manager Agent packages publish independent APIs, preserve foreign bindings and isolate an unavailable replacement", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-manager-packages-"));
  let ownedKernel: GenerationRuntime | undefined;
  let ownedCatalog: PluginPackageCatalog | undefined;
  t.after(async () => {
    await ownedKernel?.shutdown(); await ownedCatalog?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const outputDirectory = path.join(root, "built");
  const built = await pluginPackagesCandidateForTests(slugs.map(slug => `io.rabiroute.agent.${slug}`));
  await fs.cp(built, outputDirectory, { recursive: true });
  const catalog = ownedCatalog = new PluginPackageCatalog([path.join(outputDirectory, "packages")]);
  const routes = new ManagerPluginRouteRegistry();
  let scans = 0;
  const host: AgentManagerHostPorts = {
    rootDir: root, packageRoot: process.cwd(), readOnly: () => false, managerInstanceId: () => "fixture-manager",
    getRuntimes: () => [], publishManagerEvent() {},
    registerOperations: (instance, definitions, signal) => routes.registerOperationsAsync(instance, definitions, signal),
    async runScan(task, invocation) {
      invocation?.signal?.throwIfAborted();
      assert.ok(task.entry?.endsWith("workers\\scan.mjs") || task.entry?.endsWith("workers/scan.mjs"));
      await fs.access(task.entry!);
      assert.ok(task.exportName?.startsWith("scan"));
      scans++;
      return { agents: { [task.manifest!.type]: { ...task.manifest, installed: true, sessions: [{ id: "original-session", name: "Original" }] } }, cwdOptions: [] };
    }
  };
  const hostPorts = createAgentAdapterHostPorts({ manager: host });
  const kernel = ownedKernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.agent-adapters@1", value: hostPorts }] });
  const instances = await Promise.all(slugs.map(async slug => ({ id: `agent:${slug}`, package: `io.rabiroute.agent.${slug}`,
    version: (await canonicalPluginSourceFixture(`io.rabiroute.agent.${slug}`)).manifest.version, enabled: true, config: {}, grants: [] })));
  const profile = parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances });
  const loaded = await loadPluginProfile({ profilePath: path.join(root, "profile.json"), profile, packageCatalog: catalog, runtimeRoot: path.join(root, "runtime"), host: "manager" });
  assert.equal(loaded.loadFailures.length, 0);
  await kernel.switch(loaded.candidates);
  const providers = resolvePublishedAgentManagerProviders(kernel.current());
  assert.equal(providers.length, 9, JSON.stringify(kernel.current().records.map(record => ({ instance: record.identity.instanceId, status: record.status, error: record.error }))));
  assert.equal(scans, 0, "publication and settings reads must not trigger discovery");
  const codex = providers.find(provider => provider.type === "codex")!;
  const dsh = providers.find(provider => provider.type === "dsh")!;
  const original = { id: "route", gatewayPort: 12345, agentAdapters: ["codex", "dsh", "unknown-old"], codexThreadId: "original-codex", dshSessionId: "original-dsh", unknownSavedField: { keep: true } };
  const updated = await dsh.invoke<typeof original>("binding.configure", { definition: original, body: { sessionId: "new-dsh", workspace: "fixture-workspace" } });
  assert.equal(updated.dshSessionId, "new-dsh");
  assert.equal(updated.codexThreadId, "original-codex");
  assert.deepEqual(updated.unknownSavedField, { keep: true });
  assert.equal(original.dshSessionId, "original-dsh", "unsaved draft cannot mutate committed input");
  await codex.invoke("scan", {});
  assert.equal(scans, 1);
  const retainedActivation = codex.identity.activationId;
  await kernel.switch(loaded.candidates.filter(candidate => candidate.instanceId !== "agent:dsh"));
  assert.equal(resolvePublishedAgentManagerProviders(kernel.current()).find(provider => provider.type === "codex")!.identity.activationId, retainedActivation);
  await assert.rejects(dsh.invoke("scan", {}), /disabled|retiring|unavailable/);
  await codex.invoke("scan", {});
  assert.equal(scans, 2);
  assert.ok(built);
});
