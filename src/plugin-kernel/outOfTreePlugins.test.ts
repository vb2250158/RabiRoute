import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GenerationRuntime } from "./generationRuntime.js";
import { loadPluginProfile, PluginPackageCatalog } from "./profile.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturePackageRoot = path.join(repositoryRoot, "test-fixtures", "plugin-platform", "packages");
const definitions = [
  { id: "fixture:message-source", package: "io.test.message-source", grants: ["message.receive"] },
  { id: "fixture:agent-adapter", package: "io.test.agent-adapter", grants: [] },
  { id: "fixture:route-policy", package: "io.test.route-policy", grants: [] }
] as const;

async function writeProfile(profilePath: string, enabled: readonly string[], grantSource = true): Promise<void> {
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 2,
    readyRequires: [],
    instances: definitions.map(definition => ({
      id: definition.id,
      package: definition.package,
      version: "1.0.0",
      enabled: enabled.includes(definition.id),
      config: {},
      grants: definition.id === "fixture:message-source" && !grantSource ? [] : definition.grants
    }))
  }), "utf8");
}

async function load(root: string, profilePath: string) {
  const packageRoot = path.join(root, "packages");
  return loadPluginProfile({
    profilePath,
    packageCatalog: new PluginPackageCatalog([packageRoot], { trustedInProcessRoots: [packageRoot] }),
    runtimeRoot: path.join(root, "runtime"),
    host: "manager"
  });
}

test("out-of-tree message source, Agent adapter, and route policy complete the plugin lifecycle without a process restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-out-of-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(fixturePackageRoot, path.join(root, "packages"), { recursive: true });
  const profilePath = path.join(root, "profile.json");
  const events: string[] = [];
  let loaded: Awaited<ReturnType<typeof load>> | undefined;
  const runtime = new GenerationRuntime({
    host: "manager",
    hostServices: [{ capability: "host.test-events@1", value: events }],
    grantedPermissions: identity => loaded?.grants(identity) ?? []
  });
  t.after(() => runtime.dispose());
  const managerPid = process.pid;

  await writeProfile(profilePath, definitions.map(item => item.id));
  loaded = await load(root, profilePath);
  const installed = await runtime.switch(loaded.candidates);
  assert.deepEqual(installed.generation.records.map(record => [record.identity.instanceId, record.status]), [
    ["fixture:agent-adapter", "active"],
    ["fixture:message-source", "active"],
    ["fixture:route-policy", "active"]
  ]);
  assert.equal(installed.generation.services.services.has("route.policy.fixture@1"), true);
  assert.equal(installed.generation.contributions.contributions.length, 3);
  assert.equal(process.pid, managerPid);

  const sourceEntry = path.join(root, "packages", "io.test.message-source", "1.0.0", "manager.mjs");
  await fs.appendFile(sourceEntry, "\n// revision two\n", "utf8");
  loaded = await load(root, profilePath);
  const updated = await runtime.switch(loaded.candidates);
  assert.equal(updated.generation.records.every(record => record.status === "active"), true);
  assert.equal(process.pid, managerPid);
  assert.equal(events.filter(event => event.startsWith("start:")).length, 6);
  assert.equal(events.filter(event => event.startsWith("stop:")).length, 3);

  const adapterEntry = path.join(root, "packages", "io.test.agent-adapter", "1.0.0", "manager.mjs");
  await fs.writeFile(adapterEntry, "export async function activate() { throw new Error('candidate failed'); }\n", "utf8");
  loaded = await load(root, profilePath);
  const rolledBack = await runtime.switch(loaded.candidates);
  assert.equal(rolledBack.generation.records.every(record => record.status === "active"), true);
  assert.equal(rolledBack.generation.records.some(record => record.error?.code === "update_failed_using_previous_revision"), true);
  assert.equal(rolledBack.generation.services.services.has("route.policy.fixture@1"), true);
  assert.equal(process.pid, managerPid);

  await writeProfile(profilePath, ["fixture:message-source", "fixture:agent-adapter"]);
  loaded = await load(root, profilePath);
  const disabled = await runtime.switch(loaded.candidates);
  assert.equal(disabled.generation.records.some(record => record.identity.instanceId === "fixture:route-policy"), false);
  assert.equal(disabled.generation.services.services.has("route.policy.fixture@1"), false);

  await writeProfile(profilePath, []);
  loaded = await load(root, profilePath);
  const uninstalled = await runtime.switch(loaded.candidates);
  assert.deepEqual(uninstalled.generation.records, []);
  assert.equal(uninstalled.generation.contributions.contributions.length, 0);
  assert.deepEqual([...uninstalled.generation.services.services.keys()], ["host.test-events@1"]);
  assert.equal(events.filter(event => event.startsWith("start:")).length, events.filter(event => event.startsWith("stop:")).length);
  await fs.rm(path.join(root, "packages", "io.test.route-policy"), { recursive: true, force: true });
});

test("out-of-tree plugins wait for missing dependencies and fail closed on missing permissions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-out-of-tree-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(fixturePackageRoot, path.join(root, "packages"), { recursive: true });
  const profilePath = path.join(root, "profile.json");

  await writeProfile(profilePath, ["fixture:route-policy"]);
  let loaded = await load(root, profilePath);
  let runtime = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.test-events@1", value: [] }] });
  const waiting = await runtime.switch(loaded.candidates);
  assert.equal(waiting.generation.records[0]?.status, "waiting_dependency");
  assert.deepEqual([...(waiting.generation.records[0]?.missingCapabilities ?? [])].sort(), ["agent.adapter.fixture@1", "message.source.fixture@1"]);
  await runtime.dispose();

  await writeProfile(profilePath, ["fixture:message-source"], false);
  loaded = await load(root, profilePath);
  runtime = new GenerationRuntime({
    host: "manager",
    hostServices: [{ capability: "host.test-events@1", value: [] }],
    grantedPermissions: loaded.grants
  });
  const denied = await runtime.switch(loaded.candidates);
  assert.equal(denied.generation.records[0]?.status, "failed");
  assert.match(denied.generation.records[0]?.error?.message ?? "", /not granted/);
  assert.equal(denied.generation.contributions.contributions.length, 0);
  await runtime.dispose();
});
