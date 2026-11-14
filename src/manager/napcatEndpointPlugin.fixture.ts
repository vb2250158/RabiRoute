import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { MessageEndpointManagers } from "../plugin-runtime-host/messageEndpointManagers.js";
import { createMessageEndpointHostPorts } from "../runtime/messageEndpointHostPorts.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { MessageAdapterScanProviderRegistry } from "../plugins/io.rabiroute.manager.message-adapter-control/src/manager/messageAdapterControl.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

let compiled: Promise<{ runtime: string; egress: string; manager: string; manifest: unknown }> | undefined;
async function template() {
  return compiled ??= (async () => {
    const source = path.resolve("src/plugins/io.rabiroute.endpoint.napcat");
    // @ts-expect-error Production JavaScript builder is outside the src compilation root.
    const { bundleMessageEndpointRuntime } = await import("../../scripts/build-message-endpoint-runtime.mjs");
    const spec = JSON.parse(await fs.readFile(path.join(source, "manager-runtime.build.json"), "utf8"));
    const runtime = (await bundleMessageEndpointRuntime(process.cwd(), spec)).contents as string;
    const manager = (await fs.readFile(path.join(source, "manager.mjs"), "utf8")).replace('"@rabiroute/plugin-sdk"', JSON.stringify(pathToFileURL(path.resolve("plugins/contracts/plugin-sdk/index.mjs")).href));
    const egressSpec = JSON.parse(await fs.readFile(path.join(source, "egress-runtime.build.json"), "utf8"));
    const egress = (await bundleMessageEndpointRuntime(process.cwd(), egressSpec)).contents as string;
    return { runtime, egress, manager, manifest: JSON.parse(await fs.readFile(path.join(source, "rabi.plugin.json"), "utf8")) };
  })();
}

export async function napcatEndpointFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-endpoint-owner-"));
  const source = await template();
  await fs.writeFile(path.join(root, "manager-runtime.mjs"), source.runtime);
  await fs.writeFile(path.join(root, "egress-runtime.mjs"), source.egress);
  await fs.writeFile(path.join(root, "manager.mjs"), source.manager);
  const module = await import(pathToFileURL(path.join(root, "manager.mjs")).href) as PluginModule;
  const managers = new MessageEndpointManagers(), scanProviders = new MessageAdapterScanProviderRegistry();
  const operations = new ManagerPluginRouteRegistry();
  const ports = await createMessageEndpointHostPorts();
  let disposalGate: Promise<void> | undefined;
  let routes: GatewayDefinition[] = [];
  const host = { ...ports, managers, scanProviders,
    operations: { async registerOperationsAsync(...args: Parameters<ManagerPluginRouteRegistry["registerOperationsAsync"]>) {
      const registration = await operations.registerOperationsAsync(...args);
      const gate = disposalGate;
      return { ...registration, async dispose() { await registration.dispose(); if (gate) await gate; } };
    } },
    manager: { rootDir: root, managerPort: 0, readOnly: false, shouldAutostart: false, ready: true,
      readRuntimes: () => [], appendRouteLog() {}, checkHttpEndpoint: async () => false,
      normalizeDefinition: (value: unknown) => value, readRoutes: () => routes, writeRoutes: async () => {}, saveRoute: async () => {},
      readRoute: () => undefined, readGatewayStatus: () => ({}), routeRunning: () => false, routeStartedAt: () => undefined, requestIsLoopback: () => true, jsonResponse() {},
      routeVersion: () => "test", syncRoutes() {}, gatewayPayload: () => ({}), log() {} }
  };
  const modules = new Map<PluginCandidate, PluginModule>();
  const kernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.message-endpoints@1", value: host }, { capability: "host.message-endpoints@2", value: host }, { capability: "host.message-endpoints@3", value: host }],
    executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const candidate = (revision: string, extra?: PluginModule, requires?: readonly string[]): PluginCandidate => {
    const candidate: PluginCandidate = { instanceId: "endpoint:napcat", revision, manifest: { ...parsePluginManifest(source.manifest), ...(requires ? { requires } : {}) }, config: {}, entry: { execution: "in_process", path: path.join(root, "manager.mjs") } };
    modules.set(candidate, extra ? { async activate(context) { await module.activate(context); await extra.activate(context); } } : module);
    return candidate;
  };
  return { root, managers, scanProviders, operations, kernel, candidate,
    setRoutes: (next: GatewayDefinition[]) => { routes = next; },
    setDisposalGate: (gate?: Promise<void>) => { disposalGate = gate; },
    async dispose() { await kernel.dispose(); await fs.rm(root, { recursive: true, force: true }); } };
}
