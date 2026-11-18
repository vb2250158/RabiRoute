import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import { createWebhookAdapter } from "../adapters/webhookAdapter.js";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { RabiCordisHost } from "./cordisHost.js";
import { createMessageEndpointHostPorts } from "./messageEndpointHostPorts.js";
import { createGatewayListenerRuntime, type GatewayListenerPublication } from "./gatewayListenerRuntime.js";
import { hashPluginPackage } from "../plugin-kernel/packageLoader.js";
import { mountGatewayEndpointPlugins } from "./gatewayEndpointPlugins.js";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/index.js";
import { createPluginManagement } from "../manager/pluginManagement.js";
import { createPluginManagementOperations } from "../manager/pluginManagementOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { MessageAdapterScanProviderRegistry } from "../plugins/io.rabiroute.manager.message-adapter-control/src/manager/messageAdapterControl.js";
import { markAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import type { PluginCatalogApiContext } from "../manager/pluginCatalogRoutes.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createGatewayRouteActivationOwner, type GatewayRouteActivationRuntime } from "../manager/gatewayRouteActivationOwner.js";
import { ManagerGatewayRuntimeService } from "../manager/managerGatewayRuntimeService.js";
import { gatewayRouteSnapshotRevision } from "../shared/gatewayRouteSnapshot.js";
import { bindGatewayRouteSnapshotReceiver } from "./gatewayRouteSnapshotReceiver.js";
import type { ForwardMessageOptions } from "../forwarding.js";
import { classifyRouteChange } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
import { normalizeGatewayDefinition, type GatewayDefinition } from "../shared/gatewayConfigModel.js";

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
  const publications: GatewayListenerPublication[] = [];
  const listener = createGatewayListenerRuntime({ identity: { gatewayId: "test-gateway", gatewayGenerationId: "test-generation", pid: process.pid },
    publish: snapshot => { publications.push(snapshot); } });
  const originalDataDir = config.dataDir, originalMemoryDataDir = config.memoryDataDir;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    // The production package builder freezes and bundles the actual protocol implementation.
    // @ts-expect-error The production build script is a JavaScript module outside src.
    const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
    const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.endpoint.webhook", "io.rabiroute.endpoint.heartbeat"], outputDirectory: path.join(temporary, "built") });
    stage("actual-package-build");
    const profilePath = path.join(temporary, "profile.json");
    const versions: Record<string, string> = {};
    for (const type of ["webhook", "heartbeat"]) versions[type] = JSON.parse(await fs.readFile(new URL(`../plugins/io.rabiroute.endpoint.${type}/rabi.plugin.json`, import.meta.url), "utf8")).version;
    const instance = (type: string) => ({ id: `endpoint:${type}`, package: `io.rabiroute.endpoint.${type}`, version: versions[type], enabled: true, config: {}, grants: [] });
    await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [instance("webhook"), instance("heartbeat")] }));
    const settings = new PluginProfileSettings({ profilePath, settingsRoot: path.join(temporary, "settings") });
    const port = await freePort();
    const dataDir = path.join(temporary, "data");
    await fs.mkdir(dataDir);
    // The single shared driver writes status through the actual Host config owner.
    config.dataDir = dataDir;
    config.memoryDataDir = dataDir;
    const shared = await createMessageEndpointHostPorts();
    const delivered: unknown[] = [];
    const routeConfig = { ...config, dataDir, memoryDataDir: dataDir, webhookPort: port, webhookPath: "/endpoint-test", webhookHost: "127.0.0.1", messageAdapterTypes: ["webhook", "heartbeat"] };
    const overrides: Record<string, unknown> = {
      config: { config: routeConfig },
      history: new Proxy({}, { get: () => () => {} }),
      "automation/personaAutomationRuntime": { collectScheduledAutomationTasks: () => [] },
      // Use the framework's existing listener/acceptance ports; nested Host imports
      // retain their real singleton identity after the implementation became shared.
      "adapters/webhookAdapter": { createWebhookAdapter: (profile: Parameters<typeof createWebhookAdapter>[0]) => createWebhookAdapter(profile, {
        apiOperations: { registerExternalListener: definition => listener.registerExternalListener("fixture-webhook", definition) },
        operationId: name => listener.operationId(name),
        acceptPayload(profile, webhookPath, payload, bodyBytes) {
          const text = String(payload.text ?? payload.message ?? payload.content ?? "");
          delivered.push({ endpoint: profile.type, webhookPath, bodyBytes, text });
          return { time: Date.now(), rawMessage: text, messageId: payload.id ?? `fixture-${delivered.length}`, source: profile.source };
        }
      }) }
    };
    await assert.rejects(fs.access(settings.options.settingsRoot), /ENOENT/, "The first settings directory does not exist before Gateway startup.");
    const initialRoute = { automationScheduleSchemaVersion: 1 as const, id: "test-gateway", gatewayPort: port, enabled: true, messageAdapters: ["webhook"], automationRules: [{ id: "test-schedule", trigger: { type: "schedule" as const, schedule: { id: "time", type: "interval" as const, intervalSeconds: 900 } }, action: { type: "deliver_agent" as const, message: "fixture-only" } }], webhookPort: port, webhookPath: "/endpoint-test" };
    const runtime = await mountGatewayEndpointPlugins(host, { initialRouteDefinition: initialRoute, profilePath, settingsRoot: settings.options.settingsRoot, packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: ["webhook"], watch: true,
      publishEndpointPlugins: listener.publishEndpointPlugins,
      hostPorts: { prepareModules: ids => shared.prepareModules(ids), module<T>(id: string): T { return (overrides[id] ?? shared.module(id)) as T; }, assertModules: ids => shared.assertModules(ids) } });
    stage("native-initial-mount");
    const activation = (type: string) => runtime.current().records.find(record => record.identity.instanceId === `endpoint:${type}`)?.identity.activationId;
    const webhookActivation = activation("webhook");
    const pluginReport = (type: string) => publications.at(-1)?.endpointPlugins?.find(item => item.instanceId === `endpoint:${type}`);
    const initialReport = pluginReport("webhook");
    assert.equal(initialReport?.activationId, webhookActivation);
    assert.equal(initialReport?.state, "active");
    const webhookPackage = path.join(built.packagesRoot, "io.rabiroute.endpoint.webhook", versions.webhook!);
    assert.equal(initialReport?.packageHash, await hashPluginPackage(webhookPackage));
    assert.ok(webhookActivation, JSON.stringify(runtime.current().records));
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === "endpoint:webhook")?.identity.managerInstanceId, initialRoute.id);
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === "endpoint:webhook")?.status, "active", JSON.stringify(runtime.current().records));
    assert.equal(runtime.current().records.find(record => record.identity.instanceId === "endpoint:webhook")?.error, undefined, JSON.stringify(runtime.current().records));
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
    const heartbeatEntry = path.join(built.packagesRoot, "io.rabiroute.endpoint.heartbeat", versions.heartbeat!, "gateway.mjs");
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
    const runningWebhook = activation("webhook");
    const routeWithSchedule = { ...initialRoute, heartbeatMessage, webhookPath };
    await runtime.applyRouteSnapshot({ ...routeWithSchedule, automationRules: [] }, "route-last-schedule-off");
    assert.equal(activation("heartbeat"), undefined);
    assert.equal(activation("webhook"), runningWebhook);
    await runtime.applyRouteSnapshot(routeWithSchedule, "route-first-schedule-on");
    assert.ok(activation("heartbeat"));
    assert.equal(activation("webhook"), runningWebhook);
    const preservedHeartbeat = activation("heartbeat");
    const webhookBundle = path.join(webhookPackage, "runtime.mjs");
    await fs.appendFile(webhookBundle, "\nexport const updatedProtocolRevision = 2;\n");
    await runtime.reconcile();
    assert.notEqual(activation("webhook"), webhookActivation);
    assert.equal(activation("heartbeat"), preservedHeartbeat);
    const updatedReport = pluginReport("webhook");
    assert.equal(updatedReport?.packageHash, await hashPluginPackage(webhookPackage));
    assert.notEqual(updatedReport?.packageHash, initialReport?.packageHash);
    assert.equal(updatedReport?.activationId, activation("webhook"));
    assert.equal(updatedReport?.state, "active");
    assert.equal(publications.at(-1)?.pid, process.pid);
    assert.equal(publications.at(-1)?.gatewayGenerationId, "test-generation");
    await post();
    assert.equal(delivered.length, 6);

    stage("actual-protocol-package-update");
    await settings.update("endpoint:webhook", { expectedRevision: (await settings.snapshot()).revision, enabled: false });
    await runtime.reconcile();
    assert.equal(activation("webhook"), undefined);
    assert.equal(activation("heartbeat"), preservedHeartbeat);
    assert.equal(pluginReport("webhook"), undefined);
    assert.equal(pluginReport("heartbeat")?.activationId, preservedHeartbeat);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/endpoint-test`));
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8")).messageAdapters.heartbeat.status, "running");

    const portBlocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      portBlocker.once("error", reject);
      portBlocker.listen(port, "127.0.0.1", resolve);
    });
    try {
      await settings.update("endpoint:webhook", { expectedRevision: (await settings.snapshot()).revision, enabled: true });
      await runtime.reconcile();
      await waitFor(() => runtime.current().records.some(record => record.identity.instanceId === "endpoint:webhook" && record.status === "failed"));
      assert.match(runtime.current().records.find(record => record.identity.instanceId === "endpoint:webhook")?.error?.message ?? "", /EADDRINUSE/);
      assert.equal(activation("heartbeat"), preservedHeartbeat);
    } finally {
      await new Promise<void>((resolve, reject) => portBlocker.close(error => error ? reject(error) : resolve()));
    }
    await runtime.reconcile();
    await waitFor(() => runtime.current().records.some(record => record.identity.instanceId === "endpoint:webhook" && record.status === "active" && !record.initialization));
    assert.equal(activation("heartbeat"), preservedHeartbeat);
    assert.equal(runtime.current().cleanupDiagnostics.some(item => item.instanceId === "endpoint:webhook" && !item.lateConfirmed), false);
    await post();
    assert.equal(delivered.length, 7);
    await settings.update("endpoint:webhook", { expectedRevision: (await settings.snapshot()).revision, enabled: false });
    await runtime.reconcile();
    stage("webhook-recovered-from-occupied-port");

    // Webhook depends on the shared listener driver; Heartbeat does not. A failed
    // shared-owner import must fail just that package, before it opens a listener.
    stage("webhook-disable-closed-port");
    await runtime.unmount();
    assert.deepEqual(publications.at(-1)?.endpointPlugins, []);
    const brokenPorts = await createMessageEndpointHostPorts({ loaders: { "adapters/webhookAdapter": async () => { throw new Error("controlled unavailable Webhook driver"); } } });
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
    try {
      stage("cleanup-begin");
      for (const dispose of cleanup.reverse()) await dispose();
      await host.dispose();
      await listener.dispose();
      stage("cleanup-complete");
    } finally {
      config.dataDir = originalDataDir;
      config.memoryDataDir = originalMemoryDataDir;
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
});


test("scheduled automation owns one native worker without a message connector card", { timeout: 120_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-worker-real-"));
  const host = new RabiCordisHost();
  try {
    // @ts-expect-error Production JavaScript builder is outside src.
    const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
    const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.endpoint.heartbeat"], outputDirectory: path.join(temporary, "built") });
    const descriptor = JSON.parse(await fs.readFile(path.join(process.cwd(), "src/plugins/io.rabiroute.endpoint.heartbeat/rabi.plugin.json"), "utf8"));
    const profilePath = path.join(temporary, "profile.json");
    await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "automation:timer", package: descriptor.id, version: descriptor.version, enabled: true, config: {}, grants: [] }] }));
    const dataDir = path.join(temporary, "data");
    await fs.mkdir(dataDir);
    const automationRules = [{ id: "scheduled-task", enabled: true, trigger: { type: "schedule", schedule: { id: "clock", type: "interval", intervalSeconds: 86400 } }, action: { type: "deliver_agent", message: "fixture: never sent" } }];
    const definition = { id: "timer-route", gatewayPort: 0, enabled: true, automationScheduleSchemaVersion: 1 as const, messageAdapters: [], automationRules };
    const scoped = { ...config, dataDir, routeProfiles: [{ ...definition }], messageAdapterTypes: [] };
    const shared = await createMessageEndpointHostPorts();
    const runtime = await mountGatewayEndpointPlugins(host, { initialRouteDefinition: definition as any, profilePath, settingsRoot: path.join(temporary, "settings"), packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: [], watch: false,
      hostPorts: { prepareModules: ids => shared.prepareModules(ids), assertModules: ids => shared.assertModules(ids), module<T>(id: string): T { return (id === "config" ? { config: scoped } : shared.module(id)) as T; } } });
    const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8"));
    assert.equal(runtime.current().records.filter(record => record.status === "active").length, 1);
    assert.equal((await read()).heartbeat.scheduleCount, 1);
    assert.equal((await read()).messageAdapters.heartbeat.enabled, true);
    await runtime.reconcile();
    assert.equal(runtime.current().records.filter(record => record.status === "active").length, 1, "reconciliation does not create a second worker");
    const settings = new PluginProfileSettings({ profilePath, settingsRoot: path.join(temporary, "settings") });
    await settings.update("automation:timer", { expectedRevision: (await settings.snapshot()).revision, enabled: false });
    await runtime.reconcile();
    assert.equal((await read()).messageAdapters.heartbeat.enabled, false);
    assert.equal((await read()).messageAdapters.heartbeat.status, "disabled");
  } finally {
    await host.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("the real scheduler starts on the first rule and stops after the last rule on the same Gateway", { timeout: 120_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "automation-hotplug-"));
  const input = new PassThrough(), output = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, pid: 42, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const host = new RabiCordisHost();
  let receiver: ReturnType<typeof bindGatewayRouteSnapshotReceiver> | undefined;
  const originalProfiles = config.routeProfiles;
  let finishDelivery!: () => void;
  const delivery = new Promise<void>(resolve => { finishDelivery = resolve; });
  const scheduledDeliveries: Array<ForwardMessageOptions["scheduledAutomation"]> = [];
  const metadata = JSON.parse(await fs.readFile(path.join(process.cwd(), "src/plugins/io.rabiroute.endpoint.heartbeat/route-config.json"), "utf8"));
  const activation = createGatewayRouteActivationOwner({ declarations: async () => [metadata], timeoutMs: 10000 });
  try {
    // @ts-expect-error Production JavaScript builder is outside src.
    const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
    const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.endpoint.heartbeat"], outputDirectory: path.join(temporary, "built") });
    const descriptor = JSON.parse(await fs.readFile(path.join(process.cwd(), "src/plugins/io.rabiroute.endpoint.heartbeat/rabi.plugin.json"), "utf8"));
    const profilePath = path.join(temporary, "profile.json");
    await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "automation:timer", package: descriptor.id, version: descriptor.version, enabled: true, config: {}, grants: [] }] }));
    const dataDir = path.join(temporary, "data");
    await fs.mkdir(dataDir);
    const raw: GatewayDefinition = { id: "timer-route", gatewayPort: 0, enabled: true, automationScheduleSchemaVersion: 1, messageAdapters: [], automationRules: [] };
    const original = normalizeGatewayDefinition(raw);
    const rule = { id: "original-task", enabled: true, trigger: { type: "schedule" as const, schedule: { id: "original-clock", type: "interval" as const, intervalSeconds: 86400 } }, action: { type: "deliver_agent" as const, message: "fixture: accepted delivery" } };
    const added = normalizeGatewayDefinition({ ...raw, automationRules: [rule] });
    const disabled = normalizeGatewayDefinition({ ...raw, automationRules: [{ ...rule, enabled: false }] });
    assert.equal(original.routeProfiles?.length, 0);
    assert.equal(added.routeProfiles?.length, 1);
    const messageRule = { ...rule, id: "message-rule", trigger: { type: "message" as const, regex: "hello" } };
    const withMessageRule = normalizeGatewayDefinition({ ...raw, automationRules: [rule, messageRule] });
    assert.equal(classifyRouteChange(added, withMessageRule, [metadata]).kind, "shared");
    const withRoleChange = { ...added, routeProfiles: added.routeProfiles?.map(profile => ({ ...profile, agentRoleId: "different-role" })) };
    assert.equal(classifyRouteChange(added, withRoleChange, [metadata]).kind, "shared");
    const shared = await createMessageEndpointHostPorts();
    const scoped = { ...config, dataDir, routeProfiles: [], messageAdapterTypes: [] };
    const native = await mountGatewayEndpointPlugins(host, { initialRouteDefinition: original, profilePath, stateRoot: temporary,
      settingsRoot: path.join(temporary, "settings"), packageRoots: [built.packagesRoot], runtimeRoot: path.join(temporary, "runtime"), adapterTypes: [], watch: false,
      hostPorts: { prepareModules: ids => shared.prepareModules(ids), assertModules: ids => shared.assertModules(ids), module<T>(id: string): T {
        if (id === "config") return { config: scoped } as T;
        if (id === "scheduling/heartbeatSchedules") return { nextHeartbeatScheduleTime: (_: unknown, now: Date, options: { lastScheduledAt?: Date }) => options.lastScheduledAt ? null : new Date(now.getTime() + 50) } as T;
        if (id === "automation/personaAutomationRuntime") return { ...shared.module<Record<string, unknown>>(id), claimAutomationRun: () => true, finishAutomationRun() {} } as T;
        if (id === "forwarding") return { async forwardMessageAndWait(_kind: unknown, _record: unknown, _values: unknown, options: ForwardMessageOptions) {
          scheduledDeliveries.push(options.scheduledAutomation);
          await delivery;
          return { status: "sent", matchedRuleCount: 1, sentPacketCount: 1, adapterOutcomes: [] };
        } } as T;
        return shared.module<T>(id);
      } } });
    assert.equal(native.current().records.length, 0);
    const runtime: GatewayRouteActivationRuntime = { definition: original, process: child, readiness: "ready", needsRestart: false };
    const runtimes = new Map([[original.id, runtime]]);
    let restarts = 0, snapshotFrames = 0;
    input.on("data", () => { snapshotFrames++; });
    const service = new ManagerGatewayRuntimeService<GatewayDefinition, GatewayRouteActivationRuntime>(runtimes, {
      loadDefinitions: () => [], normalizeDefinition: definition => definition, definitionFingerprint: gatewayRouteSnapshotRevision,
      createRuntime: definition => ({ definition, process: null, readiness: "stopped", needsRestart: false }),
      isRunning: item => Boolean(item.process), reconcileAction: item => item.needsRestart ? "restart" : "none",
      startRuntime() { throw new Error("The Gateway is already running."); }, stopRuntime() {}, restartRuntime() { restarts++; }
    });
    const identity = { gatewayId: original.id, gatewayGenerationId: "fixture-boot", pid: child.pid! };
    const initialRevision = gatewayRouteSnapshotRevision(original);
    receiver = bindGatewayRouteSnapshotReceiver({ input, output, identity, initialRevision, applySnapshot: native.applyRouteSnapshot });
    activation.attach(child, identity, original, initialRevision);
    for (const [definition, expectedWorkers] of [[added, 1], [disabled, 0]] as const) {
      assert.equal(classifyRouteChange(runtime.definition, definition, [metadata]).kind, "endpoint");
      service.loadDefinitions([definition]);
      const applying = activation.prepare(runtimes.values(), `fixture-save-${expectedWorkers}`);
      if (!expectedWorkers) {
        await waitFor(() => native.current().records.length === 0);
        assert.equal(receiver?.current().operation?.state, "pending");
        assert.equal(receiver?.current().revision, gatewayRouteSnapshotRevision(added));
        finishDelivery();
      }
      const receipt = await applying;
      assert.equal(receipt.state, "applied");
      assert.equal(receipt.gateways[0]?.pid, identity.pid);
      assert.equal(receipt.gateways[0]?.gatewayGenerationId, identity.gatewayGenerationId);
      assert.equal(runtime.needsRestart, false);
      service.reconcile();
      assert.equal(runtime.process, child);
      assert.equal(native.routeRevision(), gatewayRouteSnapshotRevision(definition));
      assert.equal(native.current().records.filter(record => record.status === "active").length, expectedWorkers);
      assert.equal(config.routeProfiles[0]?.automationRules?.[0]?.enabled, expectedWorkers === 1);
      const { heartbeat } = JSON.parse(await fs.readFile(path.join(dataDir, "gateway-status.json"), "utf8"));
      assert.equal(heartbeat.enabled, expectedWorkers === 1);
      assert.equal(heartbeat.scheduleCount, 1);
      if (expectedWorkers) {
        await waitFor(() => scheduledDeliveries.length === 1);
        assert.equal(scheduledDeliveries[0]?.route.automationRules?.[0]?.id, rule.id);
      } else {
        assert.equal(scheduledDeliveries.length, 1);
        assert.equal(heartbeat.lastDeliveryStatus, "sent");
      }
    }
    assert.equal(snapshotFrames, 2);
    assert.equal(restarts, 0);
    service.loadDefinitions([original]);
    assert.equal((await activation.prepare(runtimes.values(), "fixture-remove-rule")).state, "applied");
    assert.equal(config.routeProfiles.length, 0);
    assert.equal(restarts, 0);
  } finally {
    finishDelivery();
    config.routeProfiles = originalProfiles;
    activation.detach(child);
    await receiver?.dispose();
    await host.dispose();
    input.destroy(); output.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
