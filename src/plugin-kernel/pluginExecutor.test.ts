import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeclarativePluginExecutor, RoutingPluginExecutor } from "./pluginExecutor.js";
import type { PluginCandidate, PluginContext, PluginIdentity, PluginManifest } from "./types.js";

const identity: PluginIdentity = {
  applicationGenerationId: "app-one",
  managerInstanceId: "manager-one",
  activationId: "activation-one",
  instanceId: "declarative",
  pluginId: "io.test.declarative",
  version: "1.0.0",
  revision: "one",
  host: "desktop"
};

test("RoutingPluginExecutor fails closed when a mode is not configured", () => {
  const manifest: PluginManifest = {
    schemaVersion: 2, id: "io.test.isolated", version: "1.0.0",
    entries: { manager: { execution: "isolated", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: "isolated", revision: "one", manifest, config: {},
    entry: { execution: "isolated", path: "manager.mjs" }
  };
  assert.throws(() => new RoutingPluginExecutor({}).prepare(candidate, { ...identity, host: "manager" }), /not configured/);
});

test("DeclarativePluginExecutor loads contributions without executing a module", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-declarative-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resource = path.join(root, "desktop.json");
  await fs.writeFile(resource, JSON.stringify({ contributions: [{ kind: "tray-menu", id: "open", value: { label: "Open" } }] }));
  const manifest: PluginManifest = {
    schemaVersion: 2, id: identity.pluginId, version: identity.version,
    entries: { desktop: { execution: "declarative", resource: "./desktop.json" } },
    provides: [], requires: [], optional: [], permissions: []
  };
  const candidate: PluginCandidate = {
    instanceId: identity.instanceId, revision: identity.revision, manifest, config: {},
    entry: { execution: "declarative", path: resource }
  };
  const values: unknown[] = [];
  const module = await new DeclarativePluginExecutor().prepare(candidate, identity);
  await module.activate({
    identity, config: {},
    services: { require() { throw new Error("unused"); }, optional() { return undefined; }, provide() {} },
    contributions: { register(value) { values.push(value); } },
    permissions: { has() { return false; }, require() { throw new Error("unused"); }, list() { return []; } },
    lifecycle: { signal: new AbortController().signal, fail() {} },
    effects: { add() {}, adopt() {} }
  } satisfies PluginContext);
  assert.deepEqual(values, [{ kind: "tray-menu", id: "open", value: { label: "Open" } }]);
});
