import { planCapabilityGraph, type CapabilityGraphPlan } from "./capabilityGraph.js";
import type { PluginCandidate } from "./types.js";

export type PluginGraphDiagnostic = Readonly<{ candidate: PluginCandidate; error: Error; rejected: boolean }>;

export function sharedWebResourceKey(candidate: PluginCandidate): string | undefined {
  return candidate.manifest.entries.web ? JSON.stringify([candidate.manifest.id, candidate.manifest.version]) : undefined;
}

function conflictingWebResources(candidates: ReadonlyMap<string, PluginCandidate>, previous: ReadonlyMap<string, PluginCandidate>): Map<string, Error> {
  const groups = new Map<string, PluginCandidate[]>();
  for (const candidate of candidates.values()) {
    const key = sharedWebResourceKey(candidate);
    if (key) groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const invalid = new Map<string, Error>();
  for (const [key, members] of groups) {
    if (new Set(members.map(candidate => candidate.revision)).size <= 1) continue;
    const confirmed = new Set([...previous.values()].filter(candidate => sharedWebResourceKey(candidate) === key).map(candidate => candidate.revision));
    for (const candidate of members) {
      if (confirmed.size === 1 && confirmed.has(candidate.revision)) continue;
      invalid.set(candidate.instanceId, new Error(`Shared Web resource has conflicting revisions: ${candidate.manifest.id}@${candidate.manifest.version}.`));
    }
  }
  return invalid;
}

function providers(candidates: readonly PluginCandidate[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const candidate of candidates) for (const capability of candidate.manifest.provides) {
    result.set(capability, [...(result.get(capability) ?? []), candidate.instanceId]);
  }
  return result;
}

function requiredCycles(candidates: ReadonlyMap<string, PluginCandidate>, supplied: ReadonlyMap<string, string[]>, host: ReadonlySet<string>): Set<string> {
  const unavailable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates.values()) {
      if (unavailable.has(candidate.instanceId)) continue;
      if (candidate.manifest.requires.some(capability => !host.has(capability)
        && (!supplied.has(capability) || unavailable.has(supplied.get(capability)![0]!)))) {
        unavailable.add(candidate.instanceId);
        changed = true;
      }
    }
  }
  const completed = new Set<string>(), positions = new Map<string, number>(), stack: string[] = [], cyclic = new Set<string>();
  const visit = (id: string): void => {
    if (completed.has(id) || unavailable.has(id)) return;
    const position = positions.get(id);
    if (position !== undefined) { for (const member of stack.slice(position)) cyclic.add(member); return; }
    positions.set(id, stack.length);
    stack.push(id);
    for (const capability of candidates.get(id)!.manifest.requires) {
      const provider = supplied.get(capability)?.[0];
      if (provider && provider !== id) visit(provider);
    }
    stack.pop();
    positions.delete(id);
    completed.add(id);
  };
  for (const id of candidates.keys()) visit(id);
  return cyclic;
}

/** Keep malformed feature declarations outside the strict graph planner. */
export function isolateCapabilityGraph(
  candidates: readonly PluginCandidate[],
  hostCapabilities: ReadonlySet<string>,
  previous: ReadonlyMap<string, PluginCandidate> = new Map()
): Readonly<{ candidates: readonly PluginCandidate[]; diagnostics: ReadonlyMap<string, PluginGraphDiagnostic>; plan: CapabilityGraphPlan }> {
  const effective = new Map<string, PluginCandidate>();
  for (const candidate of candidates) {
    const id = candidate.instanceId.trim();
    if (!id || effective.has(id)) throw new Error(`Plugin instanceId is empty or duplicated: ${id}.`);
    effective.set(id, candidate);
  }
  const diagnostics = new Map<string, PluginGraphDiagnostic>();
  const confirmedProviders = new Map<string, string>();
  for (const candidate of previous.values()) for (const capability of candidate.manifest.provides) confirmedProviders.set(capability, candidate.instanceId);
  let changed = true;
  while (changed) {
    changed = false;
    const supplied = providers([...effective.values()]);
    const invalid = conflictingWebResources(effective, previous);
    for (const [capability, ids] of supplied) {
      if (hostCapabilities.has(capability)) {
        for (const id of ids) invalid.set(id, new Error(`Plugin capability conflicts with host capability: ${capability}.`));
      } else if (ids.length > 1) {
        const confirmed = confirmedProviders.get(capability);
        for (const id of ids) if (id !== confirmed) {
          invalid.set(id, new Error(`Capability has multiple providers: ${capability} (${ids.join(", ")}).`));
        }
      }
    }
    if (!invalid.size) for (const id of requiredCycles(effective, supplied, hostCapabilities)) {
      invalid.set(id, new Error(`Plugin required capability dependency cycle: ${id}.`));
    }
    for (const [id, error] of invalid) {
      const candidate = effective.get(id)!;
      if (!diagnostics.has(id)) diagnostics.set(id, Object.freeze({ candidate, error, rejected: true }));
      const retained = previous.get(id);
      if (retained && candidate !== retained) { effective.set(id, retained); changed = true; }
      else if (!retained) { effective.delete(id); changed = true; }
    }
    // Evaluate the restored graph before removing any previously confirmed
    // participant of a cycle caused by another plugin's rejected update.
    if (invalid.size && !changed) {
      for (const id of invalid.keys()) effective.delete(id);
      changed = true;
    }
  }

  const valid = [...effective.values()];
  const supplied = providers(valid);
  const edges = new Map(valid.map(candidate => [candidate.instanceId, new Set(candidate.manifest.requires
    .map(capability => supplied.get(capability)?.[0]).filter((id): id is string => Boolean(id) && id !== candidate.instanceId))]));
  const reaches = (from: string, target: string): boolean => {
    const pending = [from], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(edges.get(id) ?? []));
    }
    return false;
  };
  const planning = valid.map(candidate => {
    const optional = candidate.manifest.optional.filter(capability => {
      const provider = supplied.get(capability)?.[0];
      if (!provider || provider === candidate.instanceId || edges.get(candidate.instanceId)!.has(provider)) return true;
      if (reaches(provider, candidate.instanceId)) {
        if (!diagnostics.has(candidate.instanceId)) diagnostics.set(candidate.instanceId, Object.freeze({ candidate,
          error: new Error(`Optional capability ordering skipped to avoid a dependency cycle: ${capability}.`), rejected: false }));
        return false;
      }
      edges.get(candidate.instanceId)!.add(provider);
      return true;
    });
    return { ...candidate, manifest: { ...candidate.manifest, optional } };
  });
  return Object.freeze({ candidates: Object.freeze(valid), diagnostics, plan: planCapabilityGraph(planning, hostCapabilities) });
}
