import { getTimeoutMs } from "./runtimeTimeouts.js";
import { randomUUID } from "node:crypto";
import { PublicationScope } from "@rabiroute/plugin-sdk/publication";
import { runPluginActivation } from "./pluginActivationContext.js";
import { selectRequiredCapabilityProviders, type CapabilityGraphPlan } from "./capabilityGraph.js";
import { isolateCapabilityGraph, sharedWebResourceKey } from "./capabilityGraphIsolation.js";
import { ContributionRegistryDraft, type ContributionRegistrySnapshot, type RegisteredPluginContribution } from "./contributionRegistry.js";
import { EffectScope } from "./effectScope.js";
import { GrantedPermissions } from "./permissionGate.js";
import { createBuiltinPluginExecutor, type PluginExecutor } from "./pluginExecutor.js";
import { ServiceRegistryDraft, type ServiceRegistrySnapshot } from "./serviceRegistry.js";
import type {
  HostService,
  PluginCandidate,
  PluginContext,
  PluginContribution,
  PluginEffectDisposer,
  PluginEffectStarter,
  PluginHost,
  PluginIdentity,
  PluginManifest,
  PluginRuntimeRecord,
  PluginServiceRegistration
} from "./types.js";

export type PluginGeneration = Readonly<{
  id: string;
  sequence: number;
  createdAt: string;
  host: PluginHost;
  applicationGenerationId: string;
  managerInstanceId: string;
  readyRequires: readonly string[];
  readiness: Readonly<{
    state: "ready" | "degraded";
    missingCapabilities: readonly string[];
  }>;
  records: readonly PluginRuntimeRecord[];
  services: ServiceRegistrySnapshot;
  contributions: ContributionRegistrySnapshot;
  cleanupDiagnostics: readonly PluginCleanupDiagnostic[];
}>;

export type PluginCleanupDiagnostic = Readonly<{
  instanceId: string;
  activationId: string;
  phase: "rollback" | "superseded" | "runtime_failure" | "shutdown";
  message: string;
  /** The ordinary retirement budget expired, then application shutdown joined the actual owner. */
  lateConfirmed?: true;
}>;

export const DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS = 15_000;

export type GenerationSwitchResult = Readonly<{
  changed: boolean;
  generation: PluginGeneration;
  previousGenerationId?: string;
}>;

export type PluginRuntimeFailureEvent = Readonly<{
  identity: PluginIdentity;
  error: Readonly<{ code: "runtime_failed"; message: string }>;
  generation: PluginGeneration;
}>;

export type GenerationRuntimeOptions = Readonly<{
  host: PluginHost;
  hostServices?: readonly HostService[];
  /** @deprecated Installed plugin declarations define available host APIs; ignored since 0.3.22, remove in 0.4.0. */
  grantedPermissions?: (identity: PluginIdentity) => readonly string[];
  applicationIdentity?: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>;
  readyRequires?: readonly string[];
  executor?: PluginExecutor;
  activationTimeoutMs?: number;
  onRuntimeFailure?: (event: PluginRuntimeFailureEvent) => void | Promise<void>;
  /** Observes the committed generation before superseded resources start draining. */
  onPublished?: (generation: PluginGeneration) => void;
}>;

export type GenerationSwitchOptions = Readonly<{
  readyRequires?: readonly string[];
  /** Await remains the default; background returns the committed initialization intent. */
  initialization?: "await" | "background";
  /** Missing required capabilities are diagnostic data only for explicit reporting hosts; other hosts stay strict. */
  requiredCapabilityPolicy?: "strict" | "report";
  /** Per-invocation synchronous source/identity assertion after preparation, before publication. */
  beforePublish?: () => void;
}>;

function assertBeforePublish(options: GenerationSwitchOptions): void {
  const result: unknown = options.beforePublish?.();
  if (result && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Generation switch beforePublish fence must be synchronous.");
  }
}

export class RequiredPluginCapabilitiesUnavailableError extends Error {
  readonly code = "required_plugin_capabilities_unavailable";

  constructor(
    readonly missingCapabilities: readonly string[],
    readonly diagnostics: readonly PluginRuntimeRecord[] = []
  ) {
    const failures = diagnostics
      .filter(record => record.status !== "active" || record.error)
      .slice(0, 8)
      .map(record => `${record.identity.instanceId}: ${record.error?.message ?? record.status}`);
    super(`Required plugin capabilities are unavailable: ${missingCapabilities.join(", ")}${
      failures.length ? `. Plugin diagnostics: ${failures.join("; ")}` : ""
    }`);
    this.name = "RequiredPluginCapabilitiesUnavailableError";
  }
}

export function selectReadyPluginCandidates(
  candidates: readonly PluginCandidate[],
  readyRequires: readonly string[],
  hostCapabilities: readonly string[] = []
): readonly PluginCandidate[] {
  const hostCapabilitySet = new Set(hostCapabilities.map(capability => capability.trim()).filter(Boolean));
  const isolated = isolateCapabilityGraph(candidates, hostCapabilitySet);
  return selectRequiredCapabilityProviders(candidates, isolated.plan, readyRequires, hostCapabilitySet);
}

type ActivePluginState = Readonly<{
  candidate: PluginCandidate;
  identity: PluginIdentity;
  manifest: PluginManifest;
  signature: string;
  scope: EffectScope;
  publication: PublicationScope;
  services: readonly PluginServiceRegistration[];
  boundServices?: Set<PluginServiceRegistration>;
  contributions: readonly RegisteredPluginContribution[];
}>;

type InitializationFlight = {
  key: string;
  candidates: readonly PluginCandidate[];
  signatures: readonly string[];
  identities: readonly PluginIdentity[];
  externalServices: ReadonlyMap<string, PluginServiceRegistration | undefined>;
  scopes: Set<EffectScope>;
  ownedStates: ActivePluginState[];
  cancelled: boolean;
  prepared?: readonly ActivePluginState[];
  failure?: ComponentFailure;
  settled: boolean;
};
type OwnedWork = { instances: ReadonlySet<string>; completion: Promise<unknown> };

type ComponentFailure = Readonly<{ instanceId: string; error: unknown }>;

function errorSummary(error: unknown, code = "activation_failed") {
  return Object.freeze({ code, message: error instanceof Error ? error.message : String(error) });
}

function failedRecord(identity: PluginIdentity, manifest: PluginManifest, error: unknown, code = "activation_failed"): PluginRuntimeRecord {
  return Object.freeze({
    identity,
    manifest,
    status: "failed",
    missingCapabilities: Object.freeze([]),
    error: errorSummary(error, code)
  });
}

function waitingRecord(identity: PluginIdentity, manifest: PluginManifest, missing: readonly string[]): PluginRuntimeRecord {
  return Object.freeze({
    identity,
    manifest,
    status: "waiting_dependency",
    missingCapabilities: Object.freeze([...missing])
  });
}

function activeRecord(state: ActivePluginState, ...updateFailure: [] | [unknown]): PluginRuntimeRecord {
  return Object.freeze({
    identity: state.identity,
    manifest: state.manifest,
    status: "active",
    missingCapabilities: Object.freeze([]),
    ...(updateFailure.length ? { error: errorSummary(updateFailure[0], "update_failed_using_previous_revision") } : {})
  });
}

function pluginIdentity(
  candidate: PluginCandidate,
  host: PluginHost,
  applicationGenerationId: string,
  managerInstanceId: string
): PluginIdentity {
  if (!candidate.manifest.entries[host]) throw new Error(`Plugin does not provide a ${host} entry: ${candidate.manifest.id}.`);
  const instanceId = candidate.instanceId.trim();
  const revision = candidate.revision.trim();
  if (!instanceId || !revision) throw new Error("Plugin instanceId and revision are required.");
  return Object.freeze({
    applicationGenerationId,
    managerInstanceId,
    activationId: randomUUID(),
    instanceId,
    pluginId: candidate.manifest.id,
    version: candidate.manifest.version,
    revision,
    host
  });
}

function candidateSignature(candidate: PluginCandidate, granted: readonly string[]): string {
  return JSON.stringify({
    revision: candidate.revision,
    manifest: candidate.manifest,
    config: candidate.config,
    entry: candidate.entry,
    policy: candidate.policy,
    granted: [...granted].sort()
  });
}

function dependencyComponents(
  candidates: readonly PluginCandidate[],
  plan: CapabilityGraphPlan,
  previous: ReadonlyMap<string, ActivePluginState>,
  signatures: ReadonlyMap<string, string>
): Readonly<{ components: readonly (readonly string[])[]; rebuilding: ReadonlySet<string> }> {
  const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
  const rebuilding = new Set([...byId.keys()].filter(id => previous.get(id)?.signature !== signatures.get(id)));
  const removedCapabilities = new Set([...previous.values()].flatMap(state =>
    state.manifest.provides.filter(capability => plan.providers.get(capability) !== state.identity.instanceId)
  ));
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of byId.values()) {
      if (!previous.has(candidate.instanceId) || rebuilding.has(candidate.instanceId)) continue;
      if ([...candidate.manifest.requires, ...candidate.manifest.optional].some(capability =>
        removedCapabilities.has(capability) || rebuilding.has(plan.providers.get(capability) ?? "")
      )) { rebuilding.add(candidate.instanceId); changed = true; }
    }
  }
  const parent = new Map([...byId.keys()].map(id => [id, id]));
  const root = (id: string): string => {
    while (parent.get(id) !== id) id = parent.get(id)!;
    return id;
  };
  const webResources = new Map<string, string[]>();
  for (const candidate of candidates) {
    const key = sharedWebResourceKey(candidate);
    if (key) webResources.set(key, [...(webResources.get(key) ?? []), candidate.instanceId]);
  }
  for (const [key, members] of webResources) {
    const confirmed = new Set([...previous.values()].filter(state => sharedWebResourceKey(state.candidate) === key)
      .map(state => state.identity.revision));
    if (!confirmed.size || confirmed.size === 1 && members.every(id => confirmed.has(byId.get(id)!.revision))) continue;
    // A package/version owns one Web module revision. Its code upgrade cannot
    // leave another active instance rendering the previous package's resources.
    for (const id of members) { rebuilding.add(id); parent.set(root(id), root(members[0]!)); }
  }
  // Only existing consumers retain references that must move atomically with a
  // replaced provider. New sibling features must not join that rollback group.
  changed = true;
  while (changed) {
    changed = false;
    const ownsPrevious = new Set([...previous.keys()].filter(id => byId.has(id)).map(root));
    for (const candidate of byId.values()) {
      if (!rebuilding.has(candidate.instanceId) || plan.waiting.has(candidate.instanceId)
        || !ownsPrevious.has(root(candidate.instanceId))) continue;
      for (const capability of [...candidate.manifest.requires, ...candidate.manifest.optional]) {
        const provider = plan.providers.get(capability);
        if (!provider || !rebuilding.has(provider) || plan.waiting.has(provider)) continue;
        const consumerRoot = root(candidate.instanceId), providerRoot = root(provider);
        if (consumerRoot !== providerRoot) { parent.set(providerRoot, consumerRoot); changed = true; }
      }
    }
  }
  const activationPosition = new Map(plan.activationOrder.map((instanceId, index) => [instanceId, index]));
  const groups = new Map<string, string[]>();
  for (const id of byId.keys()) { const key = root(id); groups.set(key, [...(groups.get(key) ?? []), id]); }
  const components = [...groups.values()];
  for (const component of components) {
    component.sort((left, right) =>
      (activationPosition.get(left) ?? Number.MAX_SAFE_INTEGER) - (activationPosition.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    );
  }
  return Object.freeze({ rebuilding, components: Object.freeze(components.sort((left, right) => {
    const leftPosition = Math.min(...left.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    const rightPosition = Math.min(...right.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    return leftPosition - rightPosition || left[0]!.localeCompare(right[0]!);
  }).map(component => Object.freeze(component))) });
}

function contributionKey(contribution: Pick<PluginContribution, "kind" | "id">): string {
  return `${contribution.kind.trim()}\0${contribution.id.trim()}`;
}

async function cleanupStates(
  states: readonly ActivePluginState[],
  phase: PluginCleanupDiagnostic["phase"]
): Promise<readonly PluginCleanupDiagnostic[]> {
  const unique = [...new Map(states.map(state => [state.scope, state])).values()].reverse();
  const settled = await Promise.allSettled(unique.map(state => state.scope.dispose()));
  return Object.freeze(settled.flatMap((result, index) => result.status === "rejected"
    ? [Object.freeze({
        instanceId: unique[index]!.identity.instanceId,
        activationId: unique[index]!.identity.activationId,
        phase,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason)
      })]
    : []));
}

function buildGenerationSnapshots(
  states: Iterable<ActivePluginState>,
  hostServices: readonly HostService[],
  sequence: number
): Readonly<{ services: ServiceRegistrySnapshot; contributions: ContributionRegistrySnapshot }> {
  const services = new ServiceRegistryDraft(hostServices);
  const contributions = new ContributionRegistryDraft();
  for (const state of states) {
    for (const service of state.services) services.register(state.identity.instanceId, service.capability, service.value);
    for (const contribution of state.contributions) contributions.register(state.identity.instanceId, contribution);
  }
  return Object.freeze({ services: services.snapshot(sequence), contributions: contributions.snapshot(sequence) });
}

export class GenerationRuntime {
  readonly #host: PluginHost;
  readonly #hostServices: readonly HostService[];
  readonly #hostRegistrations: readonly PluginServiceRegistration[];
  readonly #applicationGenerationId: string;
  readonly #managerInstanceId: string;
  readonly #defaultReadyRequires: readonly string[];
  readonly #executor: PluginExecutor;
  readonly #activationTimeoutMs: number;
  readonly #onRuntimeFailure?: (event: PluginRuntimeFailureEvent) => void | Promise<void>;
  readonly #onPublished?: (generation: PluginGeneration) => void;
  #mutationTail: Promise<void> = Promise.resolve();
  #disposed = false;
  #intent = 0;
  #desired: readonly PluginCandidate[] = [];
  #desiredOptions: GenerationSwitchOptions = {};
  readonly #initializations = new Map<string, InitializationFlight>();
  readonly #ownedWork = new Set<OwnedWork>();
  #pumpFailure?: unknown;
  #disposal?: Promise<void>;
  #shutdown?: Promise<void>;
  #shutdownStates: readonly ActivePluginState[] = [];
  #sequence = 0;
  #current: PluginGeneration;
  #active = new Map<string, ActivePluginState>();
  readonly #unconfirmedRetirements = new Map<string, Set<ActivePluginState>>();

  constructor(options: GenerationRuntimeOptions) {
    this.#host = options.host;
    this.#hostServices = Object.freeze([...(options.hostServices ?? [])]);
    this.#hostRegistrations = Object.freeze(this.#hostServices.map(service => Object.freeze({
      capability: service.capability, providerInstanceId: "host", value: service.value
    })));
    this.#applicationGenerationId = options.applicationIdentity?.applicationGenerationId.trim() || randomUUID();
    this.#managerInstanceId = options.applicationIdentity?.managerInstanceId.trim() || randomUUID();
    this.#defaultReadyRequires = Object.freeze([...(options.readyRequires ?? [])].sort());
    this.#executor = options.executor ?? createBuiltinPluginExecutor();
    this.#activationTimeoutMs = Math.max(1, Math.floor(options.activationTimeoutMs ?? getTimeoutMs("backend.plugin-kernel.generationRuntime.owner.Math.floor.activationTimeoutMs", 30_000)));
    this.#onRuntimeFailure = options.onRuntimeFailure;
    this.#onPublished = options.onPublished;
    this.#current = Object.freeze({
      id: randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires: this.#defaultReadyRequires,
      readiness: Object.freeze({
        state: this.#defaultReadyRequires.length ? "degraded" : "ready",
        missingCapabilities: this.#defaultReadyRequires
      }),
      records: Object.freeze([]),
      services: new ServiceRegistryDraft(this.#hostServices).snapshot(0),
      contributions: new ContributionRegistryDraft().snapshot(0),
      cleanupDiagnostics: Object.freeze([])
    });
  }

  current(): PluginGeneration {
    return this.#current;
  }

  publishSourcePatch<T>(expectedGenerationId: string, operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      if (this.#disposed) throw new Error("Plugin GenerationRuntime is disposed.");
      if (this.#current.id !== expectedGenerationId) throw new Error("Source patch plugin generation is no longer active.");
      return operation();
    });
  }

  async switch(candidates: readonly PluginCandidate[], options: GenerationSwitchOptions = {}): Promise<GenerationSwitchResult> {
    // A failed activation may still be retiring after its failure notification.
    // Join only retrying instance owners, outside the global mutation queue.
    const retrying = candidates.filter(candidate => this.#current.records.some(record =>
      record.identity.instanceId === candidate.instanceId && record.status === "failed"));
    if (retrying.length) await Promise.all(retrying.map(candidate => this.#joinWork(candidate.instanceId)));
    const intent = ++this.#intent;
    const previousGenerationId = this.#current.id;
    await this.#enqueue(async () => {
      if (this.#disposed) throw new Error("Plugin GenerationRuntime is disposed.");
      this.#desired = Object.freeze([...candidates]);
      this.#desiredOptions = options;
      this.#pumpFailure = undefined;
      const wanted = new Map(candidates.map(candidate => [candidate.instanceId,
        candidateSignature(candidate, [...candidate.manifest.permissions].sort())]));
      for (const flight of [...this.#initializations.values()]) {
        if (flight.failure || flight.candidates.some((candidate, index) => wanted.get(candidate.instanceId) !== flight.signatures[index])) {
          this.#cancelInitialization(flight);
        }
      }
      await this.#switchNow(this.#desired, options);
    });
    if (options.initialization !== "background") {
      await this.#joinWork();
      if (this.#pumpFailure !== undefined) throw this.#pumpFailure;
      if (intent !== this.#intent) throw new Error("Plugin generation switch was superseded during initialization.");
    }
    return Object.freeze({ changed: previousGenerationId !== this.#current.id, generation: this.#current, previousGenerationId });
  }

  /** Physical owner projection only; removing services never means asynchronous stop already finished. */
  pendingRetirements(): readonly Readonly<{ identity: PluginIdentity; status: "stopping" | "retirement_unconfirmed" }>[] {
    const states = new Map([...this.#unconfirmedRetirements.values()].flatMap(owners => [...owners])
      .map(state => [state.scope, state] as const));
    return Object.freeze([...states.values()].filter(state => !state.scope.retirementConfirmed()).map(state => Object.freeze({
      identity: state.identity,
      status: this.#current.cleanupDiagnostics.some(diagnostic => diagnostic.activationId === state.identity.activationId && !diagnostic.lateConfirmed)
        ? "retirement_unconfirmed" as const : "stopping" as const
    })));
  }

  /** Join existing activation/retirement owners only; never starts or admits another plugin. */
  async #joinWork(instanceId?: string): Promise<void> {
    for (;;) {
      await this.#mutationTail;
      const work = [...this.#ownedWork].filter(item => !instanceId || item.instances.has(instanceId));
      if (!work.length) break;
      await Promise.allSettled(work.map(item => item.completion));
    }
  }

  async settle(instanceId?: string): Promise<PluginGeneration> {
    await this.#joinWork(instanceId);
    if (this.#pumpFailure !== undefined) throw this.#pumpFailure;
    const unconfirmed = [...this.#unconfirmedRetirements].flatMap(([id, states]) =>
      !instanceId || id === instanceId ? [...states].filter(state => !state.scope.retirementConfirmed()) : []);
    if (unconfirmed.length) throw new Error(`Plugin retirement is unconfirmed: ${unconfirmed.map(state => state.identity.instanceId).join(", ")}.`);
    return this.#current;
  }

  #trackWork(instances: readonly string[], completion: Promise<unknown>): void {
    const work = { instances: new Set(instances), completion };
    this.#ownedWork.add(work);
    void completion.then(() => this.#ownedWork.delete(work), () => this.#ownedWork.delete(work));
  }

  #cancelInitialization(flight: InitializationFlight): void {
    if (this.#initializations.get(flight.key) === flight) this.#initializations.delete(flight.key);
    flight.cancelled = true;
    for (const state of flight.ownedStates) {
      const owned = this.#unconfirmedRetirements.get(state.identity.instanceId) ?? new Set<ActivePluginState>();
      owned.add(state); this.#unconfirmedRetirements.set(state.identity.instanceId, owned);
    }
    for (const scope of flight.scopes) scope.abort(new Error("Plugin initialization was superseded or removed."));
    if (flight.settled && flight.prepared?.length) {
      void this.#scheduleRetirement(flight.prepared, "rollback");
    }
  }

  #scheduleRetirement(states: readonly ActivePluginState[], phase: PluginCleanupDiagnostic["phase"]): Promise<readonly PluginCleanupDiagnostic[]> {
    for (const state of states) {
      state.scope.abort(new Error("Plugin activation is retiring."));
      const owned = this.#unconfirmedRetirements.get(state.identity.instanceId) ?? new Set<ActivePluginState>();
      owned.add(state); this.#unconfirmedRetirements.set(state.identity.instanceId, owned);
    }
    const completion = this.#retireStates(states, phase).then(diagnostics => this.#enqueue(async () => {
      if (diagnostics.length) this.#current = Object.freeze({ ...this.#current,
        cleanupDiagnostics: Object.freeze([...this.#current.cleanupDiagnostics, ...diagnostics]) });
      return diagnostics;
    }));
    this.#trackWork(states.map(state => state.identity.instanceId), completion);
    return Promise.resolve([]);
  }

  #continueInitialization(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#disposed) return;
      try { await this.#switchNow(this.#desired, this.#desiredOptions); }
      catch (error) { this.#pumpFailure = error; }
    });
  }

  async #switchNow(candidates: readonly PluginCandidate[], options: GenerationSwitchOptions): Promise<GenerationSwitchResult> {
    if (this.#disposed) throw new Error("Plugin GenerationRuntime is disposed.");
    const reportMissingRequiredCapabilities = options.requiredCapabilityPolicy === "report";
    const readyRequires = Object.freeze([...(options.readyRequires ?? this.#defaultReadyRequires)].sort());
    const hostCapabilities = new Set(this.#hostServices.map(service => service.capability));
    const isolated = isolateCapabilityGraph(candidates, hostCapabilities,
      new Map([...this.#active].map(([id, state]) => [id, state.candidate])));
    const effectiveCandidates = isolated.candidates;
    const plan = isolated.plan;
    const byId = new Map(effectiveCandidates.map(candidate => [candidate.instanceId.trim(), candidate]));
    const identities = new Map<string, PluginIdentity>();
    const granted = new Map<string, readonly string[]>();
    const signatures = new Map<string, string>();
    for (const [instanceId, candidate] of byId) {
      const identity = pluginIdentity(
        candidate,
        this.#host,
        this.#applicationGenerationId,
        this.#managerInstanceId
      );
      const permissions = Object.freeze([...candidate.manifest.permissions].sort());
      identities.set(instanceId, identity);
      granted.set(instanceId, permissions);
      signatures.set(instanceId, candidateSignature(candidate, permissions));
    }

    const desiredIds = new Set(byId.keys());
    const unchanged = !(reportMissingRequiredCapabilities && this.#sequence === 0)
      && (reportMissingRequiredCapabilities || this.#current.readiness.missingCapabilities.length === 0) && !isolated.diagnostics.size && effectiveCandidates.length === this.#active.size
      && [...byId.keys()].every(instanceId => this.#active.get(instanceId)?.signature === signatures.get(instanceId))
      && this.#current.records.every(record => record.status === "active" && !record.error)
      && JSON.stringify(this.#current.readyRequires) === JSON.stringify(readyRequires);
    if (unchanged) {
      assertBeforePublish(options);
      return Object.freeze({ changed: false, generation: this.#current });
    }

    const previous = this.#current;
    const previousActive = this.#active;
    const nextActive = new Map<string, ActivePluginState>();
    const records: PluginRuntimeRecord[] = [];
    const claimedContributionKeys = new Set<string>();
    const scopesToDispose = new Set<EffectScope>();
    const preparedToCommit: ActivePluginState[] = [];
    const componentForInstance = new Map<string, readonly string[]>();
    const cleanupDiagnostics: PluginCleanupDiagnostic[] = [];

    const attempted: ActivePluginState[] = [];
    const rolledBack = new Set<ActivePluginState>();
    const rollbackStates = new Set<ActivePluginState>();
    const finalizers = new Map<ActivePluginState, () => void>();
    const publicationFailures: ComponentFailure[] = [];
    const rollbackFailures: unknown[] = [];
    const uncertainSeeds = new Set<string>();
    const uncertainOld = new Set<string>();
    const addComponent = (ids: Set<string>, id: string) => {
      for (const member of componentForInstance.get(id) ?? [id]) ids.add(member);
    };
    const expandUncertainOld = () => {
      for (const id of uncertainSeeds) if (previousActive.has(id)) uncertainOld.add(id);
      let changed = true;
      while (changed) {
        changed = false;
        const capabilities = new Set([...previousActive.values()].filter(state => uncertainOld.has(state.identity.instanceId))
          .flatMap(state => [...state.manifest.provides]));
        for (const old of previousActive.values()) {
          if (uncertainOld.has(old.identity.instanceId) || ![...old.manifest.requires, ...old.manifest.optional]
            .some(capability => capabilities.has(capability))) continue;
          uncertainOld.add(old.identity.instanceId); changed = true;
        }
      }
    };
    const rollbackAttempted = (ids: ReadonlySet<string>) => {
      for (const state of [...attempted].reverse()) {
        if (!ids.has(state.identity.instanceId) || rolledBack.has(state)) continue;
        rolledBack.add(state);
        try { runPluginActivation(state.identity, () => state.publication.rollback()); }
        catch (error) {
          state.scope.markRetirementUnconfirmed(error);
          rollbackFailures.push(error);
          addComponent(uncertainSeeds, state.identity.instanceId);
        }
      }
      expandUncertainOld();
    };
    const expandRollbackDomain = (ids: Set<string>) => {
      let changed = true;
      while (changed) {
        const size = ids.size;
        for (const id of [...ids]) addComponent(ids, id);
        const unavailable = new Set<PluginServiceRegistration>([
          ...preparedToCommit.filter(state => ids.has(state.identity.instanceId)).flatMap(state => [...state.services]),
          ...[...previousActive.values()].filter(state => uncertainOld.has(state.identity.instanceId)).flatMap(state => [...state.services])
        ]);
        const restored = [...ids].flatMap(id => {
          const old = previousActive.get(id);
          return old && !uncertainOld.has(id) ? [old] : [];
        });
        const capabilities = new Set(restored.flatMap(state => state.services.map(service => service.capability)));
        const contributions = new Set(restored.flatMap(state => state.contributions.map(contributionKey)));
        for (const state of preparedToCommit) {
          if (ids.has(state.identity.instanceId) || nextActive.get(state.identity.instanceId) !== state) continue;
          // Only concrete candidate bindings join the domain. Missing optional
          // services and references to surviving old providers do not join it.
          if ([...(state.boundServices ?? [])].some(service => unavailable.has(service))
            || state.services.some(service => capabilities.has(service.capability))
            || state.contributions.some(contribution => contributions.has(contributionKey(contribution)))) {
            addComponent(ids, state.identity.instanceId);
          }
        }
        changed = ids.size !== size;
      }
    };
    const restoreFailedDomain = (failedInstanceId: string, error: unknown, code = "activation_failed") => {
      const ids = new Set<string>();
      addComponent(ids, failedInstanceId);
      for (const flight of this.#initializations.values()) if (flight.candidates.some(candidate => ids.has(candidate.instanceId))) {
        flight.failure = { instanceId: failedInstanceId, error };
      }
      let size = -1;
      while (size !== ids.size) {
        expandRollbackDomain(ids); size = ids.size;
        rollbackAttempted(ids);
        // A rollback fault can taint old references in additional prepared groups.
        expandRollbackDomain(ids);
      }
      const invalidation = new AggregateError([error, ...rollbackFailures], "Plugin publication rollback is unconfirmed.");
      for (const id of uncertainSeeds) previousActive.get(id)?.scope.markRetirementUnconfirmed(invalidation);
      for (const state of preparedToCommit) if (ids.has(state.identity.instanceId)) rollbackStates.add(state);
      for (let index = records.length - 1; index >= 0; index--) {
        const id = records[index]!.identity.instanceId;
        if (ids.has(id) || uncertainOld.has(id) && nextActive.get(id) === previousActive.get(id)) records.splice(index, 1);
      }
      for (const id of ids) {
        nextActive.delete(id);
        const old = previousActive.get(id);
        if (old && !uncertainOld.has(id)) {
          nextActive.set(id, old); scopesToDispose.delete(old.scope);
          records.push(activeRecord(old, error));
        } else {
          const identity = old?.identity ?? identities.get(id)!;
          const manifest = old?.manifest ?? byId.get(id)!.manifest;
          const uncertain = uncertainOld.has(id) || uncertainSeeds.has(id);
          records.push(failedRecord(identity, manifest, uncertain ? invalidation : error,
            uncertain ? "publication_rollback_unconfirmed" : code));
          if (old) scopesToDispose.add(old.scope);
        }
      }
      for (const id of uncertainOld) {
        const old = previousActive.get(id)!;
        if (ids.has(id) || nextActive.get(id) !== old) continue;
        nextActive.delete(id); scopesToDispose.add(old.scope);
        records.push(failedRecord(old.identity, old.manifest, invalidation, "publication_rollback_unconfirmed"));
      }
      claimedContributionKeys.clear();
      for (const state of nextActive.values()) for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
    };
    const retireRolledBack = async () => {
      const states = [...rollbackStates]; rollbackStates.clear();
      return this.#scheduleRetirement(states, "rollback");
    };

    const activationPlan = dependencyComponents(effectiveCandidates, plan, previousActive, signatures);
    for (const component of activationPlan.components) {
      for (const instanceId of component) componentForInstance.set(instanceId, component);
      const waiting = component.filter(instanceId => plan.waiting.has(instanceId));
      if (waiting.length) {
        const retainedResourceGroup = component.length > 1 && component.some(instanceId => previousActive.has(instanceId));
        const dependencyFailure = new Error(`Shared resource update cannot activate while dependencies are unavailable: ${waiting.join(", ")}.`);
        for (const instanceId of component) {
          const candidate = byId.get(instanceId)!;
          const old = previousActive.get(instanceId);
          if (retainedResourceGroup && old) {
            nextActive.set(instanceId, old);
            records.push(activeRecord(old, dependencyFailure));
            for (const contribution of old.contributions) claimedContributionKeys.add(contributionKey(contribution));
            continue;
          }
          if (retainedResourceGroup && !plan.waiting.has(instanceId)) {
            records.push(failedRecord(identities.get(instanceId)!, candidate.manifest, dependencyFailure));
            continue;
          }
          records.push(waitingRecord(identities.get(instanceId)!, candidate.manifest, plan.waiting.get(instanceId) ?? []));
          if (old) scopesToDispose.add(old.scope);
        }
        continue;
      }

      const componentUnchanged = component.every(instanceId =>
        previousActive.get(instanceId)?.signature === signatures.get(instanceId) && !activationPlan.rebuilding.has(instanceId)
      );
      if (componentUnchanged) {
        for (const instanceId of component) {
          const state = previousActive.get(instanceId)!;
          nextActive.set(instanceId, state);
          records.push(activeRecord(state));
          for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
        }
        continue;
      }

      const serviceValues = new Map<string, PluginServiceRegistration>();
      for (const service of this.#hostRegistrations) serviceValues.set(service.capability, service);
      for (const state of previousActive.values()) {
        if (!byId.has(state.identity.instanceId) || activationPlan.rebuilding.has(state.identity.instanceId)
          || plan.waiting.has(state.identity.instanceId)) continue;
        for (const service of state.services) serviceValues.set(service.capability, service);
      }
      for (const state of nextActive.values()) {
        for (const service of state.services) serviceValues.set(service.capability, service);
      }
      const componentProvides = new Set(component.flatMap(id => [...byId.get(id)!.manifest.provides]));
      const optionalInitializing = component.some(id => byId.get(id)!.manifest.optional.some(capability =>
        !componentProvides.has(capability) && !serviceValues.has(capability)
        && [...this.#initializations.values()].some(flight => !flight.failure && flight.candidates.some(candidate =>
          candidate.manifest.provides.includes(capability) && plan.dependents.get(candidate.instanceId)?.includes(id)))));
      if (optionalInitializing) {
        for (const instanceId of component) {
          const old = previousActive.get(instanceId);
          if (old) { nextActive.set(instanceId, old); records.push(activeRecord(old)); }
          else records.push(Object.freeze({ identity: identities.get(instanceId)!, manifest: byId.get(instanceId)!.manifest,
            status: "initializing" as const, missingCapabilities: Object.freeze([]) }));
        }
        continue;
      }
      const unavailable = component.flatMap(id => byId.get(id)!.manifest.requires
        .filter(capability => !componentProvides.has(capability) && !serviceValues.has(capability)));
      if (unavailable.length) {
        for (const instanceId of component) {
          records.push(waitingRecord(identities.get(instanceId)!, byId.get(instanceId)!.manifest, unavailable));
          const old = previousActive.get(instanceId);
          if (old) scopesToDispose.add(old.scope);
        }
        continue;
      }
      const key = [...component].sort().join("\0");
      const externalServices = new Map(component.flatMap(id => [...byId.get(id)!.manifest.requires, ...byId.get(id)!.manifest.optional])
        .filter(capability => !componentProvides.has(capability)).map(capability => [capability, serviceValues.get(capability)] as const));
      let flight = this.#initializations.get(key);
      if (flight && (flight.candidates.some((candidate, index) => signatures.get(candidate.instanceId) !== flight!.signatures[index])
        || [...externalServices].some(([capability, service]) => flight!.externalServices.get(capability) !== service))) {
        this.#cancelInitialization(flight); flight = undefined;
      }
      if (!flight) {
        flight = { key, candidates: component.map(id => byId.get(id)!), signatures: component.map(id => signatures.get(id)!),
          identities: component.map(id => identities.get(id)!), externalServices, scopes: new Set(), ownedStates: [], cancelled: false, settled: false };
        this.#initializations.set(key, flight);
        const owner = flight;
        const reservedContributionKeys = new Set(claimedContributionKeys);
        const completion = Promise.resolve().then(async () => {
          const prepared: ActivePluginState[] = [];
          let failure: ComponentFailure | undefined;

          try {
            for (const instanceId of component) {
              if (owner.cancelled) throw new Error("Plugin initialization was removed.");
              const candidate = byId.get(instanceId)!;
              const identity = identities.get(instanceId)!;
              const permissions = new GrantedPermissions(candidate.manifest.permissions, granted.get(instanceId)!);
              const declaredProvides = new Set(candidate.manifest.provides);
              const provided = new Set<string>();
              const pluginServices: PluginServiceRegistration[] = [];
              const boundServices = new Set<PluginServiceRegistration>();
              const pluginContributions: RegisteredPluginContribution[] = [];
              const componentContributionKeys = new Set(prepared.flatMap(state => state.contributions.map(contributionKey)));
              const scope = new EffectScope({
                disposalTimeoutMs: getTimeoutMs("plugin.disposal", candidate.policy?.resources.shutdownTimeoutMs ?? 5000),
                operationTimeoutMs: this.#activationTimeoutMs
              });
              owner.scopes.add(scope);
              if (owner.cancelled) scope.abort(new Error("Plugin initialization was removed."));
              const publication = new PublicationScope(scope);
              owner.ownedStates.push(Object.freeze({ candidate, identity, manifest: candidate.manifest,
                signature: signatures.get(instanceId)!, scope, publication, services: pluginServices, contributions: pluginContributions }));
              const context: PluginContext = Object.freeze({
                identity,
                config: candidate.config,
                services: Object.freeze({
                  require<T>(capability: string): T {
                    scope.signal().throwIfAborted();
                    if (!candidate.manifest.requires.includes(capability) && !candidate.manifest.optional.includes(capability)) {
                      throw new Error(`Plugin did not declare required capability: ${capability}.`);
                    }
                    const service = serviceValues.get(capability.trim());
                    if (!service) throw new Error(`Required plugin service is unavailable: ${capability.trim()}.`);
                    boundServices.add(service);
                    return service.value as T;
                  },
                  optional<T>(capability: string): T | undefined {
                    scope.signal().throwIfAborted();
                    if (!candidate.manifest.optional.includes(capability) && !candidate.manifest.requires.includes(capability)) {
                      throw new Error(`Plugin did not declare optional capability: ${capability}.`);
                    }
                    const service = serviceValues.get(capability.trim());
                    if (service) boundServices.add(service);
                    return service?.value as T | undefined;
                  },
                  provide<T>(capability: string, value: T): void {
                    scope.signal().throwIfAborted();
                    if (!declaredProvides.has(capability)) throw new Error(`Plugin did not declare provided capability: ${capability}.`);
                    if (provided.has(capability)) throw new Error(`Plugin provided a capability more than once: ${capability}.`);
                    if (serviceValues.has(capability)) throw new Error(`Plugin service capability is already registered: ${capability}.`);
                    const registration = Object.freeze({ capability, providerInstanceId: instanceId, value });
                    serviceValues.set(capability, registration);
                    pluginServices.push(registration);
                    provided.add(capability);
                  }
                }),
                contributions: Object.freeze({
                  register(contribution: PluginContribution): void {
                    scope.signal().throwIfAborted();
                    const kind = contribution.kind.trim();
                    const id = contribution.id.trim();
                    if (!kind || !id) throw new Error("Plugin contribution kind and id are required.");
                    const key = contributionKey({ kind, id });
                    if (reservedContributionKeys.has(key) || componentContributionKeys.has(key)) {
                      throw new Error(`Plugin contribution is already registered: ${kind}/${id}.`);
                    }
                    componentContributionKeys.add(key);
                    pluginContributions.push(Object.freeze({ instanceId, kind, id, value: contribution.value }));
                  }
                }),
                permissions,
                lifecycle: Object.freeze({
                  signal: scope.signal(),
                  fail: (error: unknown) => {
                    scope.abort(error);
                    void this.#enqueue(() => this.#handleRuntimeFailure(identity, error));
                  }
                }),
                publication: Object.freeze({
                  add: publication.add.bind(publication)
                }),
                effects: Object.freeze({
                  add: (starter: PluginEffectStarter, label?: string) => scope.add(starter, label),
                  adopt: (disposer: PluginEffectDisposer, label?: string) => scope.adopt(disposer, label)
                })
              });

              try {
                this.#assertRetirementConfirmed(instanceId);
                const module = await scope.run("preparation", () => this.#executor.prepare(candidate, identity));
                await scope.run("activation", () => module.activate(context));
                const missingProvides = [...declaredProvides].filter(capability => !provided.has(capability));
                if (missingProvides.length) throw new Error(`Plugin did not provide declared capabilities: ${missingProvides.join(", ")}.`);
                prepared.push(Object.freeze({
                  candidate,
                  identity,
                  manifest: candidate.manifest,
                  signature: signatures.get(instanceId)!,
                  scope,
                  publication,
                  services: Object.freeze(pluginServices),
                  boundServices,
                  contributions: Object.freeze(pluginContributions)
                }));
              } catch (error) {
                cleanupDiagnostics.push(...await this.#retireStates([Object.freeze({ candidate, identity, manifest: candidate.manifest,
                  signature: signatures.get(instanceId)!, scope, publication,
                  services: Object.freeze(pluginServices), contributions: Object.freeze(pluginContributions)
                })], "rollback"));
                throw Object.freeze({ instanceId, error }) satisfies ComponentFailure;
              }
            }
            for (const state of prepared) await runPluginActivation(state.identity, () => state.scope.commit());

          } catch (error) {
            failure = error && typeof error === "object" && "instanceId" in error && "error" in error
              ? error as ComponentFailure
              : Object.freeze({ instanceId: component[0]!, error });
          }


          owner.prepared = prepared; owner.failure = failure; owner.settled = true;
          if (owner.cancelled || this.#initializations.get(key) !== owner || this.#disposed) {
            const diagnostics = await this.#retireStates(prepared, "rollback");
            if (diagnostics.length) await this.#enqueue(async () => {
              this.#current = Object.freeze({ ...this.#current, cleanupDiagnostics: Object.freeze([...this.#current.cleanupDiagnostics, ...diagnostics]) });
            });
            return;
          }
          await this.#continueInitialization();
        });
        this.#trackWork(component, completion);
      }
      if (!flight.settled) {
        for (const instanceId of component) {
          const old = previousActive.get(instanceId);
          const initialization = Object.freeze({ state: "initializing" as const, identity: flight.identities[component.indexOf(instanceId)]! });
          if (old) {
            nextActive.set(instanceId, old); records.push(Object.freeze({ ...activeRecord(old), initialization }));
            for (const contribution of old.contributions) claimedContributionKeys.add(contributionKey(contribution));
          } else records.push(Object.freeze({ identity: initialization.identity, manifest: byId.get(instanceId)!.manifest,
            status: "initializing" as const, missingCapabilities: Object.freeze([]), initialization }));
        }
        continue;
      }
      const prepared = [...(flight.prepared ?? [])];
      let failure = flight.failure;
      if (!failure) {
        // Independent initialization can finish after another component published.
        // Recheck the original unique-contribution contract at consumption, not only its earlier snapshot.
        const claimed = new Set(claimedContributionKeys);
        for (const state of prepared) {
          for (const contribution of state.contributions) {
            const key = contributionKey(contribution);
            if (claimed.has(key)) {
              failure = { instanceId: state.identity.instanceId,
                error: new Error(`Plugin contribution is already registered: ${contribution.kind}/${contribution.id}.`) };
              break;
            }
            claimed.add(key);
          }
          if (failure) break;
        }
      }
      preparedToCommit.push(...prepared);
      if (!failure) {
        // The service facade retains this map after activation, including lazy
        // reads of declared optional services. Record the actual bound objects,
        // not only capabilities already read by the activation callback.
        for (const state of prepared) for (const capability of [...state.manifest.requires, ...state.manifest.optional]) {
          const service = serviceValues.get(capability.trim());
          if (service) state.boundServices?.add(service);
        }
        for (const state of prepared) {
          nextActive.set(state.identity.instanceId, state);
          records.push(activeRecord(state));
          for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
          const old = previousActive.get(state.identity.instanceId);
          if (old && old.scope !== state.scope) scopesToDispose.add(old.scope);
        }
        continue;
      }

      restoreFailedDomain(failure.instanceId, failure.error);
      cleanupDiagnostics.push(...await retireRolledBack());
    }

    for (const [instanceId, state] of previousActive) {
      if (!desiredIds.has(instanceId) || !nextActive.has(instanceId)) scopesToDispose.add(state.scope);
    }

    const initializing = records.some(record => record.status === "initializing" || record.initialization?.state === "initializing")
      || [...this.#initializations.values()].some(flight => !flight.settled);
    const activeChanged = nextActive.size !== previousActive.size
      || [...nextActive].some(([id, state]) => previousActive.get(id) !== state);
    if (initializing && (options.initialization !== "background" || !activeChanged)) {
      // Initialization visibility does not publish native pointers or consume the source fence.
      if (options.initialization === "background") this.#current = Object.freeze({ ...this.#current,
        records: Object.freeze([...records].sort((a, b) => a.identity.instanceId.localeCompare(b.identity.instanceId))) });
      return Object.freeze({ changed: false, generation: this.#current });
    }
    const sequence = this.#sequence + 1;
    try {
      buildGenerationSnapshots(nextActive.values(), this.#hostServices, sequence);
    } catch (error) {
      await this.#scheduleRetirement(preparedToCommit, "rollback");
      throw error;
    }

    // Rebuild after any component rollback. Validation and effect commits both
    // finish before the single generation pointer below becomes observable.
    const committedSnapshots = buildGenerationSnapshots(nextActive.values(), this.#hostServices, sequence);
    const serviceSnapshot = committedSnapshots.services;
    const contributionSnapshot = committedSnapshots.contributions;
    for (const [id, diagnostic] of isolated.diagnostics) {
      const index = records.findIndex(record => record.identity.instanceId === id);
      if (index >= 0 && records[index]!.status === "active") {
        records[index] = Object.freeze({ ...records[index]!, error: errorSummary(diagnostic.error,
          diagnostic.rejected ? "update_failed_using_previous_revision" : "optional_dependency_order_skipped") });
      } else if (index < 0) {
        records.push(failedRecord(pluginIdentity(diagnostic.candidate, this.#host,
          this.#applicationGenerationId, this.#managerInstanceId), diagnostic.candidate.manifest, diagnostic.error, "invalid_dependency_graph"));
      }
    }
    const missingReadyCapabilities = readyRequires.filter(capability => !serviceSnapshot.services.has(capability));
    if (missingReadyCapabilities.length && !reportMissingRequiredCapabilities) {
      if (initializing) {
        return Object.freeze({ changed: false, generation: this.#current });
      }
      const error = new RequiredPluginCapabilitiesUnavailableError(Object.freeze(missingReadyCapabilities), Object.freeze([...records]));
      for (const flight of this.#initializations.values()) if (flight.prepared?.some(state => preparedToCommit.includes(state))) {
        flight.failure = { instanceId: flight.candidates[0]!.instanceId, error };
      }
      await this.#scheduleRetirement(preparedToCommit, "rollback");
      throw error;
    }
    const hasDegradedPlugins = missingReadyCapabilities.length > 0 || records.some(record => record.status !== "active" || Boolean(record.error));
    let generation: PluginGeneration = Object.freeze({
      id: randomUUID(),
      sequence,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires,
      readiness: Object.freeze({
        state: hasDegradedPlugins ? "degraded" : "ready",
        missingCapabilities: Object.freeze(missingReadyCapabilities)
      }),
      records: Object.freeze([...records].sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId))),
      services: serviceSnapshot,
      contributions: contributionSnapshot,
      cleanupDiagnostics: Object.freeze([...cleanupDiagnostics])
    });

    // No await or external observer is allowed between reversible pointer
    // publication and the services/contributions generation pointer.
    const publicationCandidates = preparedToCommit.filter(state => nextActive.get(state.identity.instanceId) === state);
    try {
      assertBeforePublish(options);
      for (const state of publicationCandidates) {
        if (nextActive.get(state.identity.instanceId) !== state) continue;
        attempted.push(state);
        try { runPluginActivation(state.identity, () => state.publication.publish()); }
        catch (error) {
          publicationFailures.push({ instanceId: state.identity.instanceId, error });
          restoreFailedDomain(state.identity.instanceId, error, "publication_failed");
        }
      }
      for (const state of publicationCandidates) {
        if (nextActive.get(state.identity.instanceId) !== state) continue;
        try { finalizers.set(state, state.publication.seal()); }
        catch (error) {
          publicationFailures.push({ instanceId: state.identity.instanceId, error });
          restoreFailedDomain(state.identity.instanceId, error, "publication_failed");
        }
      }
      const snapshots = buildGenerationSnapshots(nextActive.values(), this.#hostServices, sequence);
      const missing = readyRequires.filter(capability => !snapshots.services.services.has(capability));
      if (missing.length && !reportMissingRequiredCapabilities) throw new RequiredPluginCapabilitiesUnavailableError(Object.freeze(missing), Object.freeze([...records]));
      const progress = preparedToCommit.some(state => nextActive.get(state.identity.instanceId) === state)
        || [...previousActive.keys()].some(id => !desiredIds.has(id));
      if (publicationFailures.length && !progress) throw publicationFailures[0]!.error;
      generation = Object.freeze({ ...generation, services: snapshots.services, contributions: snapshots.contributions,
        records: Object.freeze([...records].sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId))),
        readiness: Object.freeze({ state: missing.length > 0 || records.some(record => record.status !== "active" || record.error) ? "degraded" : "ready",
          missingCapabilities: Object.freeze(missing) }) });
    } catch (error) {
      // A source/required-capability fence remains global. Restore every other
      // native pointer before the first admission invalidation or cleanup await.
      rollbackAttempted(new Set(preparedToCommit.map(state => state.identity.instanceId)));
      for (const flight of this.#initializations.values()) if (flight.prepared?.some(state => preparedToCommit.includes(state))) {
        flight.failure = { instanceId: flight.candidates[0]!.instanceId, error };
      }
      const failures: unknown[] = [error, ...rollbackFailures];
      const uncertainActive = [...uncertainOld].flatMap(id => {
        const old = previousActive.get(id);
        return old ? [old] : [];
      });
      if (uncertainActive.length) {
        const invalidation = new AggregateError(failures, "Plugin publication rollback is unconfirmed.");
        for (const old of uncertainActive) if (uncertainSeeds.has(old.identity.instanceId)) old.scope.markRetirementUnconfirmed(invalidation);
        // Revoke the entire affected admission snapshot before the first cleanup
        // await. A retained revision is not proof that its public pointers recovered.
        await this.#handleRuntimeFailure(uncertainActive[0]!.identity, invalidation,
          uncertainActive.map(state => state.identity.instanceId));
      }
      const diagnostics = await this.#scheduleRetirement(preparedToCommit, "rollback");
      failures.push(...diagnostics.map(item => new Error(item.message)));
      if (failures.length > 1) throw new AggregateError(failures, "Plugin publication failed; rollback or cleanup also failed.");
      throw error;
    }
    const publishing = preparedToCommit.filter(state => nextActive.get(state.identity.instanceId) === state);
    const starting = new Map(publishing.map(state => [state.identity.activationId, state.identity]));
    generation = Object.freeze({ ...generation, records: Object.freeze(generation.records.map(record =>
      starting.has(record.identity.activationId) ? Object.freeze({ ...record,
        initialization: Object.freeze({ state: "initializing" as const, identity: record.identity }) }) : record)) });
    for (const state of publishing) finalizers.get(state)!();
    this.#sequence = sequence;
    this.#active = nextActive;
    this.#current = generation;
    for (const flight of [...this.#initializations.values()]) {
      if (flight.prepared?.some(state => nextActive.get(state.identity.instanceId) === state)) this.#initializations.delete(flight.key);
    }
    this.#notifyPublished(generation);
    const rollbackRetirement = retireRolledBack();
    const retainedScopes = new Set([...nextActive.values()].map(state => state.scope));
    const supersededStates = [...previousActive.values()].filter(state =>
      scopesToDispose.has(state.scope) && !retainedScopes.has(state.scope)
    );
    // Start all retirements before post-publication startup. A timeout is a
    // rejected join, never evidence that the previous owner has stopped.
    const retirements = new Map([...supersededStates].reverse().map(state => {
      const retirement = this.#retireStates([state], "superseded");
      return [state.identity.instanceId, retirement] as const;
    }));
    const startups = publishing.map(async state => {
      const retirement = retirements.get(state.identity.instanceId);
      const previousRetirement = retirement ? retirement.then(diagnostics => {
        if (diagnostics.length) throw new AggregateError(diagnostics.map(item => new Error(item.message)),
          `Previous plugin activation did not retire: ${state.identity.instanceId}.`);
      }) : Promise.resolve();
      const retirementBarrier = previousRetirement.then(() => {
        this.#assertRetirementConfirmed(state.identity.instanceId);
      });
      // Optional barrier: plugins without an exclusive worker need not wait for
      // old request/stream drain. Always observe rejection even if unused.
      void retirementBarrier.catch(() => {});
      try {
        await runPluginActivation(state.identity, () => state.scope.run("post-publication startup", () => state.publication.afterPublish(retirementBarrier)));
      } catch (error) {
        return { identity: state.identity, error };
      }
      return undefined;
    });
    const finishing = Promise.all(startups).then(async failures => {
      const startupFailures = failures.filter(item => item !== undefined);
      const diagnostics = [...await rollbackRetirement, ...(await Promise.all(retirements.values())).flat()];
      await this.#enqueue(async () => {
        for (const failure of startupFailures) await this.#handleRuntimeFailure(failure!.identity, failure!.error);
        if (diagnostics.length) this.#current = Object.freeze({ ...this.#current,
          cleanupDiagnostics: Object.freeze([...this.#current.cleanupDiagnostics, ...diagnostics]) });
        const readyRecords = this.#current.records.map(record => {
          if (!starting.has(record.identity.activationId) || record.status !== "active" || !record.initialization) return record;
          const { initialization: _initialization, ...ready } = record;
          return Object.freeze(ready);
        });
        if (readyRecords.some((record, index) => record !== this.#current.records[index])) {
          this.#current = Object.freeze({ ...this.#current, records: Object.freeze(readyRecords) });
        }
      });
    });
    this.#trackWork([...publishing, ...supersededStates].map(state => state.identity.instanceId), finishing);
    return Object.freeze({ changed: true, generation: this.#current, previousGenerationId: previous.id });
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    for (const flight of [...this.#initializations.values()]) this.#cancelInitialization(flight);
    return this.#disposal = this.#enqueue(() => this.#disposeNow()).then(async () => {
      await Promise.allSettled([...this.#ownedWork].map(item => item.completion));
      const unconfirmed = [...this.#unconfirmedRetirements.values()].flatMap(states => [...states].filter(state => !state.scope.retirementConfirmed()));
      if (unconfirmed.length) throw new Error(`Plugin retirement is unconfirmed: ${unconfirmed.map(state => state.identity.instanceId).join(", ")}.`);
    });
  }

  /** Application teardown only: ordinary publications and disposal never wait for this grace. */
  shutdown(options: Readonly<{ timeoutMs?: number }> = {}): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    const timeoutMs = options.timeoutMs ?? getTimeoutMs("backend.plugin-kernel.generationRuntime.DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS", DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError("Plugin shutdown timeout must be a positive safe integer."));
    return this.#shutdown = this.#shutdownNow(timeoutMs);
  }

  async #shutdownNow(timeoutMs: number): Promise<void> {
    const deadlineAt = performance.now() + timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const join = async () => {
      // Keep ordinary bounded disposal and its diagnostics. A timeout alone is
      // recoverable here only when every actual owner later confirms retirement.
      await this.dispose().catch(() => {});
      this.#shutdownStates = Object.freeze([...new Map([...this.#shutdownStates,
        ...[...this.#unconfirmedRetirements.values()].flatMap(states => [...states])].map(state => [state.scope, state])).values()]);
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) throw new Error(`Plugin shutdown retirement confirmation timed out after ${timeoutMs}ms.`);
      const settled = await Promise.allSettled(this.#shutdownStates.map(state =>
        state.scope.waitForRetirement({ timeoutMs: Math.max(1, Math.ceil(remaining)) })
      ));
      const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (performance.now() >= deadlineAt) throw new Error(`Plugin shutdown retirement confirmation timed out after ${timeoutMs}ms.`);
      if (failures.length || this.#shutdownStates.some(state => !state.scope.retirementConfirmed())) {
        throw new AggregateError(failures, "Plugin shutdown retirement remains unconfirmed.");
      }
      const confirmedStates = [...this.#shutdownStates,
        ...[...this.#unconfirmedRetirements.values()].flatMap(states => [...states])];
      const confirmedIds = new Set(confirmedStates.filter(state => state.scope.retirementConfirmed()).map(state => state.identity.activationId));
      this.#current = Object.freeze({ ...this.#current,
        cleanupDiagnostics: Object.freeze(this.#current.cleanupDiagnostics.map(diagnostic =>
          confirmedIds.has(diagnostic.activationId) ? Object.freeze({ ...diagnostic, lateConfirmed: true as const }) : diagnostic
        )) });
    };
    try {
      await Promise.race([join(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Plugin shutdown retirement confirmation timed out after ${timeoutMs}ms.`)), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #handleRuntimeFailure(identity: PluginIdentity, error: unknown, uncertainInstances: readonly string[] = []): Promise<void> {
    if (this.#disposed) return;
    const failedState = this.#active.get(identity.instanceId);
    if (!failedState || failedState.identity.activationId !== identity.activationId) return;

    const uncertain = new Set(uncertainInstances);
    const removed = new Set<string>([identity.instanceId, ...uncertain]);
    let changed = true;
    while (changed) {
      changed = false;
      const removedCapabilities = new Set([...this.#active.values()]
        .filter(state => removed.has(state.identity.instanceId))
        .flatMap(state => [...state.manifest.provides]));
      for (const state of this.#active.values()) {
        if (removed.has(state.identity.instanceId)) continue;
        if ([...state.manifest.requires, ...(uncertain.size ? state.manifest.optional : [])]
          .some(capability => removedCapabilities.has(capability))) {
          removed.add(state.identity.instanceId);
          changed = true;
        }
      }
    }

    const previous = this.#current;
    const removedStates = [...this.#active.values()].filter(state => removed.has(state.identity.instanceId));
    const remaining = new Map([...this.#active.entries()].filter(([instanceId]) => !removed.has(instanceId)));
    this.#active = remaining;
    const sequence = this.#sequence + 1;
    const serviceRegistry = new ServiceRegistryDraft(this.#hostServices);
    const contributionRegistry = new ContributionRegistryDraft();
    for (const state of remaining.values()) {
      for (const service of state.services) serviceRegistry.register(state.identity.instanceId, service.capability, service.value);
      for (const contribution of state.contributions) contributionRegistry.register(state.identity.instanceId, contribution);
    }
    const serviceSnapshot = serviceRegistry.snapshot(sequence);
    const available = new Set(serviceSnapshot.services.keys());
    const records = [
      ...[...remaining.values()].map(state => activeRecord(state)),
      ...previous.records.filter(record =>
        !remaining.has(record.identity.instanceId) && !removed.has(record.identity.instanceId)
      ),
      ...removedStates.map(state => uncertain.has(state.identity.instanceId) || state.identity.instanceId === identity.instanceId
        ? failedRecord(state.identity, state.manifest, error, uncertain.has(state.identity.instanceId) ? "publication_rollback_unconfirmed" : "runtime_failed")
        : waitingRecord(
          state.identity,
          state.manifest,
          [...state.manifest.requires, ...(uncertain.size ? state.manifest.optional : [])]
            .filter(capability => !available.has(capability))
        ))
    ].sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId));
    const missingReadyCapabilities = previous.readyRequires.filter(capability => !available.has(capability));
    const hasDegradedPlugins = records.some(record => record.status !== "active" || Boolean(record.error));
    const generation: PluginGeneration = Object.freeze({
      id: randomUUID(),
      sequence,
      createdAt: new Date().toISOString(),
      host: this.#host,
      applicationGenerationId: this.#applicationGenerationId,
      managerInstanceId: this.#managerInstanceId,
      readyRequires: previous.readyRequires,
      readiness: Object.freeze({
        state: missingReadyCapabilities.length || hasDegradedPlugins ? "degraded" : "ready",
        missingCapabilities: Object.freeze(missingReadyCapabilities)
      }),
      records: Object.freeze(records),
      services: serviceSnapshot,
      contributions: contributionRegistry.snapshot(sequence),
      cleanupDiagnostics: previous.cleanupDiagnostics
    });
    this.#sequence = sequence;
    this.#current = generation;
    this.#notifyPublished(generation);
    const summary = errorSummary(error, "runtime_failed") as Readonly<{ code: "runtime_failed"; message: string }>;
    try {
      void Promise.resolve(this.#onRuntimeFailure?.(Object.freeze({ identity, error: summary, generation }))).catch(() => {});
    } catch {
      // Health invalidation is observational, but it must be attempted before cleanup can block.
    }
    const cleanupDiagnostics = await this.#scheduleRetirement(removedStates, "runtime_failure");
    const published = cleanupDiagnostics.length
      ? Object.freeze({ ...generation, cleanupDiagnostics })
      : generation;
    this.#current = published;
  }

  async #disposeNow(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // A queued switch can create its flight after dispose() was called but before this turn entered.
    for (const flight of [...this.#initializations.values()]) this.#cancelInitialization(flight);
    const active = this.#active;
    this.#active = new Map();
    // Removed and failed activations can still own native work after bounded
    // disposal timed out. An empty active graph is not a completed shutdown.
    const unconfirmed = [...this.#unconfirmedRetirements.values()].flatMap(states =>
      [...states].filter(state => !state.scope.retirementConfirmed())
    );
    this.#shutdownStates = Object.freeze([...new Map([...active.values(), ...unconfirmed].map(state => [state.scope, state])).values()]);
    const cleanupDiagnostics = await this.#retireStates(this.#shutdownStates, "shutdown");
    if (cleanupDiagnostics.length) {
      this.#current = Object.freeze({
        ...this.#current,
        cleanupDiagnostics: Object.freeze([...this.#current.cleanupDiagnostics, ...cleanupDiagnostics])
      });
      throw new AggregateError(cleanupDiagnostics.map(item => new Error(item.message)), "Plugin cleanup failed during shutdown.");
    }
  }

  async #retireStates(states: readonly ActivePluginState[], phase: PluginCleanupDiagnostic["phase"]): Promise<readonly PluginCleanupDiagnostic[]> {
    for (const state of states) {
      const owned = this.#unconfirmedRetirements.get(state.identity.instanceId) ?? new Set<ActivePluginState>();
      owned.add(state); this.#unconfirmedRetirements.set(state.identity.instanceId, owned);
    }
    const diagnostics = await cleanupStates(states, phase);
    const confirmedIds = new Set<string>();
    for (const state of states) {
      if (state.scope.retirementConfirmed()) {
        confirmedIds.add(state.identity.activationId);
        const owned = this.#unconfirmedRetirements.get(state.identity.instanceId);
        // Keep a prior timeout's proof until the original admission fence records late confirmation.
        if (owned && !this.#current.cleanupDiagnostics.some(diagnostic => diagnostic.activationId === state.identity.activationId && !diagnostic.lateConfirmed)) {
          for (const previous of owned) if (previous.scope === state.scope) owned.delete(previous);
          if (!owned.size) this.#unconfirmedRetirements.delete(state.identity.instanceId);
        }
        continue;
      }
      const unconfirmed = this.#unconfirmedRetirements.get(state.identity.instanceId) ?? new Set<ActivePluginState>();
      unconfirmed.add(state);
      this.#unconfirmedRetirements.set(state.identity.instanceId, unconfirmed);
    }
    return Object.freeze(diagnostics.map(diagnostic => confirmedIds.has(diagnostic.activationId)
      ? Object.freeze({ ...diagnostic, lateConfirmed: true as const }) : diagnostic));
  }

  #assertRetirementConfirmed(instanceId: string): void {
    const unconfirmed = this.#unconfirmedRetirements.get(instanceId);
    if (!unconfirmed) return;
    const confirmedIds = new Set<string>();
    for (const state of unconfirmed) if (state.scope.retirementConfirmed()) {
      confirmedIds.add(state.identity.activationId);
      unconfirmed.delete(state);
    }
    // A later publication can still reject; retain the original scope's proof
    // before pruning its last reference from the retirement gate.
    if (this.#current.cleanupDiagnostics.some(diagnostic => confirmedIds.has(diagnostic.activationId) && !diagnostic.lateConfirmed)) this.#current = Object.freeze({ ...this.#current,
      cleanupDiagnostics: Object.freeze(this.#current.cleanupDiagnostics.map(diagnostic =>
        confirmedIds.has(diagnostic.activationId) ? Object.freeze({ ...diagnostic, lateConfirmed: true as const }) : diagnostic
      )) });
    if (!unconfirmed.size) { this.#unconfirmedRetirements.delete(instanceId); return; }
    throw new Error(`Previous plugin activation retirement is unconfirmed: ${instanceId}.`);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #notifyPublished(generation: PluginGeneration): void {
    try { this.#onPublished?.(generation); }
    catch {
      // Publication is committed. An observational subscriber cannot roll it back or interrupt cleanup.
    }
  }
}
