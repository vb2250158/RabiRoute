import type { ApiHttpProxyDefinition, ApiOperationDefinition } from "./apiOperationContract.js";
import type { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

const bootstrapPublicIds = new Set(["manager.meta.read", "manager.core-public.health.read"]);

/** Keep discovery with the application while identity changes and updates remain plugin-owned. */
export function splitManagerBootstrapPublicOperations(definitions: readonly ApiOperationDefinition[]) {
  return {
    bootstrap: definitions.filter(definition => bootstrapPublicIds.has(definition.contract.operationId)),
    business: definitions.filter(definition => !bootstrapPublicIds.has(definition.contract.operationId))
  };
}

export type ManagerBootstrapOwners = Readonly<{
  applicationOwner: Readonly<{ instanceId: string; run<T>(operation: () => T): T }>;
  registry: Pick<ManagerPluginRouteRegistry, "registerOperationsAsync" | "registerHttpProxies">;
  publicOperations(): readonly ApiOperationDefinition[];
  catalogOperations(): readonly ApiOperationDefinition[];
  accessOperations(): readonly ApiOperationDefinition[];
  eventOperation(): ApiOperationDefinition;
  staticOperations(): { resources: readonly ApiHttpProxyDefinition[]; fallback: ApiHttpProxyDefinition };
}>;

/** Register the original bootstrap owners once for the application lifetime. */
export async function registerManagerBootstrap(owners: ManagerBootstrapOwners, signal: AbortSignal) {
  return owners.applicationOwner.run(async () => {
  const operations = await owners.registry.registerOperationsAsync(owners.applicationOwner.instanceId, [
    ...splitManagerBootstrapPublicOperations(owners.publicOperations()).bootstrap,
    ...owners.catalogOperations(), ...owners.accessOperations(), owners.eventOperation()
  ], signal);
  let resources: ReturnType<ManagerBootstrapOwners["registry"]["registerHttpProxies"]> | undefined;
  try {
    const definitions = owners.staticOperations();
    resources = owners.registry.registerHttpProxies(owners.applicationOwner.instanceId, [...definitions.resources, definitions.fallback]);
  } catch (error) { await operations.dispose(); throw error; }
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    dispose: () => disposal ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => operations.dispose()),
        Promise.resolve().then(() => resources!.dispose())
      ]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Manager bootstrap shutdown failed.");
    })()
  });
  });
}
