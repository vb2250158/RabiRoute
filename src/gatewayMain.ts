import { config, runtimeLayout } from "./config.js";
import { readGatewayRouteBootSnapshot } from "./shared/gatewayRouteSnapshotBoot.js";
import { mountGatewayRouteSnapshotRuntime } from "./runtime/gatewayRouteSnapshotReceiver.js";
import { gatewayReadyLine, type GatewayEndpoint } from "./gatewayLifecycle.js";
import { reportGatewayMessageHistory } from "./gatewayMessageHistory.js";
import type { GatewayMessageAdapterType } from "./adapters/messageAdapter.js";
import { startGatewayPerformanceReporter } from "./performance/gatewayPerformanceReporter.js";
import { mountGatewayPerformanceReporter } from "./runtime/gatewayPerformanceRuntime.js";
import {
  ensureAgentAdapterRuntime,
  type AgentAdapterRuntimeMount
} from "./runtime/agentAdapterRuntime.js";
import {
  mountContributionRuntime,
  type ContributionRuntimeMount
} from "./runtime/contributionRuntime.js";
import {
  getBuiltinGatewayCordisRoot,
  type GatewayCordisRoot
} from "./runtime/gatewayCordisRoot.js";
import path from "node:path";
import { mountGatewayEndpointPlugins, type GatewayEndpointPluginOptions, type GatewayEndpointPluginRuntime } from "./runtime/gatewayEndpointPlugins.js";
import { createManagerOperationalLog, installOperationalMutationAuditSink } from "./manager/operationalLog.js";

const GATEWAY_CONTRIBUTION_RUNTIME_KEY = "rabi.runtime.contributions.gateway";
const GATEWAY_MESSAGE_ADAPTER_RUNTIME_KEY = "rabi.runtime.messageAdapters.gateway";
const GATEWAY_PERFORMANCE_RUNTIME_KEY = "rabi.runtime.performance.gateway";

type GatewayLifecycleEvent = "SIGINT" | "SIGTERM" | "beforeExit";
type GatewayLifecycleListener = () => void;

export type GatewayProcessLifecycle = {
  once(event: GatewayLifecycleEvent, listener: GatewayLifecycleListener): unknown;
  removeListener(event: GatewayLifecycleEvent, listener: GatewayLifecycleListener): unknown;
};

export type GatewayMainOptions = {
  adapterTypes?: readonly GatewayMessageAdapterType[];
  processLifecycle?: GatewayProcessLifecycle;
  startPerformanceReporter?: () => () => void;
  endpointPlugins?: Partial<GatewayEndpointPluginOptions>;
};

export type GatewayMainRuntime = {
  root: GatewayCordisRoot;
  agentAdapters: AgentAdapterRuntimeMount;
  contributions: ContributionRuntimeMount;
  messageAdapters: GatewayEndpointPluginRuntime;
  routeSnapshotRevision?: string;
  routeSnapshotUnavailableInstances?: readonly string[];
  dispose(): Promise<void>;
};

const gatewayMainRuntimes = new WeakMap<GatewayCordisRoot, Promise<GatewayMainRuntime>>();

async function initializeGatewayMain(
  root: GatewayCordisRoot,
  options: GatewayMainOptions
): Promise<GatewayMainRuntime> {
  const adapterTypes = options.adapterTypes ?? config.gatewayMessageAdapterTypes;
  const lifecycle = options.processLifecycle ?? process;
  const startReporter = options.startPerformanceReporter ?? startGatewayPerformanceReporter;
  const bootFilename = process.env.RABIROUTE_ROUTE_SNAPSHOT_PATH?.trim() ?? "";
  const bootRevision = process.env.RABIROUTE_ROUTE_REVISION?.trim() ?? "";
  const gatewayId = process.env.GATEWAY_ID?.trim() ?? "";
  const gatewayGenerationId = process.env.RABIROUTE_GATEWAY_GENERATION_ID?.trim() ?? "";
  const initialRouteDefinition = bootFilename || bootRevision
    ? readGatewayRouteBootSnapshot(bootFilename, bootRevision, gatewayId) : undefined;
  let routeSnapshotRevision: string | undefined;
  let routeSnapshotUnavailableInstances: readonly string[] | undefined;
  let gatewayDisposePromise: Promise<void> | undefined;
  let routeSnapshotRuntime: Awaited<ReturnType<typeof mountGatewayRouteSnapshotRuntime>> | undefined;
  let stopMessageHistoryReporter: (() => void) | undefined;
  const listeners = new Map<GatewayLifecycleEvent, GatewayLifecycleListener>();

  function removeLifecycleListeners(): void {
    for (const [event, listener] of listeners) {
      lifecycle.removeListener(event, listener);
    }
    listeners.clear();
  }

  function disposeGatewayRuntime(): Promise<void> {
    if (!gatewayDisposePromise) {
      gatewayDisposePromise = (async () => {
        removeLifecycleListeners();
        stopMessageHistoryReporter?.();
        await routeSnapshotRuntime?.unmount();
        await root.dispose();
      })();
    }
    return gatewayDisposePromise;
  }

  try {
    if (gatewayId && gatewayGenerationId) stopMessageHistoryReporter = reportGatewayMessageHistory({
      identity: { gatewayId, gatewayGenerationId, pid: process.pid }, output: process.stdout
    });
    const agentAdapters = await ensureAgentAdapterRuntime(root);
    const contributions = await root.ensure(
      GATEWAY_CONTRIBUTION_RUNTIME_KEY,
      (host) => mountContributionRuntime(host, [])
    );
    const messageAdapters = await root.ensure(
      GATEWAY_MESSAGE_ADAPTER_RUNTIME_KEY,
      (host) => mountGatewayEndpointPlugins(host, {
        profilePath: process.env.RABIROUTE_PLUGIN_PROFILE?.trim() || path.join(runtimeLayout.packageRoot, "dist/plugins/profiles/desktop.json"),
        settingsRoot: path.join(runtimeLayout.stateRoot, "data/plugins/settings"),
        packageRoots: process.env.RABIROUTE_PLUGIN_PACKAGE_ROOTS?.split(path.delimiter).filter(Boolean) || [path.join(runtimeLayout.packageRoot, "dist/plugins/packages")],
        runtimeRoot: path.join(config.dataDir, ".rabi-runtime", "endpoint-plugins"),
        adapterTypes,
        agentRegistry: agentAdapters.registry,
        ...(initialRouteDefinition ? { initialRouteDefinition, initialRouteRevision: bootRevision } : {}),
        ...options.endpointPlugins
      })
    );

    if (initialRouteDefinition) {
      if (!gatewayGenerationId || messageAdapters.routeRevision() !== bootRevision) throw new Error("Gateway Route boot revision is not active.");
      const unavailableInstances = () => Object.freeze([...new Set([
        ...messageAdapters.diagnostics().map(item => item.instanceId),
        ...messageAdapters.current().records.filter(record => record.status !== "active" || record.error).map(record => record.identity.instanceId)
      ])]);
      routeSnapshotRuntime = await root.ensure("rabi.runtime.routeSnapshot.gateway", host => mountGatewayRouteSnapshotRuntime(host, {
        identity: { gatewayId, gatewayGenerationId, pid: process.pid },
        initialRevision: bootRevision,
        input: process.stdin,
        output: process.stdout,
        applySnapshot: (definition, revision) => messageAdapters.applyRouteSnapshot(definition, revision),
        unavailableInstances
      }));
      routeSnapshotRevision = bootRevision;
      routeSnapshotUnavailableInstances = unavailableInstances();
    }

    await root.ensure(
      GATEWAY_PERFORMANCE_RUNTIME_KEY,
      (host) => mountGatewayPerformanceReporter(host, startReporter)
    );
    for (const event of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
      const listener = () => void disposeGatewayRuntime();
      listeners.set(event, listener);
      lifecycle.once(event, listener);
    }

    return {
      root,
      agentAdapters,
      contributions,
      messageAdapters,
      routeSnapshotRevision,
      routeSnapshotUnavailableInstances,
      dispose: disposeGatewayRuntime
    };
  } catch (error) {
    stopMessageHistoryReporter?.();
    removeLifecycleListeners();
    await routeSnapshotRuntime?.unmount();
    await root.dispose();
    throw error;
  }
}

export function startGatewayMain(
  options: GatewayMainOptions = {}
): Promise<GatewayMainRuntime> {
  const root = getBuiltinGatewayCordisRoot();
  const existing = gatewayMainRuntimes.get(root);
  if (existing) return existing;

  const starting = initializeGatewayMain(root, options);
  gatewayMainRuntimes.set(root, starting);
  void starting.catch(() => {
    if (gatewayMainRuntimes.get(root) === starting) {
      gatewayMainRuntimes.delete(root);
    }
  });
  return starting;
}

export async function runGatewayMain(): Promise<void> {
  const operationalLog = createManagerOperationalLog({ rootDir: runtimeLayout.stateRoot });
  const uninstallMutationAuditSink = installOperationalMutationAuditSink(operationalLog, runtimeLayout.stateRoot);
  const flushOperationalLog = (): void => {
    uninstallMutationAuditSink();
    void operationalLog.flush().catch(error => {
      process.stderr.write(`[RabiRoute Gateway operations] failed to flush: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  process.once("SIGINT", flushOperationalLog);
  process.once("SIGTERM", flushOperationalLog);
  process.once("beforeExit", flushOperationalLog);
  let runtime: GatewayMainRuntime;
  try {
    runtime = await startGatewayMain();
  } catch (error) {
    process.removeListener("SIGINT", flushOperationalLog);
    process.removeListener("SIGTERM", flushOperationalLog);
    process.removeListener("beforeExit", flushOperationalLog);
    uninstallMutationAuditSink();
    await operationalLog.flush();
    throw error;
  }
  const gatewayId = String(process.env.GATEWAY_ID || "").trim();
  const gatewayGenerationId = String(process.env.RABIROUTE_GATEWAY_GENERATION_ID || "").trim();
  if (!gatewayId || !gatewayGenerationId) {
    throw new Error("Manager-owned Gateway identity is missing.");
  }
  const endpoints: GatewayEndpoint[] = [];
  if (config.gatewayMessageAdapterTypes.includes("napcat")) {
    for (const instance of config.napcatInstances.filter(item => item.enabled !== false)) {
      endpoints.push({
        id: `napcat:${instance.id}`,
        transport: "websocket",
        host: "127.0.0.1",
        port: instance.gatewayPort
      });
    }
  }
  const addHttp = (id: string, enabled: boolean, host: string, port: number, path: string): void => {
    if (enabled) endpoints.push({ id, transport: "http", host, port, path });
  };
  addHttp("webhook", config.gatewayMessageAdapterTypes.includes("webhook"), "127.0.0.1", config.webhookPort, config.webhookPath);
  addHttp("fennenote", config.gatewayMessageAdapterTypes.includes("fennenote"), "127.0.0.1", config.fenneNoteWebhookPort, config.fenneNoteWebhookPath);
  addHttp("rabilink", config.gatewayMessageAdapterTypes.includes("rabilink"), config.rabiLinkWebhookHost, config.rabiLinkWebhookPort, config.rabiLinkWebhookPath);
  addHttp("feishu", config.gatewayMessageAdapterTypes.includes("feishu"), "127.0.0.1", config.feishuWebhookPort, config.feishuWebhookPath);
  console.log(gatewayReadyLine({
    protocolVersion: 1,
    gatewayId,
    gatewayGenerationId,
    pid: process.pid,
    readyAt: new Date().toISOString(),
    ...(runtime.routeSnapshotRevision ? { routeSnapshotProtocol: 1 as const, routeRevision: runtime.routeSnapshotRevision, unavailableInstances: runtime.routeSnapshotUnavailableInstances } : {}),
    endpoints
  }));
}
