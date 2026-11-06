import path from "node:path";
import type { AgentAdapterInvocation } from "@rabiroute/plugin-sdk";
import { mountAgentPluginRuntime } from "../runtime/agentPluginRuntime.js";
import { createAgentAdapterHostPorts } from "../runtime/agentAdapterHostPorts.js";
import { resolvePublishedAgentManagerProviders, invokeAgentManagerOperation } from "../manager/agentManagerProviders.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { AgentAdapterCatalogWorkerPool } from "../manager/agentAdapterCatalogWorkerPool.js";
import type { AgentManagerHostPorts } from "../manager/agentManagerHostPorts.js";
import type { InstanceManagementContext } from "./instanceManagement.js";
import { prepareApplicationPluginStorage, type PluginStorageLegacySource } from "../shared/pluginStorage.js";

type RemoteConfiguration = {
  nodeId?: string;
  defaultWorkspace?: string;
  allowedWorkspaces?: string[];
};

/** The authenticated node process mounts only the same native Agent subgraph. */
export async function mountRemoteAgentManager(options: {
  applicationRoot: string;
  stateRoot: string;
  /** Exact original owner root from an accepted previous-runtime handoff, never a cache scan. */
  legacyStateRoot?: string;
  legacySources?: readonly PluginStorageLegacySource[];
  getConfiguration(): RemoteConfiguration;
  signal?: AbortSignal;
  publishManagerEvent?(type: string, data: unknown): void;
}): Promise<{
  context(): Pick<InstanceManagementContext, "getProviders" | "invokeAgentOperation">;
  diagnostics(): readonly Readonly<{ instanceId?: string; message: string; rowIndex?: number }>[];
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
    runScan: (task, invocation) => pool.query({ ...task, cwdOptions: options.getConfiguration().allowedWorkspaces }, { signal: invocation?.signal }) as Promise<Record<string, unknown>>,
    registerOperations: (instanceId, definitions, signal) => routes.registerOperationsAsync(instanceId, definitions, signal)
  };
  const hostPorts = createAgentAdapterHostPorts({ manager, layout: {
    packageRoot: path.join(runtimeDirectory, "backend"), stateRoot: options.stateRoot
  } });
  const profilePath = path.join(runtimeDirectory, "agent-profile.json"), settingsRoot = path.join(options.stateRoot, "agent-plugin-settings");
  const packageRoots = [path.join(runtimeDirectory, "plugins", "packages")];
  const migrationsPath = path.join(runtimeDirectory, "plugins", "profiles", "package-migrations.json");
  let runtime: Awaited<ReturnType<typeof mountAgentPluginRuntime>>;
  try {
    // The node lifecycle retires the preceding runtime before mounting this owner.
    // Migrate only this published Agent subgraph and preserve explicit launcher paths.
    const storageResults = await prepareApplicationPluginStorage({ phase: "owners-retired", layout: {
      packageRoot: path.join(runtimeDirectory, "backend"), stateRoot: options.stateRoot
    }, profilePath, settingsRoot, packageRoots, migrationsPath, legacyStateRoot: options.legacyStateRoot, legacySources: options.legacySources,
      environment: { ...process.env, ...hostPorts.environment } });
    for (const failure of storageResults.filter(result => result.status === "failed")) {
      console.error("Remote Agent plugin storage migration failed", failure);
    }
    runtime = await mountAgentPluginRuntime({
      host: "manager",
      profilePath, settingsRoot, packageRoots, migrationsPath,
      stateRoot: options.stateRoot,
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
    diagnostics: () => runtime.diagnostics(),
    dispose
  };
}
