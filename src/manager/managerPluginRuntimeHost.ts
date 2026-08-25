import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginRuntimeMount
} from "../runtime/managerPluginRuntime.js";
import { ManagerPluginReconciler } from "../runtime/managerPluginReconciler.js";

export const MANAGER_PLUGIN_RUNTIME_KEY = "rabi.runtime.managerPlugins";

export type ManagerPluginRuntimeHost = {
  runtime: ManagerPluginRuntimeMount;
  reconciler: ManagerPluginReconciler;
};

export function getManagerPluginRuntimeHost(): Promise<ManagerPluginRuntimeHost> {
  const root = getBuiltinManagerCordisRoot();
  return root.ensure(
    MANAGER_PLUGIN_RUNTIME_KEY,
    async host => {
      const runtime = await mountManagerPluginRuntime(host);
      return { runtime, reconciler: new ManagerPluginReconciler(runtime) };
    }
  );
}
