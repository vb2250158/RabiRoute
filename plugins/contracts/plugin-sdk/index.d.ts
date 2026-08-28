export type PluginHost = "manager" | "gateway" | "web" | "desktop";
export type PluginIdentity = Readonly<{ instanceId: string; pluginId: string; version: string; revision: string; host: PluginHost }>;
export type PluginContribution = Readonly<{ kind: string; id: string; value: unknown }>;
export type PluginDisposer = () => void | Promise<void>;
export type PluginContext = Readonly<{
  identity: PluginIdentity;
  config: unknown;
  services: ServiceResolver;
  contributions: ContributionRegistrar;
  permissions: GrantedPermissions;
  effects: EffectScope;
}>;
export type PluginModule = Readonly<{ activate(context: PluginContext): void | Promise<void> }>;
export function capability(name: string, major: number): string;
export function definePlugin(module: PluginModule): PluginModule;
export class ServiceResolver {
  constructor(services?: readonly (readonly [string, unknown])[]);
  require<T>(capabilityRef: string): T;
  optional<T>(capabilityRef: string): T | undefined;
  provide<T>(capabilityRef: string, value: T): void;
  entries(): readonly (readonly [string, unknown])[];
}
export class GrantedPermissions {
  constructor(values?: readonly string[]);
  has(value: string): boolean;
  require(value: string): void;
  list(): readonly string[];
}
export class ContributionRegistrar {
  register(value: PluginContribution): void;
  list(): readonly PluginContribution[];
}
export class EffectScope {
  add(starter: () => PluginDisposer | Promise<PluginDisposer>, label?: string): void;
  commit(): Promise<void>;
  dispose(): Promise<void>;
}
export class ScopedEventBus<TEvents extends Record<string, unknown> = Record<string, unknown>> {
  on<TKey extends keyof TEvents & string>(name: TKey, listener: (value: TEvents[TKey]) => void): () => boolean;
  emit<TKey extends keyof TEvents & string>(name: TKey, value: TEvents[TKey]): void;
  clear(): void;
}
export class ScopedStorage {
  constructor(namespace: string, values?: Map<string, unknown>);
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): boolean;
  entries(): readonly (readonly [string, unknown])[];
}
export function createPluginTestHarness(options?: Readonly<{
  identity?: PluginIdentity;
  config?: unknown;
  services?: readonly (readonly [string, unknown])[];
  permissions?: readonly string[];
}>): Readonly<{
  context: PluginContext;
  services: ServiceResolver;
  contributions: ContributionRegistrar;
  permissions: GrantedPermissions;
  effects: EffectScope;
  activate(module: PluginModule): Promise<void>;
  dispose(): Promise<void>;
}>;
