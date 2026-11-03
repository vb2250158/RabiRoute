import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { messageEndpointCommandEnabled } from "./messageEndpointCommandSettings.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";

const manifest = (id: string, provides: string[], requires: string[] = []) => parsePluginManifest({ schemaVersion: 2,
  id, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides, requires, optional: [], permissions: [] });

test("manual CLI checks the native dependency graph and exact package identity without activating packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-command-"));
  const manifests = [manifest("io.test.speech", ["endpoint.speech@1"], ["manager.speech@1"]),
    manifest("io.test.service", ["manager.speech@1"], ["manager.core@1"]), manifest("io.test.core", ["manager.core@1"])];
  const instances = manifests.map((m, index) => ({ id: `instance:${index}`, package: m.id, version: m.version, enabled: true, config: {}, grants: [] }));
  const options = { profilePath: path.join(root, "profile.json"), settingsRoot: path.join(root, "settings"), packageRoots: [path.join(root, "packages")] };
  const writeProfile = () => fs.writeFile(options.profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances }));
  try {
    for (const m of manifests) {
      const directory = path.join(root, "packages", m.id, m.version);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify(m));
      await fs.writeFile(path.join(directory, "manager.mjs"), 'throw new Error("metadata check must never execute this");');
    }
    await writeProfile();
    assert.equal(await messageEndpointCommandEnabled("speech", options), true);
    instances[2]!.enabled = false; await writeProfile();
    assert.equal(await messageEndpointCommandEnabled("speech", options), false, "transitive disabled dependency rejects");
    instances[2]!.enabled = true; await writeProfile();
    await fs.writeFile(path.join(root, "packages", manifests[0]!.id, "1.0.0/rabi.plugin.json"), JSON.stringify({ ...manifests[0], id: "io.test.other" }));
    assert.equal(await messageEndpointCommandEnabled("speech", options), false, "substituted valid manifest must not authorize");
    await fs.writeFile(path.join(root, "packages", manifests[0]!.id, "1.0.0/rabi.plugin.json"), JSON.stringify({ ...manifests[0], version: "2.0.0" }));
    assert.equal(await messageEndpointCommandEnabled("speech", options), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Manager CLI uses actual native publication, current identity and exact endpoint instance", async () => {
  const service = manifest("io.test.service", ["manager.speech@1"]);
  const endpoint = manifest("io.test.speech", ["endpoint.speech@1"], ["manager.speech@1"]);
  const runtime = new GenerationRuntime({ host: "manager", applicationIdentity: { applicationGenerationId: "generation", managerInstanceId: "manager" },
    executor: { async prepare(candidate) { return { activate(context) { for (const capability of candidate.manifest.provides) context.services.provide(capability, {}); } }; } } });
  const candidate = (m: typeof endpoint, id: string): PluginCandidate => ({ instanceId: id, revision: m.version, manifest: m, config: {}, entry: { execution: "in_process", path: "unused.mjs" } });
  const server = http.createServer((_req, res) => {
    const current = runtime.current();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 0, data: { applicationGenerationId: current.applicationGenerationId, managerInstanceId: current.managerInstanceId,
      instances: current.records.map(row => ({ instanceId: row.identity.instanceId, pluginId: row.manifest.id, version: row.manifest.version,
        status: row.status, enabled: true, manifest: row.manifest })) } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { profilePath: "unused", settingsRoot: "unused", packageRoots: [], instanceId: "endpoint:speech",
    manager: { baseUrl: `http://127.0.0.1:${address.port}`, applicationGenerationId: "generation", managerInstanceId: "manager" } };
  try {
    await runtime.switch([candidate(endpoint, "endpoint:speech")]);
    assert.equal(runtime.current().records[0]?.status, "waiting_dependency");
    assert.equal(await messageEndpointCommandEnabled("speech", options), false);
    await runtime.switch([candidate(service, "service:speech"), candidate(endpoint, "endpoint:speech")]);
    assert.equal(await messageEndpointCommandEnabled("speech", options), true);
    assert.equal(await messageEndpointCommandEnabled("speech", { ...options, instanceId: "another:speech" }), false);
    assert.equal(await messageEndpointCommandEnabled("speech", { ...options, manager: { ...options.manager, managerInstanceId: "old-manager" } }), false);
    await runtime.switch([candidate(endpoint, "endpoint:speech")]);
    assert.equal(await messageEndpointCommandEnabled("speech", options), false);
  } finally { await runtime.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
