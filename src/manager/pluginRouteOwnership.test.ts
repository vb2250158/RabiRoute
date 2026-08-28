import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("plugin-owned Manager APIs have no legacy central dispatch branches", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const serverStart = central.indexOf("const activeServer = http.createServer");
  assert.ok(serverStart >= 0);
  const centralDispatch = central.slice(serverStart);

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
  assertSourceRetainsRoutes("src/manager/fenneNoteOutputService.ts", [
    "/api/fennenote/playback",
    "/api/fennenote/reply"
  ]);
  assertSourceRetainsRoutes("src/manager/messageProcessingRoutes.ts", [
    "/api/message-processing/board",
    "/api/message-processing/requirements"
  ]);
  assertSourceRetainsRoutes("src/manager/gatewayControlRoutes.ts", [
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
  assertSourceRetainsRoutes("src/manager/agentAdapterCatalog.ts", [
    "/api/scan/agents",
    "/api/scan/agents/dsh",
    "/api/agent-adapters/catalog"
  ]);
  assertSourceRetainsRoutes("src/manager/agentThreadControlRoutes.ts", [
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
    "/api/agent/astrbot-login-test",
    "/api/agent/marvis-open"
  ]);
  assertSourceRetainsRoutes("src/manager/remoteAgentRoutes.ts", [
    "/api/remote-agent/devices",
    "/api/remote-agent/scan",
    "/api/remote-agent/connect",
    "/api/remote-agent/disconnect",
    "/api/remote-agent/tasks",
    "/api/remote-agent/task-events"
  ]);
  assertSourceRetainsRoutes("src/manager/diagnosticsRoutes.ts", [
    "/meta",
    "/api/gateways"
  ]);
  assertSourceRetainsRoutes("src/manager/desktopControlRoutes.ts", [
    "/open-config-file",
    "/manager/start"
  ]);
  assertSourceRetainsRoutes("src/manager/desktopLifecycleRoutes.ts", [
    "/manager/desktop-lifecycle/start",
    "/manager/shutdown"
  ]);
  assertSourceRetainsRoutes("src/manager/napcatControlRoutes.ts", [
    "/api/message/napcat-repair-all",
    "/api/message/napcat-ensure-ready",
    "/api/message/napcat-health",
    "/api/message/napcat-configure-onebot",
    "/api/message/napcat-add",
    "/api/message/napcat-launch",
    "/api/message/napcat-restart",
    "/api/message/napcat-remove"
  ]);
});

test("Agent state reporting is registered by the Agent state plugin package", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.agent-state-control/1.0.0/manager.mjs");
  assert.match(plugin, /registerManagerPluginHandlerRoutes\(runtime\.managerPluginRoutes, "manager:agent-state-control"/);
  assert.match(plugin, /handleAgentStateReport\(request, requestUrl\.pathname, response\)/);
  assert.match(source("src/manager/controlPlaneRoutes.ts"), /function handleAgentStateReport[\s\S]*pathname !== "\/api\/agent-state"/);
});

test("Outbox imports the shared FenneNote output implementation", () => {
  const outbox = source("src/outbox.ts");
  assert.match(outbox, /from "\.\/fenneNoteOutput\.js"/);
  assert.doesNotMatch(outbox, /async function postFenneNoteOutput\s*\(/);
});


test("NapCat plugin shutdown uses only launch-owned child processes and recorded PIDs", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.napcat-control/1.0.0/manager.mjs");
  assert.match(plugin, /rememberLaunchPids/);
  assert.match(plugin, /const activeOperations = new Set/);
  assert.match(plugin, /napcatManagerCtx\(rememberLaunch, rememberLaunchPids, assertAccepting\)/);
  assert.match(plugin, /accepting = false;[\s\S]*requestTracker\.stop\(\)[\s\S]*drainOperations\(\)/);
  assert.match(plugin, /if \(result\.ok === true\)\s+releaseOwnership\(body\)/);
  assert.match(plugin, /runWindowsTaskkill\(numericPid\)/);
  assert.doesNotMatch(plugin, /stopNapcatInstanceEndpoint\(controlContext/);
});

test("Remote Agent rejects WebSocket work before HTTP request drain", () => {
  const plugin = source("plugins/builtin/io.rabiroute.manager.remote-agent/1.0.0/manager.mjs");
  assert.match(plugin, /unregisterRoutes\(\);[\s\S]*hub\.stopAccepting\(\);[\s\S]*await requestTracker\.stop\(\);[\s\S]*await hub\.shutdown\(\)/);
});

test("Manager forced shutdown allows the full plugin drain budget", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  assert.match(central, /setTimeout\(\(\) => process\.exit\(0\), 15 \* 60_000\)/);
});

test("Manager stops plugin Fibers before shared workers and the root Context", () => {
  const central = source("src/manager/controlPlaneRoutes.ts");
  const helperStart = central.indexOf("const disposeManagerCordisRuntime");
  const helperEnd = central.indexOf("let managerPluginDiagnostics", helperStart);
  const helper = central.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const pluginStop = helper.indexOf("await managerPluginKernel?.dispose()");
  const sharedStop = helper.indexOf("await managerSharedResourcesRuntime.unmount()");
  const rootStop = helper.indexOf("await managerCordisRoot.dispose()");
  assert.ok(pluginStop >= 0 && sharedStop > pluginStop && rootStop > sharedStop);
  assert.match(central, /const managerCordisDispose = disposeManagerCordisRuntime\(\)/);
});

test("removed compatibility APIs stay absent from their former owners", () => {
  assert.doesNotMatch(source("src/manager/pluginCatalogRoutes.ts"), /\/api\/plugins\/reconcile(?:["/])/);
  assert.doesNotMatch(source("src/manager/agentAdapterCatalog.ts"), /\/api\/agent-adapters\/(?:dsh\/)?availability/);
  assert.doesNotMatch(source("src/manager/fenneNoteOutputService.ts"), /\/api\/playback\/request/);
  assert.doesNotMatch(source("src/manager/agentProviderControlRoutes.ts"), /\/api\/deploy-astrbot-adapter/);
  assert.doesNotMatch(source("src/agentAdapters/astrbotAdapter.ts"), /rabiroute_agent|\/api\/plug\//);
});
