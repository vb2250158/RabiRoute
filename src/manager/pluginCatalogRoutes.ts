import type { GenerationRuntime, PluginGeneration } from "../plugin-kernel/index.js";
import type { HotPatchInvocation } from "../plugin-kernel/hotPatchProcess.js";
import type { PluginCatalogInput } from "./pluginCatalogPresentation.js";
import type { WebPluginModule } from "./webPluginModules.js";

/** Native asynchronous owners recheck this assertion inside queues and before publication. */
export type PluginCatalogInvocation = Readonly<{ signal?: AbortSignal; assertCurrent(): void }>;
export type PluginReconciliationApiContext = {
  diagnostics?: () => readonly unknown[];
  readiness?: (generation: PluginGeneration) => PluginGeneration["readiness"];
  reconcile?: (invocation: PluginCatalogInvocation) => Promise<PluginGeneration>;
};
export type PluginCatalogApiContext = {
  runtime: GenerationRuntime;
  renderCatalog: (input: PluginCatalogInput, host?: "web" | "desktop", invocation?: PluginCatalogInvocation) => Promise<HotPatchInvocation<unknown>>;
  reconciliation?: PluginReconciliationApiContext;
  /** Original configured source root; never a caller-supplied path. */
  root?: () => string;
  webModules?: {
    list(webRelease?: string | null, invocation?: PluginCatalogInvocation): Promise<readonly WebPluginModule[]> | readonly WebPluginModule[];
    read(id: string, rev: string, relativePath: string, invocation?: PluginCatalogInvocation): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string }>>;
  };
};
