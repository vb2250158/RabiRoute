import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { MessageEndpointHostPorts, AgentAdapterHostPorts } from "@rabiroute/plugin-sdk";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile, type LoadedPluginProfile, type PluginGeneration, type PluginProfile } from "../plugin-kernel/index.js";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { createMessageEndpointHostPorts, scopeMessageEndpointHostPorts } from "./messageEndpointHostPorts.js";
import { gatewayAdapterTypes, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { classifyRouteChange, endpointRouteInputs, endpointRouteProjection, inheritedEndpointFields, mergeEndpointRouteDeclarations, readEndpointRouteDeclarations, readInstalledEndpointRouteDeclarations, routeSnapshotRevision, routeDeclarationCapability } from "../plugin-runtime-host/messageEndpointRouteConfig.js";
import { readPluginManagementManifest } from "../manager/pluginManagement.js";
import { GatewayRouteSnapshotApplyRejected } from "../shared/gatewayRouteSnapshot.js";
import { PluginProfilePublication } from "../manager/pluginProfilePublication.js";
import { MessageAdapterRegistry, MESSAGE_ADAPTER_REGISTRY_SERVICE } from "./messageAdapterRegistry.js";
import { gatewayEndpointTypesFromManifests } from "../shared/messageEndpointTypes.js";
import { createAgentAdapterHostPorts } from "./agentAdapterHostPorts.js";
import type { AgentAdapterRegistry } from "./agentAdapterRuntime.js";
import { installAgentAdapterGenerationReader, publishedAgentAdapterProviders, resolveAgentAdapterProviders } from "./agentAdapterProviders.js";
import { installAgentAdapterManifestReader, type AgentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import { loadInstalledAgentManagerDescriptors } from "../manager/agentManagerProviders.js";
import type { RabiCordisHost, RabiCordisFiber } from "./cordisHost.js";

export type GatewayEndpointPluginOptions = {
  profilePath: string;
  settingsRoot: string;
  packageRoots: readonly string[];
  runtimeRoot: string;
  adapterTypes: readonly string[];
  hostPorts?: MessageEndpointHostPorts;
  agentHostPorts?: AgentAdapterHostPorts;
  watch?: boolean;
  initialRouteDefinition?: Readonly<GatewayDefinition>;
  initialRouteRevision?: string;
  agentRegistry?: AgentAdapterRegistry;
  agentsOnly?: boolean;
};
export type GatewayEndpointPluginRuntime = {
  registry: MessageAdapterRegistry;
  unmount(): Promise<void>;
  reconcile(): Promise<void>;
  current(): PluginGeneration;
  diagnostics(): readonly { instanceId: string; message: string }[];
  applyRouteSnapshot(definition: Readonly<GatewayDefinition>, revision: string): Promise<void>;
  routeRevision(): string | undefined;
};

/** A shared profile controls individual package activations; a broken endpoint cannot dispose the Gateway. */
export async function mountGatewayEndpointPlugins(host: RabiCordisHost, options: GatewayEndpointPluginOptions): Promise<GatewayEndpointPluginRuntime> {
  const settings = new PluginProfileSettings({ profilePath: options.profilePath, settingsRoot: options.settingsRoot });
  const catalog = new PluginPackageCatalog(options.packageRoots);
  const ports = options.hostPorts ?? await createMessageEndpointHostPorts();
  const registry = new MessageAdapterRegistry();
  const projections: Array<() => void> = [];
  // The original full Route survives a filtered boot environment and later package enablement.
  const activeTypes = new Set(options.initialRouteDefinition ? gatewayAdapterTypes(options.initialRouteDefinition) : options.adapterTypes);
  const scopedPorts = Object.freeze({ ...ports, forActivation(configuration: unknown) {
    const settings = configuration as { __routeTransport?: Readonly<Record<string, unknown>>; __routeInheritedFields?: readonly string[] } | undefined;
    return settings?.__routeTransport ? scopeMessageEndpointHostPorts(ports, settings.__routeTransport, settings.__routeInheritedFields) : ports;
  } });
  const agentPorts = options.agentHostPorts ?? createAgentAdapterHostPorts();
  const kernel = new GenerationRuntime({ host: "gateway", hostServices: [{ capability: "host.message-endpoints@1", value: scopedPorts },
    { capability: "host.agent-adapters@1", value: agentPorts }],
    applicationIdentity: { applicationGenerationId: process.env.RABIROUTE_GATEWAY_GENERATION_ID || "embedded-gateway", managerInstanceId: process.env.GATEWAY_ID || "embedded-gateway" } });
  const releaseAgentProjection = options.agentRegistry?.bindGeneration(() => kernel.current());
  const releaseAgentGeneration = installAgentAdapterGenerationReader(() => kernel.current());
  let declaredAgentManifests: AgentAdapterManifest[] = [];
  const releaseAgentManifests = installAgentAdapterManifestReader(() => {
    const declared = new Map(declaredAgentManifests.map(manifest => [manifest.type, manifest]));
    for (const provider of publishedAgentAdapterProviders(kernel.current()).values()) declared.set(provider.type, provider.manifest as AgentAdapterManifest);
    return [...declared.values()];
  });
  let loaded: LoadedPluginProfile | undefined;
  const publication = new PluginProfilePublication();
  const bootRoute = options.initialRouteDefinition ? structuredClone(options.initialRouteDefinition) : undefined;
  let appliedRoute = bootRoute;
  let appliedRevision = options.initialRouteRevision ?? (appliedRoute ? routeSnapshotRevision(appliedRoute) : undefined);
  let diagnostics: Array<{ instanceId: string; message: string }> = [];
  let disposed = false;
  let queue = Promise.resolve();
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  async function selectedProfile(profile: PluginProfile): Promise<PluginProfile> {
    const instances: PluginProfile["instances"][number][] = [];
    for (const instance of profile.instances) {
      if (!instance.enabled) continue;
      try {
        const source = await catalog.resolve(instance.package, instance.version);
        const manifest = JSON.parse(await fs.readFile(path.join(source.sourceRoot, "rabi.plugin.json"), "utf8"));
        const knownAgent = loaded?.candidates.some(candidate => candidate.instanceId === instance.id && candidate.manifest.provides.some(capability => capability.startsWith("agent.adapter.")))
          || manifest.provides?.some((capability: string) => capability.startsWith("agent.adapter."));
        if (knownAgent && !manifest.entries?.gateway) throw new Error("The Agent replacement removed its active Gateway entry.");
        let agent = false;
        if (manifest.entries?.gateway) {
          try {
            const descriptor = JSON.parse(await fs.readFile(path.join(source.sourceRoot, "agent-adapter.json"), "utf8"));
            agent = typeof descriptor.type === "string" && manifest.provides?.includes(descriptor.capability) && descriptor.manifest?.type === descriptor.type;
            if (knownAgent && !agent) throw new Error("The Agent replacement has an invalid descriptor identity.");
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || knownAgent) throw error; }
        }
        if (agent || !options.agentsOnly && [...gatewayEndpointTypesFromManifests([manifest])].some(type => activeTypes.has(type))) instances.push(instance);
      } catch (error) {
        const previous = loaded?.candidates.find(candidate => candidate.instanceId === instance.id);
        if (previous && (previous.manifest.provides.some(capability => capability.startsWith("agent.adapter.")) || [...gatewayEndpointTypesFromManifests([previous.manifest])].some(type => activeTypes.has(type)))) instances.push(instance);
        diagnostics.push({ instanceId: instance.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ...profile, instances, readyRequires: [] };
  }

  async function reconcileNow(update?: { definition: Readonly<GatewayDefinition>; revision: string }): Promise<void> {
    if (disposed) return;
    if (update && !appliedRoute) throw new GatewayRouteSnapshotApplyRejected("The original boot Route snapshot is unavailable; a lifecycle restart is required.");
    const before = kernel.current();
    const route = update?.definition ?? appliedRoute;
    const snapshot = await settings.snapshot();
    const installed = await readInstalledEndpointRouteDeclarations(snapshot.profile, catalog, (id, version) => readPluginManagementManifest(catalog, id, version));
    const installedAgents = await loadInstalledAgentManagerDescriptors(snapshot.profile, catalog);
    declaredAgentManifests = installedAgents.descriptors.map(descriptor => descriptor.manifest as AgentAdapterManifest);
    const priorCatalog = loaded ? await readEndpointRouteDeclarations(loaded.packages) : { declarations: [], diagnostics: [] };
    const change = update && appliedRoute ? classifyRouteChange(appliedRoute, update.definition, mergeEndpointRouteDeclarations(priorCatalog.declarations, installed.declarations)) : undefined;
    if (change?.sharedChanged) throw new GatewayRouteSnapshotApplyRejected("Shared Route configuration requires its dependency-component lifecycle switch.");
    diagnostics = [...snapshot.diagnostics, ...installed.diagnostics, ...installedAgents.diagnostics];
    const profile = await selectedProfile(snapshot.profile);
    const next = await loadPluginProfile({ profilePath: options.profilePath, profile, packageCatalog: catalog, runtimeRoot: options.runtimeRoot, host: "gateway", previous: loaded,
      assertCurrent() { if (disposed) throw new Error("Gateway plugin preparation stopped during shutdown."); } });
    const routeCatalog = await readEndpointRouteDeclarations(next.packages);
    const declarations = mergeEndpointRouteDeclarations(routeCatalog.declarations, installed.declarations);
    diagnostics.push(...routeCatalog.diagnostics);
    const candidates = next.candidates.map(candidate => {
      if (!route) return candidate;
      const declaration = declarations.find(item => candidate.manifest.provides.includes(routeDeclarationCapability(item)));
      if (declaration?.agentType) {
        const values = endpointRouteProjection(route, declaration);
        // Explicit Route values, including empty credentials, always win. Only fields
        // absent from both snapshots retain the original environment defaults.
        const beforeValues = (bootRoute ?? {}) as Readonly<Record<string, unknown>>;
        const afterValues = route as Readonly<Record<string, unknown>>;
        const inherited = new Set(Object.entries(declaration.runtimeFields).filter(([, mapping]) =>
          mapping.paths.every(key => beforeValues[key] === undefined && afterValues[key] === undefined)
        ).map(([field]) => field));
        const overrides = Object.fromEntries(Object.entries(values).filter(([field]) => !inherited.has(field)));
        return Object.freeze({ ...candidate, config: { ...(candidate.config as Record<string, unknown>),
          __agentInputs: endpointRouteInputs(route, declaration),
          __agentConfiguration: overrides,
          __agentEnvironment: Object.fromEntries(Object.entries(declaration.environmentFields ?? {}).filter(([,field]) => !inherited.has(field)).map(([key,field]) => [key, String(values[field] ?? "")]))
        } });
      }
      const routeTypes = gatewayAdapterTypes(route);
      return Object.freeze({ ...candidate, config: { ...(candidate.config as Record<string, unknown>),
        __routeTransport: { messageAdapterTypes: routeTypes, messageEndpointTypes: routeTypes, ...(declaration ? endpointRouteProjection(route, declaration) : {}) },
        __routeTransportInputs: declaration ? endpointRouteInputs(route, declaration) : {},
        __routeInheritedFields: bootRoute && declaration ? inheritedEndpointFields(bootRoute, route, declaration) : []
      } });
    });
    await kernel.switch(candidates, { readyRequires: [] });
    loaded = publication.capture(next, kernel.current()).profile;
    for (const failure of next.loadFailures) diagnostics.push({ instanceId: failure.instanceId, message: failure.error.message });
    for (const release of projections.splice(0)) release();
    for (const record of kernel.current().records) {
      if (record.status !== "active") continue;
      for (const type of gatewayEndpointTypesFromManifests([record.manifest])) {
        if (!activeTypes.has(type)) continue;
        projections.push(registry.register({ manifest: { type, label: type, host: "gateway", transport: "internal", lifecycle: "fiber" },
          create() { throw new Error("Endpoint instances belong to their plugin activation."); } }));
      }
    }
    if (update) {
      const affectedTypes = change?.endpointTypes ?? declarations.map(item => item.endpointType);
      const affectedCapabilities = declarations.filter(item => affectedTypes.includes(item.endpointType)).map(routeDeclarationCapability);
      const affected = kernel.current().records.filter(record => affectedCapabilities.some(capability => record.manifest.provides.includes(capability)));
      const affectedIds = new Set([...next.candidates, ...before.records.map(record => ({ instanceId: record.identity.instanceId, manifest: record.manifest }))]
        .filter(candidate => affectedCapabilities.some(capability => candidate.manifest.provides.includes(capability))).map(candidate => candidate.instanceId));
      const missing = [...affectedIds].some(id => !affected.some(record => record.identity.instanceId === id));
      const loadFailed = next.loadFailures.some(failure => affectedIds.has(failure.instanceId));
      const failures = affected.filter(record => record.status !== "active" || record.error);
      const retiring = kernel.current().cleanupDiagnostics.filter(item => !item.lateConfirmed && affected.some(record => record.identity.instanceId === item.instanceId));
      if (missing || loadFailed || failures.length || retiring.length) {
        const unchanged = affected.every(record => before.records.some(previous => previous.identity.instanceId === record.identity.instanceId && previous.identity.activationId === record.identity.activationId));
        if (unchanged && !retiring.length) throw new GatewayRouteSnapshotApplyRejected("Endpoint preparation was rejected; the original activations remain unchanged.");
        throw new Error("Endpoint Route configuration was not fully activated or its original retirement remains unconfirmed.");
      }
      appliedRoute = structuredClone(update.definition);
      appliedRevision = update.revision;
    }
  }
  function reconcile(): Promise<void> {
    const next = queue.then(() => reconcileNow());
    queue = next.catch(() => {});
    return next;
  }
  const changed = () => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = undefined; void reconcile().catch(error => { if (!disposed) console.error("Gateway plugin reconciliation failed", error); }); }, 30);
    timer.unref();
  };
  async function stop(): Promise<void> {
    disposed = true;
    const stoppedPreparation = catalog.dispose();
    void stoppedPreparation.catch(() => {});
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await queue;
    const results = await Promise.allSettled([kernel.shutdown(), stoppedPreparation]);
    releaseAgentProjection?.();
    releaseAgentGeneration();
    releaseAgentManifests();
    for (const release of projections.splice(0)) release();
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  let fiber: RabiCordisFiber;
  try {
    fiber = await host.mount({ name: "rabi:gateway-endpoint-plugins", async apply(context) {
      context.provide(MESSAGE_ADAPTER_REGISTRY_SERVICE, registry);
      await context.effect(async () => {
        if (options.watch !== false) {
          for (const root of options.packageRoots) {
            await fs.mkdir(root, { recursive: true });
            watchers.push(watch(root, { recursive: true }, changed));
          }
          const profileDirectory = path.dirname(options.profilePath);
          await fs.mkdir(profileDirectory, { recursive: true });
          watchers.push(watch(profileDirectory, (_event, filename) => {
            if (filename === null || filename.toString() === path.basename(options.profilePath)) changed();
          }));
          await fs.mkdir(options.settingsRoot, { recursive: true });
          watchers.push(watch(options.settingsRoot, (_event, filename) => {
            if (filename === null || filename.toString().endsWith(".json")) changed();
          }));
        }
        await reconcile();
        return stop;
      }, "run independent endpoint package activations");
    } });
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return {
    registry, reconcile, current: () => kernel.current(), diagnostics: () => [...diagnostics, ...resolveAgentAdapterProviders(kernel.current()).diagnostics],
    applyRouteSnapshot(definition, revision) {
      const update = { definition: structuredClone(definition), revision };
      const next = queue.then(() => reconcileNow(update));
      queue = next.catch(() => {});
      return next;
    },
    routeRevision: () => appliedRevision,
    async unmount() { await fiber.dispose(); }
  };
}
