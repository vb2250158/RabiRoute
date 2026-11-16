import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPluginTestHarness } from "@rabiroute/plugin-sdk";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { MessageAdapterScanProviderRegistry } from "../../plugins/io.rabiroute.manager.message-adapter-control/src/manager/messageAdapterControl.js";
import { installDataMutationAuditSink } from "../../observability/dataMutationAudit.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const packageId = "io.rabiroute.manager.xiaomi-home";
const version = JSON.parse(fs.readFileSync(path.join(repo, "src/plugins", packageId, "rabi.plugin.json"), "utf8")).version as string;

test("shipped Xiaomi profile does not bind a private persona by default", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(repo, "plugins/profiles/desktop.json"), "utf8"));
  const plugin = profile.instances.find((item: { package: string }) => item.package === packageId);
  assert.equal(plugin.config.agentRoleId, undefined);
});

test("packaged Xiaomi owns its real runtime, native routes, settings and resource lifecycle across retirement", async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "xiaomi-plugin-owned-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  t.after(installDataMutationAuditSink(() => {}));
  const { buildPluginPackages } = await import(pathToFileURL(path.join(repo, "scripts/build-plugin-packages.mjs")).href);
  const output = path.join(root, "packages-output");
  await buildPluginPackages(repo, { packages: [packageId], outputDirectory: output });
  const packageRoot = path.join(output, "packages", packageId, version);
  const { activate } = await import(pathToFileURL(path.join(packageRoot, "manager.mjs")).href);
  const { hostModules } = await import(pathToFileURL(path.join(packageRoot, "manager-runtime.mjs")).href);
  assert.ok(hostModules.includes("manager/connectionRequestAccess"));
  assert.ok(hostModules.every((id: string) => !id.startsWith("integrations/xiaomiHome/")), "platform implementations must be present inside the package");
  assert.ok(fs.existsSync(path.join(packageRoot, "resources/Install-HomeAssistantOs.ps1")));
  const worker = spawn(process.execPath, [path.join(packageRoot, "workers/vacuumVideoWorker.mjs")], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  worker.stderr!.on("data", data => { stderr += data; });
  assert.equal((await once(worker, "exit"))[0], 2, "the real packaged worker must load and reject missing native arguments before doing any work");
  assert.equal(stderr, "");

  const registry = new ManagerPluginRouteRegistry();
  const scans = new MessageAdapterScanProviderRegistry();
  const loaded = new Map<string, unknown>();
  const runtimeDir = path.join(root, "runtime");
  const roleDirectory = path.join(root, "role");
  await fs.promises.mkdir(roleDirectory);
  const sharedHost = {
    scanProviders: scans,
    async prepareModules(ids: readonly string[]) {
      await Promise.all(ids.map(async id => {
        if (!loaded.has(id)) loaded.set(id, await import(pathToFileURL(path.join(repo, "src", `${id}.ts`)).href));
      }));
    },
    module<T>(id: string): T { if (!loaded.has(id)) throw new Error(`Unprepared shared module: ${id}`); return loaded.get(id) as T; },
    manager: {
      readOnly: false, rootDir: root, roleDirectory: () => roleDirectory, access: () => true,
      lifecycleFence: { applicationGenerationId: "generation-current", managerInstanceId: "manager-current" }, routes: registry
    },
    gatewayExecution: {
      rootDir: root, routeSnapshots: () => [], appendLog() {},
      childCommand() { throw new Error("This lifecycle test must not deliver to an Agent."); }, environmentForGateway: () => ({})
    }
  };
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url || "/", "http://127.0.0.1"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/agent/xiaomi-home`;
  const lifecycleHeaders = { "x-rabiroute-expected-application-generation-id": "generation-current", "x-rabiroute-expected-manager-instance-id": "manager-current" };
  const latestRecording = (headers: Record<string, string> = lifecycleHeaders) => fetch(`${baseUrl}/recordings/latest`, { headers });
  const createHarness = () => createPluginTestHarness({
    config: { runtimeDir, baseUrl: "http://127.0.0.1:1", eventMonitorEnabled: false, requestTimeoutMs: 250 },
    identity: { instanceId: "manager:xiaomi-home", pluginId: packageId, version, revision: "test", host: "manager" },
    services: [["host.message-endpoints@1", sharedHost]]
  });
  const first = createHarness();
  t.after(() => first.dispose());
  await first.activate({ activate });
  const catalog = registry.catalogSnapshot().operations;
  assert.equal(catalog.length, 54);
  assert.equal(new Set(catalog.map(item => item.contract.operationId)).size, catalog.length);
  const recordingOperations = catalog.filter(item => item.contract.operationId === "manager.xiaomi-home.recordings.latest");
  assert.equal(recordingOperations.length, 1);
  assert.equal(recordingOperations[0]!.contract.method, "GET");
  assert.equal(recordingOperations[0]!.contract.pathTemplate, "/api/agent/xiaomi-home/recordings/latest");
  assert.ok(registry.snapshot().flatMap(batch => batch.routes).every(route => route.match.kind !== "prefix"));
  assert.deepEqual(first.contributions.list().map(item => item.id), ["xiaomi-home-message-endpoint", "xiaomi-home-message-endpoint-auth", "endpoint-xiaomiHome-card", "xiaomi-home-devices"]);
  const health = await scans.snapshot().find(provider => provider.type === "xiaomiHome")!.scan();
  assert.equal(health.installed, true);
  assert.equal(health.requirements?.[0]?.ok, false, "an unconfigured real account remains authorization-required");
  const initialResponse = await fetch(`${baseUrl}/settings`);
  assert.equal(initialResponse.status, 200);
  const initial = (await initialResponse.json() as any).data;
  assert.equal((await latestRecording({})).status, 400);
  assert.equal((await latestRecording({ ...lifecycleHeaders, "x-rabiroute-expected-manager-instance-id": "stale" })).status, 409);
  const unboundRecording = await latestRecording();
  assert.equal(unboundRecording.status, 409);
  assert.equal((await unboundRecording.json() as any).error.code, "xiaomi_home_recording_role_required");
  const save = await fetch(`${baseUrl}/settings`, {
    method: "PUT", headers: { "content-type": "application/json", ...lifecycleHeaders },
    body: JSON.stringify({ settings: { ...initial.settings, eventDeliveryMode: "all", agentRoleId: "FixtureRole" }, revision: initial.revision })
  });
  assert.equal(save.status, 200, await save.text());
  const saved = (await (await fetch(`${baseUrl}/settings`)).json() as any).data;
  assert.equal(saved.settings.eventDeliveryMode, "all");
  const recording = await latestRecording();
  assert.equal(recording.status, 200);
  assert.deepEqual(await recording.json(), { code: 0, data: { artifact: null, settingsRevision: saved.revision } });
  await first.dispose();
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  assert.equal(scans.snapshot().length, 0);
  assert.equal((await fetch(`${baseUrl}/settings`)).status, 404);
  assert.equal((await latestRecording()).status, 404);

  const second = createHarness();
  t.after(() => second.dispose());
  await second.activate({ activate });
  assert.deepEqual(registry.catalogSnapshot().operations.map(item => item.contract.operationId).sort(), catalog.map(item => item.contract.operationId).sort());
  const restored = (await (await fetch(`${baseUrl}/settings`)).json() as any).data;
  assert.equal(restored.revision, saved.revision);
  assert.equal(restored.settings.eventDeliveryMode, "all");
  assert.equal(restored.settings.agentRoleId, "FixtureRole");
  const restoredRecording = await latestRecording();
  assert.equal(restoredRecording.status, 200);
  assert.deepEqual(await restoredRecording.json(), { code: 0, data: { artifact: null, settingsRevision: saved.revision } });
  await second.dispose();
  assert.equal(registry.catalogSnapshot().operations.length, 0);
  assert.equal(scans.snapshot().length, 0);
  assert.equal((await latestRecording()).status, 404);
});
