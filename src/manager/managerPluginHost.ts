import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginRuntimeMount
} from "../runtime/managerPluginRuntime.js";
import { ManagerPluginReconciler } from "../runtime/managerPluginReconciler.js";
import { normalizeManagerPluginConfig } from "./managerPluginConfig.js";

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

export async function getBuiltinManagerPluginRuntime(): Promise<ManagerPluginRuntimeMount> {
  const pluginHost = await getBuiltinManagerPluginHost();
  if (pluginHost.reconciler.status().revision === 0) {
    await pluginHost.reconciler.reconcile(normalizeManagerPluginConfig({}).desired);
  }
  return pluginHost.runtime;
}
