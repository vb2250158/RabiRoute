export const PLUGIN_HOSTS = ["manager", "gateway", "web", "desktop"] as const;

export type PluginHost = typeof PLUGIN_HOSTS[number];
export const PLUGIN_EXECUTION_MODES = ["in_process", "isolated", "declarative"] as const;
export type PluginExecutionMode = typeof PLUGIN_EXECUTION_MODES[number];
export type ExecutablePluginEntry = Readonly<{
  execution: "in_process" | "isolated";
  module: string;
}>;
export type DeclarativePluginEntry = Readonly<{
  execution: "declarative";
  resource: string;
}>;
export type PluginEntry = ExecutablePluginEntry | DeclarativePluginEntry;
export type PluginEntries = Readonly<Partial<Record<PluginHost, PluginEntry>>>;
export type PluginManifest = Readonly<{
  schemaVersion: 2;
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
  applicationGenerationId: string;
  managerInstanceId: string;
  activationId: string;
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
export type PluginLifecycle = Readonly<{
  signal: AbortSignal;
  fail(error: unknown): void;
}>;
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
  lifecycle: PluginLifecycle;
  effects: Readonly<{
    add(starter: PluginEffectStarter, label?: string): void;
    adopt(disposer: PluginEffectDisposer, label?: string): void;
  }>;
}>;
export type PluginModule = Readonly<{ activate(context: PluginContext): void | Promise<void> }>;
export type PluginCandidate = Readonly<{
  instanceId: string;
  revision: string;
  manifest: PluginManifest;
  config: unknown;
  entry: Readonly<{
    execution: PluginExecutionMode;
    path: string;
  }>;
  policy?: PluginInstancePolicy;
}>;
export type PluginRestartPolicy = Readonly<{
  mode: "never" | "on_failure";
  maxAttempts: number;
  windowMs: number;
  initialBackoffMs: number;
  maximumBackoffMs: number;
}>;
export type PluginResourcePolicy = Readonly<{
  maxChildProcesses: number;
  shutdownTimeoutMs: number;
}>;
export type PluginInstancePolicy = Readonly<{
  restart: PluginRestartPolicy;
  resources: PluginResourcePolicy;
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
