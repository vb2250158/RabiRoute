import type { HostService } from "../plugin-kernel/types.js";
import type { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import type { ApiOperationDefinition } from "../manager/apiOperationContract.js";
import { createScopedAsyncRegistrationService } from "./scopedRegistrationHost.js";

type ParentRouteControl = Readonly<{
  managerPluginRoutes: Pick<ManagerPluginRouteRegistry, "registerOperationsAsync">;
  createRabiControlOperations(): readonly ApiOperationDefinition[];
}>;

/** Adds an explicit async capability; the existing native service stays unchanged. */
export function withRouteControlAsyncRegistration(services: readonly HostService[]): readonly HostService[] {
  const original = services.find(service => service.capability === "host.manager.route-control@1")!.value as ParentRouteControl;
  return Object.freeze([...services, Object.freeze({
    capability: "host.manager.route-control-registration@1",
    value: createScopedAsyncRegistrationService({
      label: "activate Manager Route control plugin",
      register: context => original.managerPluginRoutes.registerOperationsAsync(context.identity.instanceId,
        original.createRabiControlOperations(), context.lifecycle.signal)
    })
  })]);
}
