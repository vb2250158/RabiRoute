import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginRuntimeMount
} from "../runtime/managerPluginRuntime.js";
import { ManagerPluginReconciler } from "../runtime/managerPluginReconciler.js";

export const BUILTIN_MANAGER_PLUGIN_RUNTIME_KEY = "rabi.runtime.managerPlugins.builtin";

export type BuiltinManagerPluginHost = {
  runtime: ManagerPluginRuntimeMount;
  reconciler: ManagerPluginReconciler;
};

export function getBuiltinManagerPluginHost(): Promise<BuiltinManagerPluginHost> {
  const root = getBuiltinManagerCordisRoot();
  return root.ensure(
    BUILTIN_MANAGER_PLUGIN_RUNTIME_KEY,
    async host => {
      const runtime = await mountManagerPluginRuntime(host);
      return { runtime, reconciler: new ManagerPluginReconciler(runtime) };
    }
  );
}
