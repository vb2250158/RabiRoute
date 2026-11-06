import type { PluginManifest } from "./types.js";

/** Capability metadata only; executable entry and immutable package proof are not required here. */
export type CapabilityGraphNode = Readonly<{ instanceId: string; manifest: Pick<PluginManifest, "provides" | "requires" | "optional"> }>;

export type CapabilityGraphPlan = Readonly<{
  activationOrder: readonly string[];
  waiting: ReadonlyMap<string, readonly string[]>;
  providers: ReadonlyMap<string, string>;
  dependents: ReadonlyMap<string, readonly string[]>;
}>;

function uniqueCandidates(candidates: readonly CapabilityGraphNode[]): Map<string, CapabilityGraphNode> {
  const result = new Map<string, CapabilityGraphNode>();
  for (const candidate of candidates) {
    const instanceId = candidate.instanceId.trim();
    if (!instanceId) throw new Error("Plugin instanceId is required.");
    if (result.has(instanceId)) throw new Error(`Duplicate plugin instanceId: ${instanceId}.`);
    result.set(instanceId, candidate);
  }
  return result;
}

export function planCapabilityGraph(candidates: readonly CapabilityGraphNode[], hostCapabilities: ReadonlySet<string>): CapabilityGraphPlan {
  const byId = uniqueCandidates(candidates);
  const providers = new Map<string, string>();
  for (const candidate of byId.values()) {
    for (const capability of candidate.manifest.provides) {
      if (hostCapabilities.has(capability)) throw new Error(`Plugin capability conflicts with host capability: ${capability}.`);
      const existing = providers.get(capability);
      if (existing) throw new Error(`Capability has multiple providers: ${capability} (${existing}, ${candidate.instanceId}).`);
      providers.set(capability, candidate.instanceId);
    }
  }

  const waiting = new Map<string, readonly string[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of byId.values()) {
      if (waiting.has(candidate.instanceId)) continue;
      const missing = candidate.manifest.requires.filter(capability => {
        if (hostCapabilities.has(capability)) return false;
        const provider = providers.get(capability);
        return !provider || waiting.has(provider);
      });
      if (!missing.length) continue;
      waiting.set(candidate.instanceId, Object.freeze([...missing]));
      changed = true;
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const candidate of byId.values()) if (!waiting.has(candidate.instanceId)) indegree.set(candidate.instanceId, 0);
  for (const candidate of byId.values()) {
    if (waiting.has(candidate.instanceId)) continue;
    const dependencyProviders = new Set<string>();
    for (const capability of [...candidate.manifest.requires, ...candidate.manifest.optional]) {
      const provider = providers.get(capability);
      if (!provider || provider === candidate.instanceId || waiting.has(provider)) continue;
      if (dependencyProviders.has(provider)) continue;
      dependencyProviders.add(provider);
      indegree.set(candidate.instanceId, (indegree.get(candidate.instanceId) ?? 0) + 1);
      const values = dependents.get(provider) ?? [];
      if (!values.includes(candidate.instanceId)) values.push(candidate.instanceId);
      dependents.set(provider, values);
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  const activationOrder: string[] = [];
  while (queue.length) {
    const instanceId = queue.shift()!;
    activationOrder.push(instanceId);
    for (const dependent of dependents.get(instanceId) ?? []) {
      const degree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, degree);
      if (degree === 0) { queue.push(dependent); queue.sort(); }
    }
  }
  if (activationOrder.length !== indegree.size) {
    const cycle = [...indegree.keys()].filter(id => !activationOrder.includes(id)).sort();
    throw new Error(`Plugin capability dependency cycle: ${cycle.join(", ")}.`);
  }

  return Object.freeze({
    activationOrder: Object.freeze(activationOrder),
    waiting,
    providers,
    dependents: new Map([...dependents].map(([id, values]) => [id, Object.freeze([...values].sort())]))
  });
}

/** Follow mandatory providers only; optional activation ordering does not make a READY dependency. */
export function selectRequiredCapabilityProviders<T extends CapabilityGraphNode>(
  nodes: readonly T[], plan: CapabilityGraphPlan, readyRequires: readonly string[], hostCapabilities: ReadonlySet<string>
): readonly T[] {
  const byId = new Map(nodes.map(node => [node.instanceId.trim(), node]));
  const selected = new Set<string>();
  const pending = readyRequires.map(capability => capability.trim()).filter(Boolean);
  while (pending.length) {
    const capability = pending.pop()!;
    if (hostCapabilities.has(capability)) continue;
    const providerId = plan.providers.get(capability);
    if (!providerId || selected.has(providerId)) continue;
    selected.add(providerId);
    const provider = byId.get(providerId);
    if (provider) pending.push(...provider.manifest.requires);
  }
  return Object.freeze(nodes.filter(node => selected.has(node.instanceId.trim())));
}
