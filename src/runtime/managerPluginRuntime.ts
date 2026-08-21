import { randomUUID } from "node:crypto";
import type { RabiUiContribution } from "./contributionRegistry.js";
import { ContributionRegistry } from "./contributionRegistry.js";
import {
  CONTRIBUTION_REGISTRY_SERVICE,
  contributionRegistryServicePlugin
} from "./contributionRuntime.js";
import type {
  RabiCordisContext,
  RabiCordisFiber,
  RabiCordisPlugin
} from "./cordisHost.js";
import { RabiCordisHost } from "./cordisHost.js";
import {
  PluginCatalog,
  type RabiPluginErrorSummary,
  type RabiPluginManifest
} from "./pluginCatalog.js";

export const PLUGIN_CATALOG_SERVICE = "rabi.plugins";

export const pluginCatalogServicePlugin: RabiCordisPlugin = {
  name: "rabi:plugin-catalog",
  apply(ctx) {
    const catalog = new PluginCatalog();
    ctx.provide(PLUGIN_CATALOG_SERVICE, catalog);
    ctx.effect(() => () => catalog.clear(), "clear plugin catalog");
  }
};

export type ManagerPluginDefinition = {
  instanceId: string;
  manifest: RabiPluginManifest;
  scope?: string;
  provides?: readonly string[];
  requires?: readonly string[];
  optional?: readonly string[];
  missingCapabilities?: readonly string[];
  contributions?: readonly RabiUiContribution[];
  apply?(ctx: RabiCordisContext): void | Promise<void>;
};

export type MountedManagerPlugin = {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly fiber?: RabiCordisFiber;
  unmount(): Promise<void>;
};

export type ManagerPluginRuntimeMount = {
  generation: string;
  catalog: PluginCatalog;
  contributions: ContributionRegistry;
  plugins: ReadonlyMap<string, MountedManagerPlugin>;
  mount(definition: ManagerPluginDefinition): Promise<MountedManagerPlugin>;
  unmount(): Promise<void>;
};

function pluginErrorSummary(error: unknown): RabiPluginErrorSummary {
  return {
    code: "activation_failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

export function managerCapabilityService(capability: string): string {
  const normalized = capability.trim();
  if (!normalized) throw new Error("Manager plugin capability is required.");
  return `rabi.manager.capability.${normalized}`;
}

function definitionPlugin(
  definition: ManagerPluginDefinition,
  instanceId: string,
  pluginId: string
): RabiCordisPlugin {
  return {
    name: `rabi:manager-plugin/${instanceId}`,
    inject: [
      PLUGIN_CATALOG_SERVICE,
      CONTRIBUTION_REGISTRY_SERVICE,
      ...(definition.requires ?? []).map(managerCapabilityService)
    ],
    async apply(ctx) {
      for (const capability of definition.provides ?? []) {
        ctx.provide(managerCapabilityService(capability), { capability, instanceId });
      }
      if (definition.contributions?.length) {
        const registry = ctx.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
        ctx.effect(
          () => registry.registerMany(pluginId, definition.contributions ?? [], instanceId),
          `register manager contributions ${instanceId}`
        );
      }
      await definition.apply?.(ctx);
    }
  };
}

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

export async function mountManagerPluginRuntime(
  host: RabiCordisHost,
  definitions: readonly ManagerPluginDefinition[] = []
): Promise<ManagerPluginRuntimeMount> {
  const serviceFibers: RabiCordisFiber[] = [];
  const plugins = new Map<string, MountedManagerPlugin>();
  const generation = randomUUID();
  let active = true;

  try {
    serviceFibers.push(await host.mount(pluginCatalogServicePlugin));
    serviceFibers.push(await host.mount(contributionRegistryServicePlugin));
    const catalog = host.context.get(PLUGIN_CATALOG_SERVICE, true) as PluginCatalog;
    const contributions = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;

    const mount = async (definition: ManagerPluginDefinition): Promise<MountedManagerPlugin> => {
      if (!active) throw new Error("Manager plugin runtime is unmounted.");

      const requestedInstanceId = definition.instanceId.trim();
      if (plugins.has(requestedInstanceId)) {
        throw new Error(`Manager plugin already mounted: ${requestedInstanceId}`);
      }

      const existing = catalog.get(requestedInstanceId);
      const requestedDeclaration = {
        instanceId: requestedInstanceId,
        manifest: definition.manifest,
        host: "manager",
        scope: definition.scope,
        missingCapabilities: definition.missingCapabilities
      } as const;
      const declaration = existing
        ? catalog.refreshDeclaration(requestedDeclaration)
        : catalog.declare(requestedDeclaration);
      const { instanceId, pluginId } = declaration;

      let pluginMounted = true;
      let fiber: RabiCordisFiber | undefined;
      const mounted: MountedManagerPlugin = {
        instanceId,
        pluginId,
        get fiber() { return fiber; },
        async unmount() {
          if (!pluginMounted) return;
          pluginMounted = false;
          let firstError: unknown;
          try {
            await fiber?.dispose();
          } catch (error) {
            firstError = error;
          }
          try {
            catalog.inactive(instanceId);
          } catch (error) {
            firstError ??= error;
          } finally {
            plugins.delete(instanceId);
          }
          if (firstError) throw firstError;
        }
      };

      if (declaration.status === "waiting_dependency") {
        plugins.set(instanceId, mounted);
        return mounted;
      }

      catalog.activating(instanceId);
      try {
        fiber = await host.mount(definitionPlugin(definition, instanceId, pluginId));
        catalog.active(instanceId);
        plugins.set(instanceId, mounted);
        return mounted;
      } catch (error) {
        pluginMounted = false;
        if (fiber) {
          await fiber.dispose().catch(() => {});
          fiber = undefined;
        }
        catalog.failed(instanceId, pluginErrorSummary(error));
        plugins.delete(instanceId);
        throw error;
      }
    };

    for (const definition of definitions) {
      await mount(definition);
    }

    return {
      generation,
      catalog,
      contributions,
      plugins,
      mount,
      async unmount() {
        if (!active) return;
        active = false;
        let firstError: unknown;
        for (const plugin of [...plugins.values()].reverse()) {
          try {
            await plugin.unmount();
          } catch (error) {
            firstError ??= error;
          }
        }
        try {
          await disposeFibers(serviceFibers);
        } catch (error) {
          firstError ??= error;
        }
        if (firstError) throw firstError;
      }
    };
  } catch (error) {
    for (const plugin of [...plugins.values()].reverse()) {
      await plugin.unmount().catch(() => {});
    }
    await disposeFibers(serviceFibers).catch(() => {});
    throw error;
  }
}
