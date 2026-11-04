import path from "node:path";
import type { AgentAdapterInvocation } from "@rabiroute/plugin-sdk";
import { mountAgentPluginRuntime } from "../runtime/agentPluginRuntime.js";
import { createAgentAdapterHostPorts } from "../runtime/agentAdapterHostPorts.js";
import { resolvePublishedAgentManagerProviders, invokeAgentManagerOperation } from "../manager/agentManagerProviders.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { AgentAdapterCatalogWorkerPool } from "../manager/agentAdapterCatalogWorkerPool.js";
import type { AgentManagerHostPorts } from "../manager/agentManagerHostPorts.js";
import type { InstanceManagementContext } from "./instanceManagement.js";

type RemoteConfiguration = {
  nodeId?: string;
  defaultWorkspace?: string;
  allowedWorkspaces?: string[];
};

/** The authenticated node process mounts only the same native Agent subgraph. */
export async function mountRemoteAgentManager(options: {
  applicationRoot: string;
  stateRoot: string;
  getConfiguration(): RemoteConfiguration;
  signal?: AbortSignal;
  publishManagerEvent?(type: string, data: unknown): void;
}): Promise<{
  context(): Pick<InstanceManagementContext, "getProviders" | "invokeAgentOperation">;
  dispose(): Promise<void>;
}> {
  const runtimeDirectory = path.join(options.applicationRoot, "runtime");
  const routes = new ManagerPluginRouteRegistry();
  const pool = new AgentAdapterCatalogWorkerPool();
  const manager: AgentManagerHostPorts = {
    rootDir: options.applicationRoot,
    packageRoot: options.applicationRoot,
    readOnly: () => false,
    managerInstanceId: () => options.getConfiguration().nodeId ?? "remote-node",
    getRuntimes: () => [],
    publishManagerEvent: (type, data) => options.publishManagerEvent?.(type, data),
    deliveryReceiptChanged() {},
    runScan: (task, invocation) => pool.query({ ...task, cwdOptions: options.getConfiguration().allowedWorkspaces }, { signal: invocation?.signal }) as Promise<Record<string, unknown>>,
    registerOperations: (instanceId, definitions, signal) => routes.registerOperationsAsync(instanceId, definitions, signal)
  };
  const hostPorts = createAgentAdapterHostPorts({ manager, layout: {
    packageRoot: path.join(runtimeDirectory, "backend"), stateRoot: options.stateRoot
  } });
  let runtime: Awaited<ReturnType<typeof mountAgentPluginRuntime>>;
  try {
    runtime = await mountAgentPluginRuntime({
      host: "manager",
      profilePath: path.join(runtimeDirectory, "agent-profile.json"),
      settingsRoot: path.join(options.stateRoot, "agent-plugin-settings"),
      packageRoots: [path.join(runtimeDirectory, "plugins", "packages")],
      runtimeRoot: path.join(options.stateRoot, "agent-plugin-runtime"),
      hostPorts,
      signal: options.signal
    });
  } catch (error) {
    await pool.stop("Remote Agent plugin startup failed.");
    throw error;
  }
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    const outcomes = await Promise.allSettled([runtime.dispose(), pool.stop("Remote Agent process stopped.")]);
    const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Remote Agent native owners did not finish cleanup.");
  })();
  return {
    context: () => ({
      getProviders: () => resolvePublishedAgentManagerProviders(runtime.current()),
      invokeAgentOperation: <T = unknown>(type: string, operation: string, payload: unknown, invocation?: AgentAdapterInvocation) =>
        invokeAgentManagerOperation<T>(runtime.current(), type, operation, payload, invocation)
    }),
    dispose
  };
}
