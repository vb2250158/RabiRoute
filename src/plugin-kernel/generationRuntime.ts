import { randomUUID } from "node:crypto";
import { planCapabilityGraph, type CapabilityGraphPlan } from "./capabilityGraph.js";
import { ContributionRegistryDraft, type ContributionRegistrySnapshot, type RegisteredPluginContribution } from "./contributionRegistry.js";
import { EffectScope } from "./effectScope.js";
import { GrantedPermissions } from "./permissionGate.js";
import { ServiceRegistryDraft, type ServiceRegistrySnapshot } from "./serviceRegistry.js";
import type {
  HostService,
  PluginCandidate,
  PluginContext,
  PluginContribution,
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
  records: readonly PluginRuntimeRecord[];
  services: ServiceRegistrySnapshot;
  contributions: ContributionRegistrySnapshot;
}>;

export type GenerationSwitchResult = Readonly<{
  changed: boolean;
  generation: PluginGeneration;
  previousGenerationId?: string;
}>;

export type GenerationRuntimeOptions = Readonly<{
  host: PluginHost;
  hostServices?: readonly HostService[];
  grantedPermissions?: (identity: PluginIdentity) => readonly string[];
}>;

type ActivePluginState = Readonly<{
  identity: PluginIdentity;
  manifest: PluginManifest;
  signature: string;
  scope: EffectScope;
  services: readonly PluginServiceRegistration[];
  contributions: readonly RegisteredPluginContribution[];
}>;

type ComponentFailure = Readonly<{ instanceId: string; error: unknown }>;

function errorSummary(error: unknown, code = "activation_failed") {
  return Object.freeze({ code, message: error instanceof Error ? error.message : String(error) });
}

function failedRecord(identity: PluginIdentity, manifest: PluginManifest, error: unknown): PluginRuntimeRecord {
  return Object.freeze({
    identity,
    manifest,
    status: "failed",
    missingCapabilities: Object.freeze([]),
    error: errorSummary(error)
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

function activeRecord(state: ActivePluginState, updateError?: unknown): PluginRuntimeRecord {
  return Object.freeze({
    identity: state.identity,
    manifest: state.manifest,
    status: "active",
    missingCapabilities: Object.freeze([]),
    ...(updateError ? { error: errorSummary(updateError, "update_failed_using_previous_revision") } : {})
  });
}

function pluginIdentity(candidate: PluginCandidate, host: PluginHost): PluginIdentity {
  if (!candidate.manifest.entries[host]) throw new Error(`Plugin does not provide a ${host} entry: ${candidate.manifest.id}.`);
  const instanceId = candidate.instanceId.trim();
  const revision = candidate.revision.trim();
  if (!instanceId || !revision) throw new Error("Plugin instanceId and revision are required.");
  return Object.freeze({
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
    granted: [...granted].sort()
  });
}

function dependencyComponents(
  candidates: readonly PluginCandidate[],
  plan: CapabilityGraphPlan
): readonly (readonly string[])[] {
  const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
  const adjacency = new Map<string, Set<string>>([...byId.keys()].map(instanceId => [instanceId, new Set<string>()]));
  for (const candidate of byId.values()) {
    for (const capability of [...candidate.manifest.requires, ...candidate.manifest.optional]) {
      const provider = plan.providers.get(capability);
      if (!provider || provider === candidate.instanceId) continue;
      adjacency.get(candidate.instanceId)!.add(provider);
      adjacency.get(provider)!.add(candidate.instanceId);
    }
  }
  const activationPosition = new Map(plan.activationOrder.map((instanceId, index) => [instanceId, index]));
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const instanceId of [...byId.keys()].sort()) {
    if (seen.has(instanceId)) continue;
    const pending = [instanceId];
    const component: string[] = [];
    seen.add(instanceId);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const adjacent of adjacency.get(current) ?? []) {
        if (seen.has(adjacent)) continue;
        seen.add(adjacent);
        pending.push(adjacent);
      }
    }
    component.sort((left, right) =>
      (activationPosition.get(left) ?? Number.MAX_SAFE_INTEGER) - (activationPosition.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    );
    components.push(component);
  }
  return Object.freeze(components.sort((left, right) => {
    const leftPosition = Math.min(...left.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    const rightPosition = Math.min(...right.map(id => activationPosition.get(id) ?? Number.MAX_SAFE_INTEGER));
    return leftPosition - rightPosition || left[0]!.localeCompare(right[0]!);
  }).map(component => Object.freeze(component)));
}

function contributionKey(contribution: Pick<PluginContribution, "kind" | "id">): string {
  return `${contribution.kind.trim()}\0${contribution.id.trim()}`;
}

export class GenerationRuntime {
  readonly #host: PluginHost;
  readonly #hostServices: readonly HostService[];
  readonly #grantedPermissions: (identity: PluginIdentity) => readonly string[];
  #sequence = 0;
  #current: PluginGeneration;
  #active = new Map<string, ActivePluginState>();

  constructor(options: GenerationRuntimeOptions) {
    this.#host = options.host;
    this.#hostServices = Object.freeze([...(options.hostServices ?? [])]);
    this.#grantedPermissions = options.grantedPermissions ?? (() => []);
    this.#current = Object.freeze({
      id: randomUUID(),
      sequence: 0,
      createdAt: new Date().toISOString(),
      host: this.#host,
      records: Object.freeze([]),
      services: new ServiceRegistryDraft(this.#hostServices).snapshot(0),
      contributions: new ContributionRegistryDraft().snapshot(0)
    });
  }

  current(): PluginGeneration {
    return this.#current;
  }

  async switch(candidates: readonly PluginCandidate[]): Promise<GenerationSwitchResult> {
    const hostCapabilities = new Set(this.#hostServices.map(service => service.capability));
    const plan = planCapabilityGraph(candidates, hostCapabilities);
    const byId = new Map(candidates.map(candidate => [candidate.instanceId.trim(), candidate]));
    const identities = new Map<string, PluginIdentity>();
    const granted = new Map<string, readonly string[]>();
    const signatures = new Map<string, string>();
    for (const [instanceId, candidate] of byId) {
      const identity = pluginIdentity(candidate, this.#host);
      const permissions = Object.freeze([...this.#grantedPermissions(identity)].sort());
      identities.set(instanceId, identity);
      granted.set(instanceId, permissions);
      signatures.set(instanceId, candidateSignature(candidate, permissions));
    }

    const desiredIds = new Set(byId.keys());
    const unchanged = candidates.length === this.#active.size
      && [...byId.keys()].every(instanceId => this.#active.get(instanceId)?.signature === signatures.get(instanceId))
      && this.#current.records.every(record => record.status === "active" && !record.error);
    if (unchanged) return Object.freeze({ changed: false, generation: this.#current });

    const previous = this.#current;
    const previousActive = this.#active;
    const nextActive = new Map<string, ActivePluginState>();
    const records: PluginRuntimeRecord[] = [];
    const claimedContributionKeys = new Set<string>();
    const scopesToDispose = new Set<EffectScope>();

    for (const component of dependencyComponents(candidates, plan)) {
      const waiting = component.filter(instanceId => plan.waiting.has(instanceId));
      if (waiting.length) {
        for (const instanceId of component) {
          const candidate = byId.get(instanceId)!;
          records.push(waitingRecord(identities.get(instanceId)!, candidate.manifest, plan.waiting.get(instanceId) ?? []));
          const old = previousActive.get(instanceId);
          if (old) scopesToDispose.add(old.scope);
        }
        continue;
      }

      const componentUnchanged = component.every(instanceId =>
        previousActive.get(instanceId)?.signature === signatures.get(instanceId)
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
      for (const service of this.#hostServices) {
        serviceValues.set(service.capability, Object.freeze({ capability: service.capability, providerInstanceId: "host", value: service.value }));
      }
      const prepared: ActivePluginState[] = [];
      let failure: ComponentFailure | undefined;

      try {
        for (const instanceId of component) {
          const candidate = byId.get(instanceId)!;
          const identity = identities.get(instanceId)!;
          const permissions = new GrantedPermissions(candidate.manifest.permissions, granted.get(instanceId)!);
          const declaredProvides = new Set(candidate.manifest.provides);
          const provided = new Set<string>();
          const pluginServices: PluginServiceRegistration[] = [];
          const pluginContributions: RegisteredPluginContribution[] = [];
          const componentContributionKeys = new Set(prepared.flatMap(state => state.contributions.map(contributionKey)));
          const scope = new EffectScope();
          const context: PluginContext = Object.freeze({
            identity,
            config: candidate.config,
            services: Object.freeze({
              require<T>(capability: string): T {
                if (!candidate.manifest.requires.includes(capability) && !candidate.manifest.optional.includes(capability)) {
                  throw new Error(`Plugin did not declare required capability: ${capability}.`);
                }
                const service = serviceValues.get(capability.trim());
                if (!service) throw new Error(`Required plugin service is unavailable: ${capability.trim()}.`);
                return service.value as T;
              },
              optional<T>(capability: string): T | undefined {
                if (!candidate.manifest.optional.includes(capability) && !candidate.manifest.requires.includes(capability)) {
                  throw new Error(`Plugin did not declare optional capability: ${capability}.`);
                }
                return serviceValues.get(capability.trim())?.value as T | undefined;
              },
              provide<T>(capability: string, value: T): void {
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
                const kind = contribution.kind.trim();
                const id = contribution.id.trim();
                if (!kind || !id) throw new Error("Plugin contribution kind and id are required.");
                const key = contributionKey({ kind, id });
                if (claimedContributionKeys.has(key) || componentContributionKeys.has(key)) {
                  throw new Error(`Plugin contribution is already registered: ${kind}/${id}.`);
                }
                componentContributionKeys.add(key);
                pluginContributions.push(Object.freeze({ instanceId, kind, id, value: contribution.value }));
              }
            }),
            permissions,
            effects: Object.freeze({ add: (starter: PluginEffectStarter, label?: string) => scope.add(starter, label) })
          });

          try {
            await candidate.module.activate(context);
            const missingProvides = [...declaredProvides].filter(capability => !provided.has(capability));
            if (missingProvides.length) throw new Error(`Plugin did not provide declared capabilities: ${missingProvides.join(", ")}.`);
            prepared.push(Object.freeze({
              identity,
              manifest: candidate.manifest,
              signature: signatures.get(instanceId)!,
              scope,
              services: Object.freeze(pluginServices),
              contributions: Object.freeze(pluginContributions)
            }));
          } catch (error) {
            await scope.dispose().catch(() => {});
            throw Object.freeze({ instanceId, error }) satisfies ComponentFailure;
          }
        }

        for (const state of prepared) {
          try {
            await state.scope.commit();
          } catch (error) {
            throw Object.freeze({ instanceId: state.identity.instanceId, error }) satisfies ComponentFailure;
          }
        }
      } catch (error) {
        failure = error && typeof error === "object" && "instanceId" in error && "error" in error
          ? error as ComponentFailure
          : Object.freeze({ instanceId: component[0]!, error });
        for (const state of [...prepared].reverse()) await state.scope.dispose().catch(() => {});
      }

      if (!failure) {
        for (const state of prepared) {
          nextActive.set(state.identity.instanceId, state);
          records.push(activeRecord(state));
          for (const contribution of state.contributions) claimedContributionKeys.add(contributionKey(contribution));
          const old = previousActive.get(state.identity.instanceId);
          if (old && old.scope !== state.scope) scopesToDispose.add(old.scope);
        }
        continue;
      }

      let preserved = false;
      for (const instanceId of component) {
        const old = previousActive.get(instanceId);
        if (!old) continue;
        preserved = true;
        nextActive.set(instanceId, old);
        records.push(activeRecord(old, failure.error));
        for (const contribution of old.contributions) claimedContributionKeys.add(contributionKey(contribution));
      }
      for (const instanceId of component) {
        if (previousActive.has(instanceId)) continue;
        const candidate = byId.get(instanceId)!;
        const error = instanceId === failure.instanceId
          ? failure.error
          : new Error(`Plugin activation was cancelled because dependency component ${failure.instanceId} failed.`);
        records.push(failedRecord(identities.get(instanceId)!, candidate.manifest, error));
      }
      if (!preserved) {
        for (const state of prepared) scopesToDispose.add(state.scope);
      }
    }

    for (const [instanceId, state] of previousActive) {
      if (!desiredIds.has(instanceId) || !nextActive.has(instanceId)) scopesToDispose.add(state.scope);
    }

    const sequence = this.#sequence + 1;
    const serviceRegistry = new ServiceRegistryDraft(this.#hostServices);
    const contributionRegistry = new ContributionRegistryDraft();
    for (const state of nextActive.values()) {
      for (const service of state.services) serviceRegistry.register(state.identity.instanceId, service.capability, service.value);
      for (const contribution of state.contributions) contributionRegistry.register(state.identity.instanceId, contribution);
    }
    const generation: PluginGeneration = Object.freeze({
      id: randomUUID(),
      sequence,
      createdAt: new Date().toISOString(),
      host: this.#host,
      records: Object.freeze(records.sort((left, right) => left.identity.instanceId.localeCompare(right.identity.instanceId))),
      services: serviceRegistry.snapshot(sequence),
      contributions: contributionRegistry.snapshot(sequence)
    });

    this.#sequence = sequence;
    this.#active = nextActive;
    this.#current = generation;
    for (const scope of scopesToDispose) {
      if ([...nextActive.values()].some(state => state.scope === scope)) continue;
      await scope.dispose();
    }
    return Object.freeze({ changed: true, generation, previousGenerationId: previous.id });
  }

  async dispose(): Promise<void> {
    const active = this.#active;
    this.#active = new Map();
    for (const state of [...active.values()].reverse()) await state.scope.dispose();
  }
}
