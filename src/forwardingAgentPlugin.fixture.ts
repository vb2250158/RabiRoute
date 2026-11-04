import fs from "node:fs/promises";
import path from "node:path";
import { ownAgentAdapter, parseAgentAdapterPackageDescriptor } from "@rabiroute/plugin-sdk";
import { GenerationRuntime } from "./plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "./plugin-kernel/types.js";
import { parsePluginManifest } from "./plugin-kernel/manifest.js";
import { AgentAdapterRegistry } from "./runtime/agentAdapterRuntime.js";
import { installAgentAdapterGenerationReader } from "./runtime/agentAdapterProviders.js";
import { installAgentAdapterManifestReader } from "./shared/agentAdapterCapabilities.js";
import { readAgentSessionBinding } from "./agentAdapters/agentPluginSessionBinding.js";

/** Publish real native providers with isolated operations; never import a platform client. */
export async function mountForwardingAgentFixture(types: readonly string[], configuration: object, options: {
  installReaders?: boolean;
  deliver?(type: string, payload: any): unknown | Promise<unknown>;
} = {}) {
  const profile = JSON.parse(await fs.readFile(new URL("../plugins/profiles/desktop.json", import.meta.url), "utf8"));
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const candidates: PluginCandidate[] = [];
  for (const instance of profile.instances) {
    const directory = path.resolve("plugins/builtin", instance.package, instance.version);
    let raw: string;
    try { raw = await fs.readFile(path.join(directory, "agent-adapter.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const descriptor = parseAgentAdapterPackageDescriptor(JSON.parse(raw));
    if (!types.includes(descriptor.type)) continue;
    const manifest = parsePluginManifest(JSON.parse(await fs.readFile(path.join(directory, "rabi.plugin.json"), "utf8")));
    const binding = Object.freeze(readAgentSessionBinding(descriptor, configuration));
    const candidate: PluginCandidate = { instanceId: instance.id, revision: "isolated-forwarding-fixture", config: {},
      manifest, entry: { execution: "in_process", path: "isolated-fixture.mjs" } };
    modules.set(candidate, { activate(context) {
      ownAgentAdapter(context, { ...descriptor, serviceEndpoint: { configuredSession() {
        return binding.sessionId && binding.sessionName && binding.workspace
          ? { agentAdapter: descriptor.type, sessionId: binding.sessionId, sessionName: binding.sessionName, workspace: binding.workspace }
          : undefined;
      } }, operations: {
        isBusy() { return false; },
        deliver(payload) {
          if (!options.deliver) throw new Error("Unexpected primary Agent delivery in isolated forwarding fixture.");
          return options.deliver(descriptor.type, payload);
        }
      } });
    } });
    candidates.push(candidate);
  }
  const runtime = new GenerationRuntime({ host: "gateway", hostServices: [{ capability: "host.agent-adapters@1", value: {} }],
    executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const registry = new AgentAdapterRegistry();
  registry.bindGeneration(() => runtime.current());
  await runtime.switch(candidates);
  if (types.some(type => !registry.listManifests().some(manifest => manifest.type === type))) {
    await runtime.shutdown();
    throw new Error("The isolated forwarding fixture failed to publish every requested native Agent.");
  }
  const restoreGeneration = options.installReaders ? installAgentAdapterGenerationReader(() => runtime.current()) : () => {};
  const restoreManifests = options.installReaders ? installAgentAdapterManifestReader(() => registry.listManifests()) : () => {};
  return { runtime, registry, async dispose() {
    try { await runtime.shutdown(); } finally { restoreManifests(); restoreGeneration(); }
  } };
}
