import { config } from "./config.js";
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
import {
  mountMessageAdapterRuntime,
  type MessageAdapterRuntimeMount
} from "./runtime/messageAdapterRuntime.js";

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
};

export type GatewayMainRuntime = {
  root: GatewayCordisRoot;
  agentAdapters: AgentAdapterRuntimeMount;
  contributions: ContributionRuntimeMount;
  messageAdapters: MessageAdapterRuntimeMount;
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
  let gatewayDisposePromise: Promise<void> | undefined;
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
        await root.dispose();
      })();
    }
    return gatewayDisposePromise;
  }

  try {
    const agentAdapters = await ensureAgentAdapterRuntime(root);
    const contributions = await root.ensure(
      GATEWAY_CONTRIBUTION_RUNTIME_KEY,
      (host) => mountContributionRuntime(host, [])
    );
    const messageAdapters = await root.ensure(
      GATEWAY_MESSAGE_ADAPTER_RUNTIME_KEY,
      (host) => mountMessageAdapterRuntime(host)
    );

    for (const type of adapterTypes) {
      await messageAdapters.mount(type);
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
      dispose: disposeGatewayRuntime
    };
  } catch (error) {
    removeLifecycleListeners();
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
  await startGatewayMain();
}
