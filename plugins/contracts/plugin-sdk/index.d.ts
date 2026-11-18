export type PluginHost = "manager" | "gateway" | "web" | "desktop";
import type { PluginPublicationRegistrar } from "./publication.js";
export { PublicationScope } from "./publication.js";
export type { PluginPublication, PluginPublicationContext, PluginPublicationRegistrar } from "./publication.js";
export type { ApiMethod, ApiSchema, ApiBodyContract, ApiResponseContract, ApiOperationContract, ApiOperationDiscovery, ApiDiscoveryCategory, ApiDiscoveryInputSource, ApiDiscoveryExample, ApiOperationInput, ApiOperationResult, ApiOperationStream, ApiOperationDefinition, ApiOperationRegistration, ApiUpgradeSession, ApiUpgradeInput, ApiUpgradeDefinition, ApiUpgradeRegistration, ApiHttpProxyInput, ApiHttpProxyDefinition, ManagerApiOperationsService } from "./api-operation-contract.js";
export type PluginIdentity = Readonly<{ applicationGenerationId: string; managerInstanceId: string; activationId: string; instanceId: string; pluginId: string; version: string; revision: string; host: PluginHost }>;
export type PluginContribution = Readonly<{ kind: string; id: string; value: unknown }>;
export type PluginDisposer = () => void | Promise<void>;
/** Internal resource upgrade service. The original release store owns import verification and selection CAS. */
export type DesktopNativePrepared = unknown;
export type DesktopNativeStatus = Readonly<{ revision: number; release: unknown; state: string }>;
export type DesktopNativeService = Readonly<{
  status(): Promise<DesktopNativeStatus>;
  prepare(releaseDigest: string): Promise<DesktopNativePrepared>;
  activate(prepared: DesktopNativePrepared, expectedRevision: number): Promise<unknown>;
  discard(prepared: DesktopNativePrepared): Promise<void>;
}>;

export type PluginContext = Readonly<{
  identity: PluginIdentity;
  config: unknown;
  services: ServiceResolver;
  contributions: ContributionRegistrar;
  permissions: GrantedPermissions;
  effects: EffectScope;
  lifecycle: Readonly<{ signal: AbortSignal; fail(error: unknown): void }>;
  publication: PluginPublicationRegistrar;
}>;
export type PluginModule = Readonly<{ activate(context: PluginContext): void | Promise<void> }>;
export function capability(name: string, major: number): string;
export function definePlugin(module: PluginModule): PluginModule;
/** A descriptor is valid only while the original native listener and generation remain current. */
export type GatewayListenerDescriptor = Readonly<{
  gatewayId: string; gatewayGenerationId: string; pid: number;
  listenerId: string; leaseId: string; protocol: string;
  address: Readonly<{ protocol: "http" | "https"; hostname?: string; port: number }>;
  assertCurrent(): void;
}>;
/** Supplied by host.message-endpoints@3 on the Manager host. No listener is started by these reads. */
export type GatewayListenerAccess = Readonly<{
  readListener(gatewayId: string, localName: string): GatewayListenerDescriptor | undefined;
  waitForListener(gatewayId: string, localName: string, options: Readonly<{ signal: AbortSignal; timeoutMs: number }>): Promise<GatewayListenerDescriptor>;
}>;
/** Shared owners are supplied as explicit ports; platform factories stay in their packages. */
export type MessageEndpointHostPorts = Readonly<{
  prepareModules(ids: readonly string[]): Promise<void>;
  module<T = Readonly<Record<string, unknown>>>(id: string): T;
  assertModules(ids: readonly string[]): void;
}>;
export type MessageEndpointStartup = Readonly<{
  signal: AbortSignal;
  /** Registers cleanup for resources acquired by a failed start. Register before acquiring them. */
  onFailure(dispose: PluginDisposer): void;
}>;
export type MessageEndpoint = Readonly<{ type: string; start(startup?: MessageEndpointStartup): void | PluginDisposer | Promise<void | PluginDisposer> }>;
export function ownMessageEndpoint(context: Readonly<{ effects: Pick<EffectScope, "adopt">; publication: Pick<PluginContext["publication"], "add"> }>, endpoint: MessageEndpoint): void;
export type AgentAdapterHostPorts = MessageEndpointHostPorts & Readonly<{ environment?: Readonly<Record<string, string | undefined>>; manager?: unknown; forActivation?(configuration: unknown): AgentAdapterHostPorts }>;
export type AgentAdapterDescriptor = Readonly<{ type: string; label: string; maturity: "verified" | "experimental" | "stub";
  transport: Readonly<{ protocol: string; mode: string }>; host?: Readonly<{ name: string; required: boolean }>;
  capabilities: Readonly<Record<string, unknown>> }>;
export function parseAgentAdapterDescriptor(value: unknown): AgentAdapterDescriptor;
export type AgentInitializationMode = "exclusive" | "independent";
export type AgentAdapterPackageDescriptor = Readonly<{ type: string; capability: string; manifest: AgentAdapterDescriptor; sessionBinding: Readonly<Record<string, string>>;
  initializationModes?: Readonly<Partial<Record<"manager" | "gateway", AgentInitializationMode>>> }>;
export function parseAgentAdapterPackageDescriptor(value: unknown): AgentAdapterPackageDescriptor;
export type AgentAdapterInvocation = Readonly<{ signal?: AbortSignal; assertCurrent?(): void; snapshot?: Readonly<Record<string, unknown>>; [key: string]: unknown }>;
export type AgentAdapterProvider = Readonly<{ type: string; capability: string; manifest: AgentAdapterDescriptor; sessionBinding: Readonly<Record<string, string>>; identity: PluginIdentity; serviceEndpoint?: unknown; deviceEndpoint?: unknown;
  acquire(snapshot: Readonly<Record<string, unknown>>): Readonly<{ snapshot: Readonly<Record<string, unknown>>;
    call<T = unknown>(operation: string, payload: unknown, invocation?: AgentAdapterInvocation): Promise<T>; release(): void }>;
  invoke<T = unknown>(operation: string, payload: unknown, invocation?: AgentAdapterInvocation): Promise<T>;
  runAcceptedWork<T>(operation: () => T | Promise<T>): Promise<T>; inspect(): Readonly<{ accepting: boolean; activeLeases: number }> }>;
export type AgentAdapterContext = Readonly<Pick<PluginContext, "identity" | "lifecycle" | "publication"> & {
  services: Pick<ServiceResolver, "provide">;
  contributions: Pick<ContributionRegistrar, "register">;
  effects: Pick<EffectScope, "adopt">;
}>;
export function ownAgentAdapter(context: AgentAdapterContext, definition: Readonly<{ type: string; capability: string; manifest: AgentAdapterDescriptor; sessionBinding?: Readonly<Record<string, string>>;
  operations: Readonly<Record<string, (payload: any, invocation?: AgentAdapterInvocation, snapshot?: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>>>;
  initializationModes?: AgentAdapterPackageDescriptor["initializationModes"];
  initialization?: Readonly<{ mode: AgentInitializationMode; start?(signal: AbortSignal): void | Promise<void> }>;
  serviceEndpoint?: unknown; deviceEndpoint?: unknown; dispose?(): void | Promise<void> }>): AgentAdapterProvider;
type AcceptedWorkContext = Readonly<Pick<PluginContext, "lifecycle" | "publication"> & { effects: Pick<EffectScope, "adopt"> }>;
export function ownMessageEndpointScan(context: AcceptedWorkContext & Readonly<{ services: Pick<ServiceResolver, "require"> }>, provider: Readonly<{ type: string; label: string; maturity: "verified" | "experimental" | "stub"; scan(): unknown | Promise<unknown> }>): void;
export type PluginAcceptedWork = Readonly<{
  runAcceptedWork<T>(operation: () => T | Promise<T>): Promise<T>;
  acquire(snapshot: Readonly<Record<string, unknown>>): Readonly<{ snapshot: Readonly<Record<string, unknown>>; run<T>(operation: () => T | Promise<T>): Promise<T>; release(): void }>;
  inspect(): Readonly<{ accepting: boolean; activeLeases: number }>;
}>;
export function ownPluginAcceptedWork(context: AcceptedWorkContext, label?: string, cleanup?: PluginDisposer): PluginAcceptedWork;
export type MessageEndpointEgressLease = Readonly<{ snapshot: Readonly<Record<string, unknown>>; call<T>(operation: string, args: readonly unknown[]): Promise<T>; release(): void }>;
export type MessageEndpointSendVariant = Readonly<{
  /** Use a channel-qualified type, for example napcat.group-forward. */
  type: string;
  contractVersion: number;
  description: string;
  dataSchema: Readonly<Record<string, unknown>>;
  paramsSchema: Readonly<Record<string, unknown>>;
  /** Read the complete outgoing text for the unchanged host text policy. Must be pure. */
  readText(data: Readonly<Record<string, unknown>>): string;
  operation: string;
}>;
export type MessageEndpointVariantSendInput = Readonly<{
  deliveryId: string;
  gatewayId: string;
  routeId: string;
  target: Readonly<Record<string, unknown>>;
  data: Readonly<Record<string, unknown>>;
  sourceDataDirs: readonly string[];
}>;
export type MessageEndpointVariantSendResult = Readonly<{
  messageId: string;
  conversationKey?: string;
  target?: Readonly<{ targetType?: "group" | "private"; groupId?: string; userId?: string; instanceId?: string }>;
}>;
export type MessageEndpointEgressProvider = Readonly<{ identity: PluginIdentity; sendVariants?: Readonly<Record<string, MessageEndpointSendVariant>>; acquire(snapshot: Readonly<Record<string, unknown>>): MessageEndpointEgressLease; runAcceptedWork<T>(operation: () => T | Promise<T>): Promise<T>; inspect(): Readonly<{ accepting: boolean; activeLeases: number }> }>;
export function ownMessageEndpointEgress(context: PluginContext, definition: Readonly<{ type: string; operations: Readonly<Record<string, (...args: any[]) => unknown>>; sendVariants?: readonly MessageEndpointSendVariant[]; dispose?: PluginDisposer }>): MessageEndpointEgressProvider;
export type MessageEndpointCatalog = Readonly<{
  title: string; note: string; icon: string; order: number;
  group: Readonly<{ id: string; title: string; note: string; order: number }>;
}>;
export type MessageEndpointSettings = Readonly<{
  surface: "route.adapters"; endpointType: string; catalog?: MessageEndpointCatalog;
  rendererId: string; schemaId: string; readCommandId: string; writeCommandId: string;
  label: Readonly<{ fallback: string; key?: string }>; slot: string; hosts: readonly ("web" | "desktop")[]; order?: number; icon?: string;
}>;
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
  adopt(disposer: PluginDisposer, label?: string): void;
  signal(): AbortSignal;
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
  identity?: Partial<PluginIdentity>;
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
