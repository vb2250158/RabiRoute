import { getBuiltinManagerCordisRoot } from "../runtime/managerCordisRoot.js";
import {
  mountManagerPluginRuntime,
  type ManagerPluginRuntimeMount
} from "../runtime/managerPluginRuntime.js";
import { builtinManagerPluginDefinitions } from "./builtinManagerPlugins.js";

export const BUILTIN_MANAGER_PLUGIN_RUNTIME_KEY = "rabi.runtime.managerPlugins.builtin";

export function getBuiltinManagerPluginRuntime(): Promise<ManagerPluginRuntimeMount> {
  const root = getBuiltinManagerCordisRoot();
  return root.ensure(
    BUILTIN_MANAGER_PLUGIN_RUNTIME_KEY,
    host => mountManagerPluginRuntime(host, builtinManagerPluginDefinitions())
  );
}
