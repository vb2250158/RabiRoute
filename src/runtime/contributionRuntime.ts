import type { RabiUiContribution } from "./contributionRegistry.js";
import { ContributionRegistry } from "./contributionRegistry.js";
import type { RabiCordisPlugin } from "./cordisHost.js";

export const CONTRIBUTION_REGISTRY_SERVICE = "rabi.contributions";

export const contributionRegistryServicePlugin: RabiCordisPlugin = {
  name: "rabi:contribution-registry",
  apply(ctx) {
    ctx.provide(CONTRIBUTION_REGISTRY_SERVICE, new ContributionRegistry());
  }
};

export function contributionPlugin(
  pluginId: string,
  contributions: readonly RabiUiContribution[]
): RabiCordisPlugin {
  return {
    name: `rabi:contributions/${pluginId}`,
    inject: [CONTRIBUTION_REGISTRY_SERVICE],
    apply(ctx) {
      const registry = ctx.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
      ctx.effect(
        () => registry.registerMany(pluginId, contributions),
        `register contributions ${pluginId}`
      );
    }
  };
}
