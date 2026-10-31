import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { configureTimeouts, getTimeoutMs, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { DEFAULT_MANAGER_RUNTIME_TEARDOWN_TIMEOUT_MS } from "./managerRuntimeOwner.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mountAgentAdapterCatalogPlugin } from "./agentAdapterCatalog.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { createNapcatControlOperations } from "./napcatControlRoutes.js";

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
  const legacy = source("src/manager/lanAgentRoutes.ts");
  assert.doesNotMatch(legacy, /function writeAsset\s*\(|releaseAssetMatch/);
  assert.doesNotMatch(legacy, /requestUrl\.pathname\s*===\s*"\/api\/lan-agent\/releases\/manifest"/);
  assert.doesNotMatch(legacy, /\["\/api\/lan-agent\/resources",\s*"\/api\/lan-agent\/resources\/read"\]/);
  assert.match(source("plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs"), /createLanAgentReadOperations\(lanAgentContext\)/);
});

test("LAN upgrades are core-owned executable bindings without a second central listener", () => {
  const central = source("src/manager/controlPlaneRoutes.ts"), core = source("plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs");
  assert.doesNotMatch(central, /lanAgentRegistry\.attach\(activeServer/);
  assert.match(central, /managerPluginRoutes\.handleUpgrade\(request, url, socket, head\)/);
  assert.match(core, /registerUpgrades\(context\.identity\.instanceId/);
  assert.match(core, /upgrades\.stopAccepting\(\)/);
  // Actual drain order and cleanup failures are verified by corePluginCleanup.test.ts.
  assert.match(core, /registration\.dispose\(\)/);
  assert.match(core, /upgrades\.dispose\(\)/);
});

test("terminal and computer operations have no old boolean HTTP adapters", () => {
  for (const file of ["src/manager/lanAgentRoutes.ts", "src/manager/lanAgentTerminalRoutes.ts", "src/manager/lanAgentComputerRoutes.ts"]) {
    assert.doesNotMatch(source(file), /\bhandleLanAgent(?:Terminal|Computer)Api\b/);
  }
  const core = source("plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs");
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
  assertSourceRetainsRoutes("src/manager/messageProcessingOperations.ts", [
    "/api/message-processing/board",
    "/api/message-processing/requirements"
  ]);
  assertSourceRetainsRoutes("src/manager/gatewayControlOperations.ts", [
    "/gateways",
    "/network-options",
    "/reload",
    "manual-trigger",
    "agent-delivery-test",
    "delivery-replay",
    "weixin-login"
  ]);
  assertSourceRetainsRoutes("src/manager/messageAdapterControl.ts", [
    "/api/scan/message-adapters"
  ]);
  assertSourceRetainsRoutes("src/manager/agentAdapterCatalogContract.ts", [
    "/api/scan/agents",
    "/api/scan/agents/dsh",
    "/api/scan/agents/grokBot",
    "/api/agent-adapters/catalog"
  ]);
  assertSourceRetainsRoutes("src/manager/agentThreadControlOperations.ts", [
    "/api/agent/threads"
  ]);
  assertSourceRetainsRoutes("src/manager/agentCommunicationRoutes.ts", [
    "/api/agent/requests",
    "/api/agent/send",
    "/api/agent/send/traces",
    "receipts"
  ]);
  assertSourceRetainsRoutes("src/manager/agentProviderControlRoutes.ts", [
    "/api/agent/copilot-install",
    "/api/agent/copilot-login",
    "/api/agent/copilot-status",
    "/api/agent/astrbot-login-test"
  ]);
  assertSourceRetainsRoutes("src/manager/marvisControlOperations.ts", ["/api/agent/marvis-open"]);
  assertSourceRetainsRoutes("src/manager/remoteAgentContract.ts", [
    "/api/remote-agent/devices",
    "/api/remote-agent/scan",
    "/api/remote-agent/connect",
    "/api/remote-agent/disconnect",
    "/api/remote-agent/tasks",
    "/api/remote-agent/task-events"
  ]);
  assertSourceRetainsRoutes("src/manager/corePublicOperations.ts", ["/meta"]);
  assertSourceRetainsRoutes("plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/operations.mjs", ["/api/gateways"]);
  assertSourceRetainsRoutes("src/manager/desktopControlRoutes.ts", [
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

test("catalog plugin activation owns every dedicated scan route", async () => {
  const { EffectScope, PublicationScope } = await import(pathToFileURL(path.join(root, "plugins/contracts/plugin-sdk/index.mjs")).href);
  const { activate } = await import(pathToFileURL(path.join(root, "plugins/builtin/io.rabiroute.manager.agent-adapter-catalog/1.0.0/manager.mjs")).href);
  const effects = new EffectScope();
  const publication = new PublicationScope(effects);
  let claims: readonly ApiOperationDefinition[] = [];
  let stopped = false;
  let retired = false;
  const runtime = {
    rootDir: root, runtimes: new Map(), managerPluginRoutes: {
      async registerOperationsAsync(_instance: string, definitions: readonly ApiOperationDefinition[]) {
        claims = definitions;
        return { async dispose() { retired = true; }, activeOperationCount: () => 0 };
      }
    },
    async mountAgentAdapterCatalogPlugin(options: Parameters<typeof mountAgentAdapterCatalogPlugin>[0]) {
      const mount = await mountAgentAdapterCatalogPlugin({ ...options, listManifests: async () => [] });
      return { ...mount, async stop(reason?: string) { await mount.stop(reason); stopped = true; } };
    },
    agentAdapterCatalogService: undefined as unknown
  };
  await activate({ identity: { instanceId: "manager:agent-adapter-catalog" }, effects, publication, lifecycle: { signal: effects.signal() },
    services: { require() { return runtime; }, provide() {} }, contributions: { register() {} } });
  await effects.commit();
  publication.publish();
  publication.seal()();
  await publication.afterPublish(Promise.resolve());
  for (const url of ["/api/scan/agents", "/api/scan/agents/dsh", "/api/scan/agents/grokBot"]) {
    const exact = claims.filter(claim => claim.contract.pathTemplate === url);
    assert.equal(exact.length, 1, `${url} must have one plugin owner`);
    assert.equal(exact[0].contract.method, "GET");
  }
  await effects.dispose();
  assert.equal(stopped, true);
  assert.equal(retired, true);
});

test("Agent state reporting is registered by the Agent state plugin package", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.agent-state-control/1.0.0/manager.mjs");
  assert.match(plugin, /await runtime\.managerPluginRoutes\.registerOperationsAsync\(context\.identity\.instanceId, runtime\.createAgentStateReportOperations\(\), context\.lifecycle\.signal\)/);
  assertSourceRetainsRoutes("src/manager/agentStateReportOperations.ts", ["/api/agent-state"]);
  assert.doesNotMatch(source("src/manager/controlPlaneRoutes.ts"), /function handleAgentStateReport\s*\(/);
});

test("Outbox no longer calls the retired FenneNote output implementation", () => {
  const outbox = source("src/outbox.ts");
  assert.doesNotMatch(outbox, /fenneNoteOutput/);
  assert.doesNotMatch(outbox, /async function postFenneNoteOutput\s*\(/);
});


test("NapCat plugin shutdown uses only launch-owned child processes and recorded PIDs", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.napcat-control/1.0.0/manager.mjs");
  assert.match(plugin, /const activeOperations = new Set/);
  assert.match(plugin, /napcatManagerCtx\(assertAccepting\)/);
  assert.match(plugin, /const retired = registration\?\.dispose\(\);[\s\S]*accepting = false;[\s\S]*while \(activeOperations\.size > 0\) await Promise\.allSettled\(\[\.\.\.activeOperations\]\); await retired;/);
  assert.match(plugin, /runtime\.removeManagedNapcatInstance\(body\)/);
  // Persisted NapcatLifecycleOwner owns process identity across Manager handovers.
  assert.doesNotMatch(plugin, /rememberLaunchPids|ownedInstances|releaseOwnership|runWindowsTaskkill|process\.kill|stopNapcatInstanceEndpoint\(controlContext/);
});

test("Remote Agent rejects WebSocket work before HTTP request drain", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.remote-agent/1.0.0/manager.mjs");
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
  assert.match(pluginRegistration, /budget => managerPluginKernel\?\.shutdown\(\{\s*timeoutMs: Math\.max\(1, Math\.floor\(budget\.deadlineAt - performance\.now\(\)\)\)\s*\}\)/);
  assert.doesNotMatch(pluginRegistration, /managerPluginKernel\?\.dispose\(/);
  assert.doesNotMatch(central, /managerSharedResourcesRuntime\.unmount\(\)|disposeManagerCordisRuntime/);
});

test("removed compatibility APIs stay absent from their former owners", () => {
  assert.doesNotMatch(source("src/manager/controlPlaneRoutes.ts"), /handleResourceCacheApi|handleLegacyResourceCacheApi|handleRecordingArchiveAdminApi/);
  assert.doesNotMatch(source("plugins/builtin/io.rabiroute.manager.core/1.0.0/manager.mjs"), /routeId: ["']resource-cache["']|runtime\.handleResourceCacheApi/);
  assert.doesNotMatch(source("src/manager/resourceCache.ts"), /export function resourceCacheHandler/);
  assert.doesNotMatch(source("src/manager/recordingArchiveRoutes.ts"), /recordingArchiveHandler|recordingArchiveObjectHandler|recognizeRecordingArchiveObject/);
  assert.equal(fs.existsSync(path.join(root, "src/manager/recordingArchiveAdminRoutes.ts")), false);
  assert.doesNotMatch(source("src/manager/pluginCatalogRoutes.ts"), /\/api\/plugins\/reconcile(?:["/])/);
  assert.doesNotMatch(source("src/manager/agentAdapterCatalog.ts"), /\/api\/agent-adapters\/(?:dsh\/)?availability/);
  assert.equal(fs.existsSync(path.join(root, "src/manager/fenneNoteOutputService.ts")), false);
  assert.doesNotMatch(source("src/manager/agentProviderControlRoutes.ts"), /\/api\/deploy-astrbot-adapter/);
  assert.doesNotMatch(source("src/agentAdapters/astrbotAdapter.ts"), /rabiroute_agent|\/api\/plug\//);
});
