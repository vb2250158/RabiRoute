import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mountRemoteAgentManager } from "./remoteAgentManager.js";
import { pluginStorageMigrationFailure, pluginStorageRoot } from "../shared/pluginStorage.js";

test("remote native startup migrates only its own published Agent owners and isolates failures across node state roots", async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "remote-agent-storage-"));
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => errors.push(values));
  const owners: Array<Awaited<ReturnType<typeof mountRemoteAgentManager>>> = [];
  t.after(async () => { await Promise.all(owners.map(owner => owner.dispose())); await fs.rm(temporary, { recursive: true, force: true }); });
  const applicationRoot = path.join(temporary, "application"), id = "io.fixture.agent";
  const directory = path.join(applicationRoot, "runtime/plugins/packages", id, "0.1.1");
  await fs.mkdir(directory, { recursive: true });
  await fs.cp("plugins/contracts/plugin-sdk", path.join(directory, "sdk"), { recursive: true });
  await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id, version: "0.1.1",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: ["agent.adapter.fixture@1"], requires: ["host.agent-adapters@1"], optional: [], permissions: [] }));
  await fs.writeFile(path.join(directory, "agent-adapter.json"), JSON.stringify({ type: "fixture", capability: "agent.adapter.fixture@1",
    manifest: { type: "fixture", label: "Fixture", maturity: "experimental", transport: { protocol: "fixture", mode: "fixture" }, capabilities: {} }, sessionBinding: {} }));
  await fs.writeFile(path.join(directory, "manager.mjs"), `import {ownAgentAdapter} from './sdk/index.mjs';import fs from 'node:fs/promises';export async function activate(context){const descriptor=JSON.parse(await fs.readFile(new URL('./agent-adapter.json',import.meta.url),'utf8'));const host=context.services.require('host.agent-adapters@1');ownAgentAdapter(context,{...descriptor,operations:{read:()=>host.environment.RABIROUTE_STATE_ROOT}});}`);
  await fs.writeFile(path.join(directory, "storage-migrations.json"), JSON.stringify({ schemaVersion: 1, scope: "plugin", migrations: [
    { id: "auth-layout", kind: "file", source: { root: "state", path: "data/old-auth.json" }, target: "auth.json" }
  ] }));
  await fs.writeFile(path.join(applicationRoot, "runtime/agent-profile.json"), JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "original-instance", package: id, version: "0.1.1", enabled: true, config: {}, grants: [] }
  ] }));
  const healthyRoot = path.join(temporary, "node-healthy"), conflictRoot = path.join(temporary, "node-conflict");
  for (const stateRoot of [healthyRoot, conflictRoot]) {
    await fs.mkdir(path.join(stateRoot, "data"), { recursive: true });
    await fs.writeFile(path.join(stateRoot, "data/old-auth.json"), "original-owner-private-bytes");
  }
  const conflictTarget = path.join(pluginStorageRoot(id, undefined, { packageRoot: applicationRoot, stateRoot: conflictRoot }), "auth.json");
  await fs.mkdir(path.dirname(conflictTarget), { recursive: true });
  await fs.writeFile(conflictTarget, "already-owned-private-bytes");
  const conflict = await mountRemoteAgentManager({ applicationRoot, stateRoot: conflictRoot, getConfiguration: () => ({ nodeId: "node-conflict" }) });
  owners.push(conflict);
  assert.equal(conflict.context().getProviders!().length, 0);
  assert.ok(pluginStorageMigrationFailure(id, conflictRoot));
  assert.ok(conflict.diagnostics().some(row => row.instanceId === "original-instance" && /Both legacy and plugin-owned/.test(row.message)));
  const healthy = await mountRemoteAgentManager({ applicationRoot, stateRoot: healthyRoot, getConfiguration: () => ({ nodeId: "node-healthy" }) });
  owners.push(healthy);
  assert.equal(await healthy.context().invokeAgentOperation!("fixture", "read", {}), healthyRoot);
  assert.ok(pluginStorageMigrationFailure(id, conflictRoot), "Another node's preparation must not erase this owner's diagnosis.");
  assert.equal(pluginStorageMigrationFailure(id, healthyRoot), undefined);
  assert.equal(errors.length, 1, "The failed node exposes its migration diagnosis once in the existing process log.");
  assert.equal(await fs.readFile(path.join(healthyRoot, "data/plugins", id, "auth.json"), "utf8"), "original-owner-private-bytes");
  await assert.rejects(fs.access(path.join(healthyRoot, "data/old-auth.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(conflictRoot, "data/old-auth.json"), "utf8"), "original-owner-private-bytes");
  assert.equal(await fs.readFile(conflictTarget, "utf8"), "already-owned-private-bytes");
});
