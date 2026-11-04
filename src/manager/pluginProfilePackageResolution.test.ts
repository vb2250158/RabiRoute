import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPluginProfile, parsePluginProfile, PluginPackageCatalog } from "../plugin-kernel/profile.js";
import { readInstalledGatewayEndpointTypes } from "../plugin-runtime-host/messageEndpointOwnership.js";
import { readInstalledEndpointRouteDeclarations } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
import { loadInstalledAgentManagerDescriptors } from "./agentManagerProviders.js";
import { readPluginManagementManifest } from "./pluginManagement.js";
import { pluginProfilePackageResolution } from "./pluginProfilePackageResolution.js";

test("three metadata readers follow selected immutable bytes while disabled declarations stay discoverable", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-metadata-"));
  const source = path.join(root, "packages"), current = path.join(source, "io.test.current", "1.0.0");
  const disabled = path.join(source, "io.test.disabled", "1.0.0");
  const catalog = new PluginPackageCatalog([source]);
  t.after(async () => { await catalog.dispose(); await fs.rm(root, { recursive: true }); });
  for (const [directory, id, provides] of [[current, "io.test.current", ["agent.adapter.dsh@1", "endpoint.fixture@1"]],
    [disabled, "io.test.disabled", ["endpoint.offlineinput@1"]]] as const) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id, version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./manager.mjs" }, gateway: { execution: "in_process", module: "./manager.mjs" } },
      provides, requires: [], optional: [], permissions: [] }));
    await fs.writeFile(path.join(directory, "manager.mjs"), "export function activate() {}\n");
  }
  const template = path.resolve("plugins/builtin/io.rabiroute.agent.dsh/1.0.0");
  for (const name of ["agent-adapter.json", "route-config.json"]) await fs.copyFile(path.join(template, name), path.join(current, name));
  const desired = parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "current", package: "io.test.current", version: "1.0.0", enabled: true },
    { id: "disabled", package: "io.test.disabled", version: "1.0.0", enabled: false }
  ] });
  const input = { profilePath: path.join(root, "profile.json"), profile: desired, packageCatalog: catalog,
    runtimeRoot: path.join(root, "runtime"), host: "manager" as const };
  const previous = await loadPluginProfile(input);
  const originalDescriptor = JSON.parse(await fs.readFile(path.join(current, "agent-adapter.json"), "utf8"));
  const sourceManifest = JSON.parse(await fs.readFile(path.join(current, "rabi.plugin.json"), "utf8"));
  sourceManifest.provides = ["endpoint.mutated@1"];
  await fs.writeFile(path.join(current, "rabi.plugin.json"), JSON.stringify(sourceManifest));
  for (const name of ["agent-adapter.json", "route-config.json"]) await fs.writeFile(path.join(current, name), "invalid new metadata");
  const selected = await loadPluginProfile({ ...input, previous, reuseUnchangedPackages: true });
  assert.equal(selected.packages[0]?.package, previous.packages[0]?.package);
  const metadata = pluginProfilePackageResolution(desired, selected, catalog);
  const readManifest = (id: string, version: string) => readPluginManagementManifest(metadata.catalog, id, version);
  const [ownership, declarations, agents] = await Promise.all([
    readInstalledGatewayEndpointTypes(metadata.profile, readManifest),
    readInstalledEndpointRouteDeclarations(metadata.profile, metadata.catalog, readManifest),
    loadInstalledAgentManagerDescriptors(metadata.profile, metadata.catalog, readManifest)
  ]);
  assert.deepEqual([...ownership.types].sort(), ["fixture", "offlineinput"]);
  assert.deepEqual(ownership.diagnostics, []); assert.deepEqual(declarations.diagnostics, []); assert.deepEqual(agents.diagnostics, []);
  assert.equal(declarations.declarations[0]?.endpointType, "agent:dsh");
  assert.equal(agents.descriptors[0]?.manifest.label, originalDescriptor.manifest.label);
  assert.equal((await metadata.catalog.resolve("io.test.current", "1.0.0")).sourceRoot, previous.packages[0]?.package.runtimeRoot);
  assert.equal((await metadata.catalog.resolve("io.test.disabled", "1.0.0")).sourceRoot, await fs.realpath(disabled));

  const requestedUpgrade = parsePluginProfile({ ...desired, instances: desired.instances.map(instance => instance.id === "current"
    ? { ...instance, version: "2.0.0", config: { rejected: true } } : instance) });
  const retained = await loadPluginProfile({ ...input, profile: requestedUpgrade, previous: selected, reuseUnchangedPackages: true });
  assert.equal(retained.candidates[0], selected.candidates[0]);
  const retainedMetadata = pluginProfilePackageResolution(requestedUpgrade, retained, catalog);
  assert.equal(retainedMetadata.profile.instances[0]?.version, "1.0.0");
  assert.deepEqual(retainedMetadata.profile.instances[0]?.config, {});
  assert.equal((await readPluginManagementManifest(retainedMetadata.catalog, "io.test.current", "1.0.0")).provides.includes("endpoint.fixture@1"), true);
});
