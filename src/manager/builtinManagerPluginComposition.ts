import type { RabiCordisContext } from "../runtime/cordisHost.js";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";

export type BuiltinManagerPluginApplyHook = (
  ctx: RabiCordisContext
) => void | Promise<void>;

export function composeBuiltinManagerPluginDefinitions(
  definitions: readonly ManagerPluginDefinition[],
  applyHooks: Readonly<Record<string, BuiltinManagerPluginApplyHook>>
): ManagerPluginDefinition[] {
  const knownInstanceIds = new Set(definitions.map(definition => definition.instanceId));

  for (const instanceId of Object.keys(applyHooks)) {
    if (!knownInstanceIds.has(instanceId)) {
      throw new Error(`Unknown built-in Manager plugin apply hook: ${instanceId}`);
    }
  }

  return definitions.map(definition => {
    const hook = applyHooks[definition.instanceId];
    if (!hook) return definition;

    const originalApply = definition.apply;
    return {
      ...definition,
      async apply(ctx) {
        await originalApply?.(ctx);
        await hook(ctx);
      }
    };
  });
}
