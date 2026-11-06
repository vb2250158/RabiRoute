export type PluginBuildSpecification = {
  source?: string;
  factory?: string;
  exportAllSource?: string;
  exports?: Array<({ source: string; hostModule?: never } | { hostModule: string; source?: never }) & { name: string; exportName?: string }>;
  scopedEnvironment?: boolean;
  resources?: Array<{ source: string; target: string }>;
  workers?: Array<{ source: string; target: string; mode?: "host-factory" }>;
};
export function bundlePluginRuntime(pluginRoot: string, specification: PluginBuildSpecification, options?: { packageId?: string; hostApiPath?: string; outputModule?: string }): Promise<{ hostModules: string[]; inputs: string[]; contents: string }>;
export function buildPluginPackage(options?: { pluginRoot?: string; outputDirectory?: string; hostApiPath?: string }): Promise<{ packageId: string; version: string; outputDirectory: string; runtimes: Array<{ descriptor: string; hostModules: string[]; inputs: string[] }> }>;
export function transformPluginSourceUrls(contents: string, options: { file: string; pluginRoot: string; outputModule?: string; workers?: Array<{ source: string; target: string }>; resources?: Array<{ source: string; target: string }>; packageId?: string; runtimeFactory?: boolean; runtimeModuleUrlIdentifier?: string }): string;
