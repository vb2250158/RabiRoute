import { createHash } from "node:crypto";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import type { ApiExternalListenerDefinition, ApiExternalListenerPublication, ApiExternalListenerRegistration } from "../manager/apiExternalListenerBinding.js";
import type { ApiOperationRegistration, ApiUpgradeRegistration } from "../manager/apiOperationContract.js";

export const GATEWAY_LISTENER_PUBLICATION_PREFIX = "RABIROUTE_GATEWAY_LISTENERS ";
export type GatewayListenerIdentity = Readonly<{ gatewayId: string; gatewayGenerationId: string; pid: number }>;
export type GatewayListenerPublication = GatewayListenerIdentity & Readonly<{
  schemaVersion: 1; revision: number; listeners: readonly ApiExternalListenerPublication[];
}>;

/** One native Gateway owns its registry and emits metadata over its existing supervisor stdout pipe. */
export function createGatewayListenerRuntime(options: {
  identity: GatewayListenerIdentity;
  publish(publication: GatewayListenerPublication): void;
}) {
  const identity = Object.freeze({ ...options.identity });
  if (!identity.gatewayId || !identity.gatewayGenerationId || !Number.isSafeInteger(identity.pid) || identity.pid < 1) throw new Error("Gateway listener publication requires the original process identity.");
  const registry = new ManagerPluginRouteRegistry(), listeners = new Set<ApiExternalListenerRegistration>();
  const prefix = "gateway." + createHash("sha256").update(identity.gatewayId).digest("hex").slice(0, 16);
  let revision = 0, closed = false, disposal: Promise<void> | undefined;
  const publish = () => options.publish({ ...identity, schemaVersion: 1, revision: ++revision,
    listeners: [...listeners].map(listener => listener.publication()).filter(listener => listener.active) });
  function registerExternalListener(instanceId: string, definition: ApiExternalListenerDefinition): ApiExternalListenerRegistration {
    if (closed) throw new Error("Gateway listener runtime is closed.");
    const original = registry.registerExternalListener(instanceId, definition);
    const track = <T extends ApiOperationRegistration>(registration: T): T => Object.freeze({ ...registration,
      ...("stopAccepting" in registration ? { stopAccepting() { (registration as ApiUpgradeRegistration).stopAccepting(); publish(); } } : {}),
      async dispose() { const stopped = registration.dispose(); publish(); try { await stopped; } finally { publish(); } }
    });
    let disposal: Promise<void> | undefined;
    const wrapped: ApiExternalListenerRegistration = Object.freeze({ ...original,
      registerOperations(definitions) { const registered = original.registerOperations(definitions); publish(); return track(registered); },
      registerHttpProxies(definitions) { const registered = original.registerHttpProxies(definitions); publish(); return track(registered); },
      registerUpgrades(definitions) { const registered = original.registerUpgrades(definitions); publish(); return track(registered); },
      stopAccepting() { original.stopAccepting(); publish(); },
      dispose() {
        return disposal ??= (async () => {
          const failures: unknown[] = [];
          try { original.stopAccepting(); } catch (error) { failures.push(error); }
          listeners.delete(wrapped);
          try { publish(); } catch (error) { failures.push(error); }
          try { await original.dispose(); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, "Gateway listener retirement failed.");
        })();
      }
    });
    listeners.add(wrapped); publish(); return wrapped;
  }
  return Object.freeze({ registerExternalListener,
    /** A stable public namespace, derived without publishing a private Gateway ID in operation names. */
    operationId(localName: string) { return `${prefix}.${localName}`; },
    dispose(): Promise<void> {
      return disposal ??= (async () => {
        closed = true;
        const outcomes = await Promise.allSettled([...listeners].map(listener => listener.dispose()));
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), "Gateway native listener cleanup failed.");
      })();
    }
  });
}

let gatewayRuntime: ReturnType<typeof createGatewayListenerRuntime> | undefined;
/** Called by actual native adapter owners; never starts a listener or a Manager. */
export function getGatewayListenerRuntime() {
  return gatewayRuntime ??= createGatewayListenerRuntime({
    identity: { gatewayId: process.env.GATEWAY_ID?.trim() ?? "", gatewayGenerationId: process.env.RABIROUTE_GATEWAY_GENERATION_ID?.trim() ?? "", pid: process.pid },
    publish: publication => process.stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX + JSON.stringify(publication) + "\n")
  });
}
