export function createPlugin(context) {
  if (typeof context.services.createBuiltinManagerPluginDefinition !== "function") {
    throw new Error("The RabiRoute base bundle requires the Manager base-package host capability.");
  }
  return context.services.createBuiltinManagerPluginDefinition(context);
}
