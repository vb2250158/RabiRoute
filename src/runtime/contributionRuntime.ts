import type { RabiUiContribution } from "./contributionRegistry.js";
import { ContributionRegistry } from "./contributionRegistry.js";
import type { RabiCordisFiber, RabiCordisPlugin } from "./cordisHost.js";
import { RabiCordisHost } from "./cordisHost.js";

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

export type ContributionRuntimeMount = {
  registry: ContributionRegistry;
  fibers: readonly RabiCordisFiber[];
  unmount(): Promise<void>;
};

async function disposeFibers(fibers: readonly RabiCordisFiber[]): Promise<void> {
  let firstError: unknown;
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function mountContributionRuntime(
  host: RabiCordisHost,
  plugins: readonly RabiCordisPlugin[] = []
): Promise<ContributionRuntimeMount> {
  const ownedFibers: RabiCordisFiber[] = [];
  try {
    const registryFiber = await host.mount(contributionRegistryServicePlugin);
    ownedFibers.push(registryFiber);
    const registry = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
    const fibers: RabiCordisFiber[] = [];
    for (const plugin of plugins) {
      const fiber = await host.mount(plugin);
      ownedFibers.push(fiber);
      fibers.push(fiber);
    }

    let active = true;
    return {
      registry,
      fibers,
      async unmount() {
        if (!active) return;
        active = false;
        await disposeFibers(ownedFibers);
      }
    };
  } catch (error) {
    await disposeFibers(ownedFibers).catch(() => {});
    throw error;
  }
}
