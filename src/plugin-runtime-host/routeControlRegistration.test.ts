import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveInProcessRoots } from "../plugin-kernel/pluginExecutionSettings.js";
import { PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/profile.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { createFullPluginExecutor } from "./executor.js";
import { AsyncPluginOutcomeArchive } from "./asyncOutcomeArchive.js";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import { createAgentAdapterHostPorts } from "../runtime/agentAdapterHostPorts.js";
import { canonicalPluginSourceFixture } from "../manager/canonicalPluginSource.fixture.js";

test("normally packaged real Route control uses its native scoped owner and registry registration", { timeout: 30000 }, async t => {
  const started = performance.now();
  const stage = (name: string) => t.diagnostic(`${name}: ${Math.round(performance.now() - started)}ms`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "route-control-isolated-"));
  // Use the normal packager in an isolated output; stale/missing dist is not this runtime contract.
  // @ts-expect-error The production JavaScript builder is outside src.
  const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
  let packageRoot: string;
  try {
    packageRoot = (await buildPluginPackages(process.cwd(), {packages: ["io.rabiroute.manager.route-control"], outputDirectory: path.join(root, "built")})).packagesRoot;
  } catch (error) { await fs.rm(root, {recursive: true, force: true}); throw error; }
  stage("physical package built");
  const catalog = new PluginPackageCatalog([packageRoot]);
  const leases = new ProcessLeaseRegistry();
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "outcomes"));
  const registry = new ManagerPluginRouteRegistry();
  let registrations = 0;
  let nativeOwner: string | undefined;
  class NativeDependency { marker() { return "parent-only"; } }
  const shared = createAgentAdapterHostPorts();
  const native = Object.freeze({ ...shared, rootDir: root, routeRoot: path.join(root, "routes"), rolesRoot: path.join(root, "roles"),
    managerPort: 0, managerHost: "127.0.0.1", managerInstanceId: "fixture-manager", managerHostIdentity: { applicationGenerationId: "fixture-app" },
    rabiRoutePackageVersion: "fixture", runtimes: new Map(), rabiGlobalConfig: { read: () => ({}) },
    readManagerConfig: () => ({ routeDir: path.join(root, "routes"), rolesDir: path.join(root, "roles") }),
    managerPluginRoutes: { async registerOperationsAsync(...args: Parameters<typeof registry.registerOperationsAsync>) {
      registrations++; nativeOwner = currentPluginActivation()?.instanceId;
      return registry.registerOperationsAsync(...args);
    } }
  });
  const originalServices = [
    { capability: "host.manager.route-control@2", value: native },
    { capability: "manager.core@1", value: new NativeDependency() },
    { capability: "manager.gateway-runtime@1", value: new NativeDependency() }
  ];
  const runtime = new GenerationRuntime({ host: "manager", hostServices: originalServices, executor: createFullPluginExecutor(leases, archive) });
  t.after(async () => {
    await runtime.shutdown();
    await archive.dispose();
    await catalog.dispose();
    await leases.disposeAll();
    assert.equal(leases.list().length, 0);
    assert.equal(registry.catalogSnapshot().operations.length, 0);
    await fs.rm(root, { recursive: true });
  });
  const profilePath = path.join(root, "profile.json");
  const version = (await canonicalPluginSourceFixture("io.rabiroute.manager.route-control")).manifest.version;
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "manager:route-control", package: "io.rabiroute.manager.route-control", version, enabled: true, config: {}, grants: [] }] }));
  const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "immutable"), host: "manager" });
  stage("immutable package prepared");
  assert.equal(loaded.loadFailures.length, 0, JSON.stringify(loaded.loadFailures));
  assert.equal(loaded.candidates[0]!.entry.execution, "in_process");
  const oldHost = new GenerationRuntime({ host: "manager", hostServices: originalServices.map(service => service.capability === "host.manager.route-control@2"
    ? { ...service, capability: "host.manager.route-control@1" } : service) });
  try {
    const blocked = await oldHost.switch(loaded.candidates);
    assert.equal(blocked.generation.records[0]?.status, "waiting_dependency");
    assert.ok(blocked.generation.records[0]?.missingCapabilities.includes("host.manager.route-control@2"));
    assert.equal(registrations, 0, "An old Host must block locally before the owned factory runs.");
  } finally { await oldHost.shutdown(); }
  stage("old Host blocked locally");
  const result = await runtime.switch(loaded.candidates);
  stage("current owner activated");
  assert.equal(result.generation.records[0]!.status, "active", JSON.stringify(result.generation.records[0]!.error));
  assert.equal(registrations, 1);
  assert.equal(nativeOwner, "manager:route-control");
  const operations = registry.catalogSnapshot().operations;
  assert.ok(operations.some(operation => operation.contract.pathTemplate === "/api/rabi/identity"));
  assert.ok(operations.some(operation => operation.contract.pathTemplate === "/manager-config"));
  assert.ok(operations.every(operation => operation.owner.instanceId === "manager:route-control"));
  assert.equal(leases.list().length, 0, "Native dependencies stay in their actual process without a compatibility child.");
  assert.equal(archive.snapshot().writes, 0);
  assert.ok(result.generation.contributions.contributions.some(item => item.kind === "command" && item.id === "create-role"));
});

test("an actually consumed native dependency fails only its child activation without evaluating getters", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-capability-"));
  const packages = path.join(root, "packages"), entry = path.join(packages, "org.example.native-consumer", "1.0.0");
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(entry, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "org.example.native-consumer", version: "1.0.0", entries: { manager: { execution: "isolated", module: "./manager.mjs" } }, provides: [], requires: ["host.native@1"], optional: [], permissions: [] }));
  await fs.writeFile(path.join(entry, "rabi.async-services.json"), JSON.stringify({ schemaVersion: 1, provides: {} }));
  await fs.writeFile(path.join(entry, "manager.mjs"), "export function activate(context) { context.services.require('host.native@1'); }");
  let reads = 0;
  class NativeService { get data() { reads++; throw new Error("Native getter must not run."); } }
  const catalog = new PluginPackageCatalog([packages]), leases = new ProcessLeaseRegistry(), archive = new AsyncPluginOutcomeArchive(path.join(root, "outcomes"));
  const runtime = new GenerationRuntime({ host: "manager", executor: createFullPluginExecutor(leases, archive), hostServices: [{ capability: "host.native@1", value: new NativeService() }] });
  t.after(async () => { await runtime.shutdown(); await archive.dispose(); await catalog.dispose(); await leases.disposeAll(); await fs.rm(root, { recursive: true }); });
  const profilePath = path.join(root, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "native-consumer", package: "org.example.native-consumer", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
  const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "immutable"), host: "manager" });
  assert.equal(loaded.loadFailures.length, 0);
  const result = await runtime.switch(loaded.candidates);
  assert.equal(result.generation.records[0]!.status, "failed");
  assert.match(result.generation.records[0]!.error!.message, /Capability requires its original native owner/);
  assert.equal(reads, 0);
  assert.equal(leases.list().length, 0);
});

 test("invalid optional execution configuration preserves both declared execution modes", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-config-isolation-"));
  const packages = path.join(root, "packages");
  for (const execution of ["in_process", "isolated"]) {
    const entry = path.join(packages, "org.example." + execution, "1.0.0");
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "org.example." + execution, version: "1.0.0", entries: { manager: { execution, module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] }));
    await fs.writeFile(path.join(entry, "manager.mjs"), "export function activate() {}\n");
  }
  const settings = resolveInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: "malformed-private-value" });
  const catalog = new PluginPackageCatalog([packages], { trustedInProcessRoots: settings.roots, configurationDiagnostics: settings.diagnostics });
  const leases = new ProcessLeaseRegistry(), archive = new AsyncPluginOutcomeArchive(path.join(root, "outcomes"));
  const runtime = new GenerationRuntime({ host: "manager", executor: createFullPluginExecutor(leases, archive) });
  t.after(async () => { await runtime.shutdown(); await archive.dispose(); await catalog.dispose(); await leases.disposeAll(); await fs.rm(root, { recursive: true }); });
  const profilePath = path.join(root, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: ["in_process", "isolated"].map(execution => ({ id: execution, package: "org.example." + execution, version: "1.0.0", enabled: true, config: {}, grants: [] })) }));
  const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "immutable"), host: "manager" });
  assert.deepEqual(loaded.loadFailures, []);
  assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId).sort(), ["in_process", "isolated"]);
  assert.equal(catalog.snapshot().configurationDiagnostics.length, 1);
  assert.equal(JSON.stringify(catalog.snapshot()).includes("malformed-private-value"), false);
  const result = await runtime.switch(loaded.candidates);
  assert.equal(result.generation.records.length, 2);
  assert.ok(result.generation.records.every(record => record.status === "active"));
  assert.equal(leases.list().length, 1);
  assert.notEqual(leases.list()[0]?.child.pid, process.pid);
 });
