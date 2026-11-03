import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { RabiCordisHost } from "./cordisHost.js";
import { createMessageEndpointHostPorts } from "./messageEndpointHostPorts.js";
import { createGatewayListenerRuntime } from "./gatewayListenerRuntime.js";
import { mountGatewayEndpointPlugins } from "./gatewayEndpointPlugins.js";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/index.js";
import { createPluginManagement } from "../manager/pluginManagement.js";
import { createPluginManagementOperations } from "../manager/pluginManagementOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { MessageAdapterScanProviderRegistry } from "../manager/messageAdapterControl.js";
import { markAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import type { PluginCatalogApiContext } from "../manager/pluginCatalogRoutes.js";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Gateway watcher did not observe the committed plugin setting.");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test("real Webhook and Heartbeat packages disable, update and fail independently on one Gateway", { timeout: 240_000 }, async () => {
  const startedAt = Date.now();
  const stage = (name: string) => console.info("endpoint-package-stage", name, Date.now() - startedAt);
  stage("begin");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-packages-real-"));
  const host = new RabiCordisHost();
  const listener = createGatewayListenerRuntime({ identity: { gatewayId: "test-gateway", gatewayGenerationId: "test-generation", pid: process.pid }, publish() {} });
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    // The production package builder freezes and bundles the actual protocol implementation.
    // @ts-expect-error The production build script is a JavaScript module outside src.
    const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
    const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.endpoint.webhook", "io.rabiroute.endpoint.heartbeat"], outputDirectory: path.join(temporary, "built") });
    stage("actual-package-build");
    const profilePath = path.join(temporary, "profile.json");
    const instance = (type: string) => ({ id: `endpoint:${type}`, package: `io.rabiroute.endpoint.${type}`, version: "1.0.0", enabled: true, config: {}, grants: [] });
    await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [instance("webhook"), instance("heartbeat")] }));
    const settings = new PluginProfileSettings({ profilePath, settingsRoot: path.join(temporary, "settings") });
    const port = await freePort();
    const dataDir = path.join(temporary, "data");
    await fs.mkdir(dataDir);
    const shared = await createMessageEndpointHostPorts();
    const delivered: unknown[] = [];
    const routeConfig = { ...config, dataDir, memoryDataDir: dataDir, webhookPort: port, webhookPath: "/endpoint-test", webhookHost: "127.0.0.1", messageAdapterTypes: ["webhook", "heartbeat"] };
    const overrides: Record<string, unknown> = {
      config: { config: routeConfig },
      forwarding: { forwardMessage: (...args: unknown[]) => { delivered.push(args); }, recordMessageContextOnly() {} },
      history: new Proxy({}, { get: () => () => {} }),
      "automation/personaAutomationRuntime": { collectScheduledAutomationTasks: () => [] },
      "runtime/gatewayListenerRuntime": { getGatewayListenerRuntime: () => listener }
    };
    await assert.rejects(fs.access(settings.options.settingsRoot), /ENOENT/, "The first settings directory does not exist before Gateway startup.");
    const initialRoute = { id: "test-gateway", gatewayPort: port, enabled: true, messageAdapters: ["webhook", "heartbeat"], webhookPort: port, webhookPath: "/endpoint-test" };
    const runtime = await mountGatewayEndpointPlugins(host, { initialRouteDefinition: initialRoute, profilePath, settingsRoot: settings.options.settingsRoot, packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: ["webhook"], watch: true,
      hostPorts: { prepareModules: ids => shared.prepareModules(ids), module<T>(id: string): T { return (overrides[id] ?? shared.module(id)) as T; }, assertModules: ids => shared.assertModules(ids) } });
    stage("native-initial-mount");
    const activation = (type: string) => runtime.current().records.find(record => record.identity.instanceId === `endpoint:${type}`)?.identity.activationId;
    const webhookActivation = activation("webhook");
    assert.ok(webhookActivation, JSON.stringify(runtime.current().records));
    assert.ok(activation("heartbeat"));
    let webhookPath = "/endpoint-test";
    const post = async () => {
      const response = await fetch(`http://127.0.0.1:${port}${webhookPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "webhook.text", text: "package transport test" }) });
      assert.equal(response.status, 204, await response.text());
    };
    await post();
    assert.equal(delivered.length, 1);
    const originalHeartbeatActivation = activation("heartbeat");
    let heartbeatMessage = "new endpoint snapshot";
    await runtime.applyRouteSnapshot({ ...initialRoute, heartbeatMessage }, "heartbeat-route-revision");
    assert.notEqual(activation("heartbeat"), originalHeartbeatActivation);
    assert.equal(activation("webhook"), webhookActivation);
    await post();
    stage("heartbeat-route-switch");
    const changedHeartbeatActivation = activation("heartbeat");
    webhookPath = "/endpoint-next";
    await runtime.applyRouteSnapshot({ ...initialRoute, heartbeatMessage, webhookPath }, "webhook-route-revision");
    let routeWebhookActivation = activation("webhook");
    assert.notEqual(routeWebhookActivation, webhookActivation);
    assert.equal(activation("heartbeat"), changedHeartbeatActivation);
    await post();
    assert.equal(runtime.routeRevision(), "webhook-route-revision");
    await assert.rejects(runtime.applyRouteSnapshot({ ...initialRoute, gatewayPort: port + 1 }, "shared-change"), /Shared Route configuration/);
    assert.equal(activation("webhook"), routeWebhookActivation);


    stage("webhook-route-switch");
    const managerCatalog = new PluginPackageCatalog([built.packagesRoot]);
    const managerKernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.message-endpoints@1", value: {
      scanProviders: new MessageAdapterScanProviderRegistry(), routeSnapshots: () => []
    } }] });
    cleanup.push(async () => { await managerKernel.dispose(); await managerCatalog.dispose(); });
    const reconcileManager = async () => {
      const loaded = await loadPluginProfile({ profilePath, profile: (await settings.snapshot()).profile, packageCatalog: managerCatalog,
        runtimeRoot: path.join(temporary, "manager-runtime"), host: "manager" });
      await managerKernel.switch(loaded.candidates);
    };
    await reconcileManager();
    stage("manager-initial-mount");
    const managementContext: PluginCatalogApiContext = { runtime: managerKernel, root: () => temporary,
      renderCatalog: async () => { throw new Error("Not used by instance management."); } };
    managementContext.management = createPluginManagement({ runtime: managerKernel, settings, reconcile: reconcileManager,
      manifest: async (id, version) => (await managerCatalog.loadPackage(id, version, path.join(temporary, "manager-runtime"), "manager")).manifest });
    const managementRoutes = new ManagerPluginRouteRegistry();
    const registration = managementRoutes.registerOperations("host:management", createPluginManagementOperations(managementContext));
    const managementServer = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer endpoint-test") { response.writeHead(401).end(); return; }
      markAuthenticatedConnectionRequest(request, () => {});
      if (!managementRoutes.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
    });
    await new Promise<void>(resolve => managementServer.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await registration.dispose(); managementServer.closeAllConnections(); await new Promise<void>(resolve => managementServer.close(() => resolve())); });
    const managementBase = `http://127.0.0.1:${(managementServer.address() as {port: number}).port}`;
    const toggle = async (enabled: boolean) => {
      const response = await fetch(`${managementBase}/api/plugins/instances/endpoint%3Aheartbeat`, { method: "PATCH",
        headers: { authorization: "Bearer endpoint-test", "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: (await settings.snapshot()).revision, enabled }) });
      assert.equal(response.status, 200, await response.text());
    };

    // Production HTTP management writes the first sidecar; the Gateway sees it
    // through its native fs watcher. This path never calls runtime.reconcile().
    await toggle(false);
    await waitFor(() => activation("heartbeat") === undefined);
    const sidecars = await Promise.all((await fs.readdir(settings.options.settingsRoot)).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await fs.readFile(path.join(settings.options.settingsRoot, name), "utf8"))));
    assert.equal(sidecars.find(row => row.instanceId === "endpoint:heartbeat")?.enabled, false);
    assert.equal(JSON.parse(await fs.readFile(profilePath, "utf8")).instances.find((row: {id: string}) => row.id === "endpoint:heartbeat").enabled, true);
    assert.equal(activation("heartbeat"), undefined);
    assert.equal(activation("webhook"), routeWebhookActivation);
    heartbeatMessage = "Heartbeat transport configured while its plugin is disabled";
    await runtime.applyRouteSnapshot({...initialRoute, heartbeatMessage, webhookPath}, "disabled-heartbeat-route-revision");
    assert.equal(activation("heartbeat"), undefined);
    assert.equal(activation("webhook"), routeWebhookActivation, "Changing a disabled owner's transport cannot replace an unrelated activation.");
    await post();

    stage("native-watch-disabled");
    await toggle(true);
    await waitFor(async () => {
      if (!activation("heartbeat")) return false;
      try { return JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8")).heartbeat?.message === heartbeatMessage; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
    });
    const heartbeatActivation = activation("heartbeat");
    assert.ok(heartbeatActivation);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8")).heartbeat.message, heartbeatMessage);
    await settings.update("endpoint:heartbeat", { expectedRevision: (await settings.snapshot()).revision, config: { testRevision: 2 } });
    await runtime.reconcile();
    assert.notEqual(activation("heartbeat"), heartbeatActivation);
    assert.equal(activation("webhook"), routeWebhookActivation);

    stage("native-watch-restored-profile-update");
    const heartbeatEntry = path.join(built.packagesRoot, "io.rabiroute.endpoint.heartbeat/1.0.0/gateway.mjs");
    const originalHeartbeat = await fs.readFile(heartbeatEntry, "utf8");
    await fs.writeFile(heartbeatEntry, "export function activate() { throw new Error('controlled endpoint failure'); }\n");
    await runtime.reconcile();
    assert.equal(activation("webhook"), routeWebhookActivation);
    assert.match(runtime.current().records.find(record => record.identity.instanceId === "endpoint:heartbeat")?.error?.message || "", /controlled endpoint failure/);
    const confirmedRevision = runtime.routeRevision();
    await assert.rejects(runtime.applyRouteSnapshot({ ...initialRoute, heartbeatMessage: "rejected heartbeat", webhookPath }, "rejected-heartbeat"), /preparation was rejected/);
    assert.equal(runtime.routeRevision(), confirmedRevision);
    stage("affected-failure-rejected");
    const webhookBeforeUnrelatedChange = activation("webhook");
    webhookPath = "/endpoint-unrelated-failure";
    await runtime.applyRouteSnapshot({ ...initialRoute, heartbeatMessage, webhookPath }, "unrelated-failure-webhook");
    routeWebhookActivation = activation("webhook");
    assert.notEqual(routeWebhookActivation, webhookBeforeUnrelatedChange);
    assert.equal(runtime.routeRevision(), "unrelated-failure-webhook");

    await post();
    await fs.writeFile(heartbeatEntry, originalHeartbeat);
    await runtime.reconcile();

    stage("unrelated-owner-switch-restored-bad-package");
    const preservedHeartbeat = activation("heartbeat");
    const webhookBundle = path.join(built.packagesRoot, "io.rabiroute.endpoint.webhook/1.0.0/runtime.mjs");
    await fs.appendFile(webhookBundle, "\nexport const updatedProtocolRevision = 2;\n");
    await runtime.reconcile();
    assert.notEqual(activation("webhook"), webhookActivation);
    assert.equal(activation("heartbeat"), preservedHeartbeat);
    await post();
    assert.equal(delivered.length, 6);

    stage("actual-protocol-package-update");
    await settings.update("endpoint:webhook", { expectedRevision: (await settings.snapshot()).revision, enabled: false });
    await runtime.reconcile();
    assert.equal(activation("webhook"), undefined);
    assert.equal(activation("heartbeat"), preservedHeartbeat);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/endpoint-test`));
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8")).messageAdapters.heartbeat.status, "running");

    // The real Webhook bundle declares codexRuntime; Heartbeat does not. A failed
    // shared-owner import must fail just that package, before it opens a listener.
    stage("webhook-disable-closed-port");
    const brokenPorts = await createMessageEndpointHostPorts({ loaders: { codexRuntime: async () => { throw new Error("controlled unavailable Codex owner"); } } });
    const isolatedHost = new RabiCordisHost();
    const secondData = path.join(temporary, "independent-owner-data");
    await fs.mkdir(secondData);
    await settings.update("endpoint:webhook", { expectedRevision: (await settings.snapshot()).revision, enabled: true });
    await settings.update("endpoint:heartbeat", { expectedRevision: (await settings.snapshot()).revision, enabled: false });
    try {
      const independent = await mountGatewayEndpointPlugins(isolatedHost, { initialRouteDefinition: initialRoute, profilePath, settingsRoot: settings.options.settingsRoot, packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "independent-runtime"), adapterTypes: ["webhook"], watch: true,
        hostPorts: { prepareModules: ids => brokenPorts.prepareModules(ids), assertModules: ids => brokenPorts.assertModules(ids), module<T>(id: string): T {
          if (id === "config") return { config: { ...routeConfig, dataDir: secondData, memoryDataDir: secondData } } as T;
          return (overrides[id] ?? brokenPorts.module(id)) as T;
        } } });
      assert.equal(independent.current().records.find(record => record.identity.instanceId === "endpoint:heartbeat"), undefined);
      assert.equal(independent.current().records.find(record => record.identity.instanceId === "endpoint:webhook")?.status, "failed");
      // An endpoint disabled at boot must become usable through the original native watcher,
      // even though the resident boot environment contained only another endpoint ID.
      await settings.update("endpoint:heartbeat", { expectedRevision: (await settings.snapshot()).revision, enabled: true });
      await waitFor(async () => {
        if (!independent.current().records.some(record => record.identity.instanceId === "endpoint:heartbeat" && record.status === "active")) return false;
        try { return JSON.parse(await fs.readFile(path.join(secondData, "gateway-status.json"), "utf8")).messageAdapters?.heartbeat?.status === "running"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
      });
      assert.equal(JSON.parse(await fs.readFile(path.join(secondData, "gateway-status.json"), "utf8")).messageAdapters.heartbeat.status, "running");
    } finally { await isolatedHost.dispose(); }
    stage("unrelated-shared-owner-import-failed");
  } finally {
    stage("cleanup-begin");
    for (const dispose of cleanup.reverse()) await dispose();
    await host.dispose();
    await listener.dispose();
    stage("cleanup-complete");
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
