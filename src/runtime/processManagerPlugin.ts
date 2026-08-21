import {
  CONTRIBUTION_REGISTRY_SERVICE
} from "./contributionRuntime.js";
import { ContributionRegistry } from "./contributionRegistry.js";
import type { ManagerPluginDefinition } from "./managerPluginRuntime.js";
import type { RabiPluginManifest } from "./pluginCatalog.js";
import type { ProcessPluginHostSnapshot } from "./processPluginHost.js";

export type ProcessManagerPluginController = {
  start(): Promise<ProcessPluginHostSnapshot>;
  stop(reason?: string): Promise<void>;
};

export type ProcessManagerPluginDefinitionOptions = {
  instanceId: string;
  manifest: RabiPluginManifest & { kind: "external-process" };
  controller: ProcessManagerPluginController;
  scope?: string;
};

function assertManifest(expected: ProcessManagerPluginDefinitionOptions["manifest"], actual: ProcessPluginHostSnapshot["manifest"]): void {
  if (!actual
    || actual.id !== expected.id
    || actual.name !== expected.name
    || actual.version !== expected.version
    || actual.kind !== "external-process") {
    throw new Error(`Process plugin manifest changed after discovery: ${expected.id}`);
  }
}

export function createProcessManagerPluginDefinition(
  options: ProcessManagerPluginDefinitionOptions
): ManagerPluginDefinition {
  return {
    instanceId: options.instanceId,
    manifest: options.manifest,
    scope: options.scope,
    async apply(ctx) {
      const snapshot = await options.controller.start();
      try {
        if (snapshot.state !== "active") {
          throw new Error(`Process plugin did not become active: ${options.instanceId}`);
        }
        assertManifest(options.manifest, snapshot.manifest);
      } catch (error) {
        await options.controller.stop("Process plugin activation rejected").catch(() => {});
        throw error;
      }
      ctx.effect(
        () => () => options.controller.stop("Manager plugin unmounted"),
        `stop process manager plugin ${options.instanceId}`
      );
      const registry = ctx.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
      ctx.effect(
        () => registry.registerMany(options.manifest.id, snapshot.contributions, options.instanceId),
        `register process manager contributions ${options.instanceId}`
      );
    }
  };
}
