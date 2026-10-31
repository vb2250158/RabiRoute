import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/profile.js";
import { ManagerPluginRouteRegistry, createManagerApiOperationsService } from "./managerPluginRouteRegistry.js";
import { diagnosticsCandidateForTests } from "./diagnosticsCandidate.fixture.js";

test("built diagnostics package survives replacement and failed candidate, drains and unloads", { timeout: 30000 }, async t => {
  const source = await diagnosticsCandidateForTests("io.rabiroute.manager.diagnostics");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-diagnostics-loader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(source, root, { recursive: true });
  const packageRoot = path.join(root, "packages");
  const profilePath = path.join(root, "profile.json");
  const instance = { id: "manager:diagnostics", package: "io.rabiroute.manager.diagnostics", version: "1.0.0", enabled: true, config: {}, grants: [] };
  const profile = (instances: unknown[]) => fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances }));
  const registry = new ManagerPluginRouteRegistry();
  let ownerValue = "first";
  const runtime = new GenerationRuntime({ host: "manager", hostServices: [
    { capability: "manager.core@1", value: {} },
    { capability: "host.manager.gateway-status@1", value: { readStatuses: () => [{ id: "good", name: ownerValue }, { id: "bad", lastError: "local error" }, { id: "also-good", running: true }] } },
    { capability: "host.manager.operations@1", value: createManagerApiOperationsService(registry) }
  ] });
  t.after(() => runtime.dispose());
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const read = () => new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: address.port, path: "/api/gateways" }, response => {
      let data = ""; response.setEncoding("utf8"); response.on("data", value => data += value);
      response.on("end", () => resolve({ status: response.statusCode!, body: data ? JSON.parse(data) : null }));
    }).on("error", reject);
  });
  const load = () => loadPluginProfile({ profilePath, packageCatalog: new PluginPackageCatalog([packageRoot], { trustedInProcessRoots: [packageRoot] }), runtimeRoot: path.join(root, "runtime"), host: "manager" });
  await profile([instance]);
  let loaded = await load();
  let result = await runtime.switch(loaded.candidates);
  assert.equal(result.generation.records[0]?.status, "active");
  const first = await read(); assert.equal(first.status, 200); assert.equal(first.body.length, 3);
  const entry = path.join(packageRoot, instance.package, instance.version, "manager.mjs");
  const original = await fs.readFile(entry, "utf8");
  for (let i = 0; i < 3; i++) {
    ownerValue = `revision-${i}`;
    await fs.writeFile(entry, original + `\n// revision ${i}\n`);
    loaded = await load(); result = await runtime.switch(loaded.candidates);
    assert.equal(result.generation.records[0]?.status, "active");
    assert.equal((await read()).body[0].name, ownerValue);
    assert.deepEqual(result.generation.cleanupDiagnostics, []);
  }
  await fs.writeFile(entry, 'export function activate() { throw new Error("failed candidate"); }');
  loaded = await load(); result = await runtime.switch(loaded.candidates);
  assert.equal(result.generation.records[0]?.error?.code, "update_failed_using_previous_revision");
  assert.equal((await read()).status, 200);
  await profile([]); loaded = await load(); result = await runtime.switch(loaded.candidates);
  assert.equal((await read()).status, 404);
  assert.equal(result.generation.records.length, 0);
  assert.equal(result.generation.contributions.contributions.length, 0);
  assert.deepEqual(result.generation.cleanupDiagnostics, []);
  await runtime.dispose();
});
