import type { CoalescingMessageProcessingBoardPersistence } from "../messageProcessing/persistence.js";
import type { RabiCordisFiber } from "../runtime/cordisHost.js";
import {
  startBuiltinManagerReadWorkerPools,
  stopBuiltinManagerReadWorkerPools
} from "./managerReadWorkerPool.js";
import type { ManagerCordisInitializer } from "../runtime/managerCordisRoot.js";

export const MANAGER_SHARED_RESOURCES_RUNTIME_KEY = "rabi.runtime.managerSharedResources";

export type ManagerSharedResourcesRuntimeMount = {
  fiber: RabiCordisFiber;
  unmount(): Promise<void>;
};

export async function stopManagerSharedResources(
  persistence: Pick<CoalescingMessageProcessingBoardPersistence, "stop">,
  stopWorkerPools: () => Promise<void> = stopBuiltinManagerReadWorkerPools
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await persistence.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await stopWorkerPools();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Manager shared resource shutdown was not fully confirmed.");
  }
}

export function mountManagerSharedResourcesRuntime(
  persistence: CoalescingMessageProcessingBoardPersistence
): ManagerCordisInitializer<ManagerSharedResourcesRuntimeMount> {
  return async host => {
    const fiber = await host.mount({
      name: "rabi:manager-shared-resources",
      apply(ctx) {
        ctx.effect(() => {
          persistence.start();
          startBuiltinManagerReadWorkerPools();
          return () => stopManagerSharedResources(persistence);
        }, "own Manager shared workers and persistence");
      }
    });
    return { fiber, unmount: () => fiber.dispose() };
  };
}
