import type { PluginContribution } from "./types.js";

export type RegisteredPluginContribution = PluginContribution & Readonly<{ instanceId: string }>;
export type ContributionRegistrySnapshot = Readonly<{ revision: number; contributions: readonly RegisteredPluginContribution[] }>;

export class ContributionRegistryDraft {
  readonly #values: RegisteredPluginContribution[] = [];
  readonly #keys = new Set<string>();
  register(instanceId: string, contribution: PluginContribution): void {
    const kind = contribution.kind.trim();
    const id = contribution.id.trim();
    if (!kind || !id) throw new Error("Plugin contribution kind and id are required.");
    const key = `${kind}\0${id}`;
    if (this.#keys.has(key)) throw new Error(`Plugin contribution is already registered: ${kind}/${id}.`);
    this.#keys.add(key);
    this.#values.push(Object.freeze({ instanceId, kind, id, value: contribution.value }));
  }
  snapshot(revision: number): ContributionRegistrySnapshot {
    return Object.freeze({ revision, contributions: Object.freeze([...this.#values]) });
  }
}
