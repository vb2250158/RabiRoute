export const PLUGIN_HOSTS = ["manager", "gateway", "web", "desktop"] as const;

export type PluginHost = typeof PLUGIN_HOSTS[number];
export type PluginEntries = Readonly<Partial<Record<PluginHost, string>>>;
export type PluginManifest = Readonly<{
  schemaVersion: 1;
  id: string;
  version: string;
  entries: PluginEntries;
  provides: readonly string[];
  requires: readonly string[];
  optional: readonly string[];
  permissions: readonly string[];
  configSchema?: Readonly<Record<string, unknown>>;
  stateSchemaVersion?: number;
}>;
export type PluginIdentity = Readonly<{
  instanceId: string;
  pluginId: string;
  version: string;
  revision: string;
  host: PluginHost;
}>;
export type PluginContribution = Readonly<{ kind: string; id: string; value: unknown }>;
export type PluginServiceRegistration = Readonly<{
  capability: string;
  providerInstanceId: string;
  value: unknown;
}>;
export type PluginEffectDisposer = () => void | Promise<void>;
export type PluginEffectStarter = () => PluginEffectDisposer | Promise<PluginEffectDisposer>;
export type PluginContext = Readonly<{
  identity: PluginIdentity;
  config: unknown;
  services: Readonly<{
    require<T>(capability: string): T;
    optional<T>(capability: string): T | undefined;
    provide<T>(capability: string, value: T): void;
  }>;
  contributions: Readonly<{ register(contribution: PluginContribution): void }>;
  permissions: Readonly<{
    has(permission: string): boolean;
    require(permission: string): void;
    list(): readonly string[];
  }>;
  effects: Readonly<{ add(starter: PluginEffectStarter, label?: string): void }>;
}>;
export type PluginModule = Readonly<{ activate(context: PluginContext): void | Promise<void> }>;
export type PluginCandidate = Readonly<{
  instanceId: string;
  revision: string;
  manifest: PluginManifest;
  config: unknown;
  module: PluginModule;
}>;
export type HostService = Readonly<{ capability: string; value: unknown }>;
export type PluginRuntimeStatus = "active" | "waiting_dependency" | "failed";
export type PluginRuntimeRecord = Readonly<{
  identity: PluginIdentity;
  manifest: PluginManifest;
  status: PluginRuntimeStatus;
  missingCapabilities: readonly string[];
  error?: Readonly<{ code: string; message: string }>;
}>;
