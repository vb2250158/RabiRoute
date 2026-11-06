import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { configureTimeouts, getTimeoutMs, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS } from "./managerRuntimeOwner.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mountAgentAdapterCatalogPlugin } from "../plugins/io.rabiroute.manager.agent-adapter-catalog/src/manager/agentAdapterCatalog.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { createNapcatControlOperations } from "../plugins/io.rabiroute.endpoint.napcat/src/manager/napcatControlRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { canonicalManagerPluginFixture } from "./canonicalManagerPlugin.fixture.js";
import { canonicalPluginSourcesFixture } from "./canonicalPluginSource.fixture.js";
import type { PluginManifest, PluginModule } from "../plugin-kernel/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertSourceRetainsRoutes(relativePath: string, routes: readonly string[]): void {
  const owner = source(relativePath);
  for (const route of routes) {
    assert.equal(owner.includes(route), true, `${relativePath} must retain ${route}`);
  }
}

const migratedCentralRouteFragments = [
  "/api/playback/request",
  "/api/fennenote/playback",
  "/api/fennenote/reply",
  "/api/message-processing/board",
  "/gateways",
  "/network-options",
  "/reload",
  "/api/scan/message-adapters",
  "/api/scan/agents",
  "/api/agent-adapters/",
  "/api/agent-state",
  "/api/agent/threads",
  "/api/agent/requests",
  "/api/agent/send",
  "/api/agent/copilot-install",
  "/api/agent/copilot-login",
  "/api/agent/copilot-status",
  "/api/agent/astrbot-login-test",
  "/api/deploy-astrbot-adapter",
  "/api/agent/marvis-open",
  "/api/remote-agent/",
  "/meta",
  "/api/gateways",
  "/open-config-file",
  "/manager/start",
  "/manager/desktop-lifecycle/start",
  "/manager/shutdown",
  "/api/message/napcat-"
] as const;

test("migrated Agent resource and release reads have no second production dispatcher", () => {
  const legacy = source("src/plugins/io.rabiroute.manager.core/src/manager/lanAgentRoutes.ts");
  assert.doesNotMatch(legacy, /function writeAsset\s*\(|releaseAssetMatch/);
  assert.doesNotMatch(legacy, /requestUrl\.pathname\s*===\s*"\/api\/lan-agent\/releases\/manifest"/);
  assert.doesNotMatch(legacy, /\["\/api\/lan-agent\/resources",\s*"\/api\/lan-agent\/resources\/read"\]/);
  assert.match(source("src/plugins/io.rabiroute.manager.core/manager.mjs"), /createLanAgentReadOperations\(lanAgentContext\)/);
});

test("LAN upgrades are core-owned executable bindings without a second central listener", () => {
  const central = source("src/manager/controlPlaneRoutes.ts"), core = source("src/plugins/io.rabiroute.manager.core/manager.mjs");
  assert.doesNotMatch(central, /lanAgentRegistry\.attach\(activeServer/);
  assert.match(central, /managerPluginRoutes\.handleUpgrade\(request, url, socket, head\)/);
  assert.match(core, /registerUpgrades\(context\.identity\.instanceId/);
  assert.match(core, /upgrades\.stopAccepting\(\)/);
  // Actual drain order and cleanup failures are verified by corePluginCleanup.test.ts.
  assert.match(core, /registration\.dispose\(\)/);
  assert.match(core, /upgrades\.dispose\(\)/);
});

test("terminal and computer operations have no old boolean HTTP adapters", () => {
  for (const file of ["src/plugins/io.rabiroute.manager.core/src/manager/lanAgentRoutes.ts", "src/plugins/io.rabiroute.manager.core/src/manager/lanAgentTerminalRoutes.ts", "src/plugins/io.rabiroute.manager.core/src/manager/lanAgentComputerRoutes.ts"]) {
    assert.doesNotMatch(source(file), /\bhandleLanAgent(?:Terminal|Computer)Api\b/);
  }
  const core = source("src/plugins/io.rabiroute.manager.core/manager.mjs");
  assert.match(core, /createLanAgentTerminalOperations\(lanAgentContext\)/);
  assert.match(core, /createLanAgentComputerOperations\(lanAgentContext\)/);
});

test("plugin-owned Manager APIs have no legacy central dispatch branches", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const handlerStart = central.indexOf("const handleManagerRequest =");
  const handlerEnd = central.indexOf("activeServer.requestTimeout", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const centralDispatch = central.slice(handlerStart, handlerEnd);

  for (const route of migratedCentralRouteFragments) {
    assert.equal(
      centralDispatch.includes(route),
      false,
      `${route} must remain outside the central HTTP dispatch chain`
    );
  }
  assert.doesNotMatch(central, /function forwardFenneNoteRequest\s*\(/);
  assert.doesNotMatch(central, /function forwardPlaybackRequest\s*\(/);
});

test("plugin route modules retain every migrated endpoint family", () => {
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.message-processing-control/src/manager/messageProcessingOperations.ts", [
    "/api/message-processing/board",
    "/api/message-processing/requirements"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.gateway-runtime/src/manager/gatewayControlOperations.ts", [
    "/gateways",
    "/network-options",
    "/reload",
    "manual-trigger",
    "agent-delivery-test",
    "delivery-replay",
    "weixin-login"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.message-adapter-control/src/manager/messageAdapterControl.ts", [
    "/api/scan/message-adapters"
  ]);
  assertSourceRetainsRoutes("src/manager/agentAdapterCatalogContract.ts", [
    "/api/scan/agents",
    "/api/scan/agents/dsh",
    "/api/scan/agents/grokBot",
    "/api/agent-adapters/catalog"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.agent-thread-control/src/manager/agentThreadControlOperations.ts", [
    "/api/agent/threads"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.agent-communication/src/manager/agentCommunicationRoutes.ts", [
    "/api/agent/requests",
    "/api/agent/send",
    "/api/agent/send/traces",
    "receipts"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.agent.copilot-cli/src/manager/copilotControlOperations.ts", [
    "/api/agent/copilot-install",
    "/api/agent/copilot-login",
    "/api/agent/copilot-status"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.agent.astrbot/src/manager/astrbotControlOperations.ts", [
    "/api/agent/astrbot-login-test"
  ]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.agent.marvis/src/manager/marvisControlOperations.ts", ["/api/agent/marvis-open"]);
  assertSourceRetainsRoutes("src/manager/remoteAgentContract.ts", [
    "/api/remote-agent/devices",
    "/api/remote-agent/scan",
    "/api/remote-agent/connect",
    "/api/remote-agent/disconnect",
    "/api/remote-agent/tasks",
    "/api/remote-agent/task-events"
  ]);
  assertSourceRetainsRoutes("src/manager/corePublicOperations.ts", ["/meta"]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.diagnostics/operations.mjs", ["/api/gateways"]);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.desktop/src/manager/desktopControlRoutes.ts", [
    "/open-config-file"
  ]);
  assert.equal(fs.existsSync(path.join(root, "src/manager/desktopLifecycleRoutes.ts")), false);
  const unexpectedNativeAction = (): never => { throw new Error("Discovery must not execute a native NapCat action."); };
  const napcatPaths = createNapcatControlOperations({
    repairAll: unexpectedNativeAction, ensureReady: unexpectedNativeAction, health: unexpectedNativeAction,
    loginPanel: unexpectedNativeAction, loginAction: unexpectedNativeAction, configureOneBot: unexpectedNativeAction,
    add: unexpectedNativeAction, launch: unexpectedNativeAction, restart: unexpectedNativeAction, remove: unexpectedNativeAction
  }).map(operation => operation.contract.pathTemplate);
  for (const route of [
    "/api/message/napcat-repair-all",
    "/api/message/napcat-ensure-ready",
    "/api/message/napcat-health",
    "/api/message/napcat-configure-onebot",
    "/api/message/napcat-add",
    "/api/message/napcat-launch",
    "/api/message/napcat-restart",
    "/api/message/napcat-remove"
  ]) assert.ok(napcatPaths.includes(route), `Native NapCat definitions must retain ${route}`);
});

test("catalog owns aggregate APIs while nine Agent packages independently own dedicated scan routes", async t => {
  const { EffectScope, PublicationScope } = await import(pathToFileURL(path.join(root, "plugins/contracts/plugin-sdk/index.mjs")).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-owners-"));
  const routes = new ManagerPluginRouteRegistry();
  const scopes = new Map<string, InstanceType<typeof EffectScope>>();
  t.after(async () => {
    const results = await Promise.allSettled([...scopes.values()].map(scope => scope.dispose()));
    fs.rmSync(directory, { recursive: true, force: true });
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Agent route fixture owners did not finish cleanup.");
  });
  async function mount(instanceId: string, entry: PluginModule["activate"], host: unknown, manifest: PluginManifest) {
    const effects = new EffectScope();
    scopes.set(instanceId, effects);
    const publication = new PublicationScope(effects);
    await entry({ identity: { instanceId, pluginId: manifest.id, version: manifest.version, applicationGenerationId: "fixture-app",
      managerInstanceId: "fixture-manager", activationId: instanceId, revision: "fixture", host: "manager" }, config: {}, effects, publication,
      lifecycle: { signal: effects.signal(), fail(error) { throw error; } }, permissions: { has: () => true, require() {}, list: () => [] },
      services: { require<T>() { return host as T; }, optional() { return undefined; }, provide() {} }, contributions: { register() {} } });
    await effects.commit();
    publication.publish();
    publication.seal()();
    await publication.afterPublish(Promise.resolve());
  }
  function owners(url: string) {
    return routes.catalogSnapshot().operations.filter(operation =>
      operation.contract.pathTemplate === url && operation.contract.method === "GET"
    ).map(operation => operation.owner.instanceId);
  }
  let stopped = false;
  const runtime = {
    rootDir: root, runtimes: new Map(), managerPluginRoutes: routes,
    async mountAgentAdapterCatalogPlugin(options: Parameters<typeof mountAgentAdapterCatalogPlugin>[0]) {
      const mount = await mountAgentAdapterCatalogPlugin({ ...options, listManifests: async () => [] });
      return { ...mount, async stop(reason?: string) { await mount.stop(reason); stopped = true; } };
    },
    agentAdapterCatalogService: undefined as unknown
  };
  const catalogInstance = "manager:agent-adapter-catalog";
  const catalogFixture = await canonicalManagerPluginFixture("agent-adapter-catalog", runtime);
  await mount(catalogInstance, catalogFixture.module.activate, catalogFixture.ports, catalogFixture.manifest);
  const aggregateRoutes = routes.catalogSnapshot().operations.filter(operation => operation.owner.instanceId === catalogInstance);
  assert.deepEqual(aggregateRoutes.map(operation => operation.contract.pathTemplate).sort(), [
    "/api/agent-adapters/catalog", "/api/agent-adapters/hooks/update", "/api/scan/agents"
  ]);
  for (const url of ["/api/scan/agents", "/api/agent-adapters/catalog"]) {
    assert.deepEqual(owners(url), [catalogInstance]);
  }

  const packages = (await canonicalPluginSourcesFixture()).filter(source => source.manifest.id.startsWith("io.rabiroute.agent."));
  assert.equal(packages.length, 9);
  const agents: Array<{ type: string; instanceId: string; remount(): Promise<void> }> = [];
  for (const { directory: sourceRoot, manifest } of packages) {
    const packageId = manifest.id;
    const descriptor = JSON.parse(source(path.relative(root, path.join(sourceRoot, "agent-adapter.json"))));
    const spec = JSON.parse(source(path.relative(root, path.join(sourceRoot, "manager-runtime.build.json"))));
    const implementation = spec.exports.find((entry: { name: string }) => entry.name === "createManager");
    assert.ok(implementation, packageId);
    const fixtureRoot = path.join(directory, packageId);
    const sdkRoot = path.join(fixtureRoot, "node_modules/@rabiroute/plugin-sdk");
    fs.mkdirSync(sdkRoot, { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, "manager.mjs"), path.join(fixtureRoot, "manager.mjs"));
    fs.copyFileSync(path.join(sourceRoot, "agent-adapter.json"), path.join(fixtureRoot, "agent-adapter.json"));
    fs.writeFileSync(path.join(sdkRoot, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
    fs.writeFileSync(path.join(sdkRoot, "index.mjs"),
      `export * from ${JSON.stringify(pathToFileURL(path.join(root, "plugins/contracts/plugin-sdk/index.mjs")).href)};`);
    // Source-level activation: only replace the generated bundle wrapper. The
    // actual entry, package metadata, platform factory, SDK and registry execute.
    fs.writeFileSync(path.join(fixtureRoot, "manager-runtime.mjs"),
      `import * as owned from ${JSON.stringify(pathToFileURL(path.join(root, implementation.source)).href)};\n`
      + `export const hostModules = [];\nexport function createImplementation() { return { createManager: owned[${JSON.stringify(implementation.exportName ?? implementation.name)}] }; }\n`);
    const { activate: activateAgent } = await import(pathToFileURL(path.join(fixtureRoot, "manager.mjs")).href);
    const instanceId = `agent:${packageId.slice("io.rabiroute.agent.".length)}`;
    const host = {
      async prepareModules(modules: unknown[]) { assert.deepEqual(modules, []); },
      manager: {
        rootDir: directory, packageRoot: root, readOnly: () => false,
        managerInstanceId: () => "fixture-manager", getRuntimes: () => [],
        publishManagerEvent() {},
        runScan() { throw new Error("Route publication must not run discovery."); },
        registerOperations: (instance: string, definitions: readonly ApiOperationDefinition[], signal: AbortSignal) =>
          routes.registerOperationsAsync(instance, definitions, signal)
      }
    };
    const remount = () => mount(instanceId, activateAgent, host, manifest);
    await remount();
    agents.push({ type: descriptor.type, instanceId, remount });
  }
  const assertScanOwners = (removed = new Set<string>()) => {
    for (const agent of agents) {
      assert.deepEqual(owners(`/api/agent-adapters/scan/${agent.type}`), removed.has(agent.type) ? [] : [agent.instanceId]);
    }
    for (const type of ["dsh", "grokBot"]) {
      const agent = agents.find(agent => agent.type === type)!;
      assert.deepEqual(owners(`/api/scan/agents/${type}`), removed.has(type) ? [] : [agent.instanceId]);
    }
    assert.deepEqual(owners("/api/scan/agents"), [catalogInstance]);
  };
  assertScanOwners();
  for (const agent of agents) {
    await scopes.get(agent.instanceId)!.dispose();
    assertScanOwners(new Set([agent.type]));
    await agent.remount();
    assertScanOwners();
  }
  for (const agent of agents) await scopes.get(agent.instanceId)!.dispose();
  await scopes.get(catalogInstance)!.dispose();
  assert.equal(stopped, true);
  assert.deepEqual(routes.snapshot(), []);
});

test("Agent state reporting is registered by the Agent state plugin package", () => {
  const plugin = source("src/plugins/io.rabiroute.manager.agent-state-control/manager.mjs");
  assert.match(plugin, /await runtime\.managerPluginRoutes\.registerOperationsAsync\(context\.identity\.instanceId, runtime\.createAgentStateReportOperations\(\), context\.lifecycle\.signal\)/);
  assertSourceRetainsRoutes("src/plugins/io.rabiroute.manager.agent-state-control/src/manager/agentStateReportOperations.ts", ["/api/agent-state"]);
  assert.doesNotMatch(source("src/manager/controlPlaneRoutes.ts"), /function handleAgentStateReport\s*\(/);
});

test("Outbox no longer calls the retired FenneNote output implementation", () => {
  const outbox = source("src/outbox.ts");
  assert.doesNotMatch(outbox, /fenneNoteOutput/);
  assert.doesNotMatch(outbox, /async function postFenneNoteOutput\s*\(/);
});


test("NapCat endpoint owns native process lifecycle and drains its own actions", () => {
  const plugin = source("src/plugins/io.rabiroute.endpoint.napcat/manager.mjs");
  assert.match(plugin, /owner\.context\(assertAccepting\)/);
  assert.match(plugin, /supervisor\.stop\(\), retired, \.\.\.flights/);
  assert.match(plugin, /owner\.remove\(body\)/);
  assert.doesNotMatch(plugin, /runWindowsTaskkill|process\.kill/);
  assert.match(source("src/plugins/io.rabiroute.endpoint.napcat/src/integrations/napcat/managerOwner.ts"), /new NapcatLifecycleOwner/);
  assert.doesNotMatch(source("src/manager/controlPlaneRoutes.ts"), /new NapcatLifecycleOwner/);
});

test("Remote Agent rejects WebSocket work before HTTP request drain", () => {
  const plugin = source("src/plugins/io.rabiroute.manager.remote-agent/manager.mjs");
  assert.match(plugin, /hub\?\.stopAccepting\(\);[\s\S]*await registration\?\.dispose\(\);[\s\S]*await hub\?\.shutdown\(\)/);
});

test("Manager forced shutdown consumes defaults and configured teardown budgets after owner teardown starts", t => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const teardownStart = central.indexOf("managerRuntimeOwner.teardown(`signal:${reason}`)");
  const forcedExitStart = central.indexOf("const forcedExit = setTimeout(", teardownStart);
  assert.ok(teardownStart >= 0 && forcedExitStart > teardownStart);
  const forcedExitContract = central.slice(forcedExitStart, forcedExitStart + 500);
  assert.match(forcedExitContract, /\(\) => process\.exit\(1\)/);
  const ast = ts.createSourceFile("controlPlaneRoutes.ts", central, ts.ScriptTarget.Latest, true);
  let delay: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "forcedExit"
      && node.initializer && ts.isCallExpression(node.initializer)) delay = node.initializer.arguments[1]?.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(delay);
  const evaluate = new Function("getTimeoutMs", "DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS", `return (${delay});`);
  const previous = readTimeoutOverrides(); t.after(() => configureTimeouts(previous));
  const key = "backend.manager.managerRuntimeOwner.DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS";
  for (const value of [undefined, 45000, 2147483647]) {
    configureTimeouts(value === undefined ? {} : { [key]: value });
    assert.equal(evaluate(getTimeoutMs, DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS),
      Math.min(2147483647, (value ?? DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS) + 1000));
  }
});

test("Manager RuntimeOwner gives the Cordis root sole ownership of shared Fiber disposal", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const rootOwner = central.indexOf('managerRuntimeOwner.register("cordis_root"');
  const pluginOwner = central.indexOf('managerRuntimeOwner.registerWithBudget("manager_plugin_kernel"');
  assert.ok(rootOwner >= 0 && pluginOwner > rootOwner);
  assert.match(central, /managerRuntimeOwner\.register\("cordis_root",\s*\(\) => managerCordisRoot\.dispose\(\)\)/);
  const pluginRegistration = central.slice(pluginOwner, pluginOwner + 300);
  assert.match(pluginRegistration, /async budget => \{[\s\S]*await managerPluginKernel\?\.shutdown\(\{\s*timeoutMs: Math\.max\(1, Math\.floor\(budget\.deadlineAt - performance\.now\(\)\)\)\s*\}\)/);
  assert.doesNotMatch(pluginRegistration, /managerPluginKernel\?\.dispose\(/);
  assert.doesNotMatch(central, /managerSharedResourcesRuntime\.unmount\(\)|disposeManagerCordisRuntime/);
});

test("removed compatibility APIs stay absent from their former owners", () => {
  assert.doesNotMatch(source("src/manager/controlPlaneRoutes.ts"), /handleResourceCacheApi|handleLegacyResourceCacheApi|handleRecordingArchiveAdminApi/);
  assert.doesNotMatch(source("src/plugins/io.rabiroute.manager.core/manager.mjs"), /routeId: ["']resource-cache["']|runtime\.handleResourceCacheApi/);
  assert.doesNotMatch(source("src/manager/resourceCache.ts"), /export function resourceCacheHandler/);
  assert.doesNotMatch(source("src/manager/recordingArchiveRoutes.ts"), /recordingArchiveHandler|recordingArchiveObjectHandler|recognizeRecordingArchiveObject/);
  assert.equal(fs.existsSync(path.join(root, "src/manager/recordingArchiveAdminRoutes.ts")), false);
  assert.doesNotMatch(source("src/manager/pluginCatalogRoutes.ts"), /\/api\/plugins\/reconcile(?:["/])/);
  assert.doesNotMatch(source("src/plugins/io.rabiroute.manager.agent-adapter-catalog/src/manager/agentAdapterCatalog.ts"), /\/api\/agent-adapters\/(?:dsh\/)?availability/);
  assert.equal(fs.existsSync(path.join(root, "src/manager/fenneNoteOutputService.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/manager/agentProviderControlRoutes.ts")), false);
  assert.doesNotMatch(source("src/plugins/io.rabiroute.agent.astrbot/src/agentAdapters/astrbotAdapter.ts"), /rabiroute_agent|\/api\/plug\//);
});
