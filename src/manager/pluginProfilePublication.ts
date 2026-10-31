import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";
import type { LoadedPluginProfile } from "../plugin-kernel/profile.js";
import type { PluginCandidate, PluginIdentity } from "../plugin-kernel/types.js";

type PackageEntry = LoadedPluginProfile["packages"][number];
type PublishedMetadata = Readonly<{ candidate: PluginCandidate; packageEntry: PackageEntry }>;
export type PluginProfilePublicationDiagnostic = Readonly<{
  code: "active_package_metadata_unavailable";
  instanceId: string;
  pluginId: string;
  revision: string;
}>;

function identityKey(identity: PluginIdentity): string {
  return JSON.stringify([identity.applicationGenerationId, identity.managerInstanceId, identity.activationId,
    identity.instanceId, identity.pluginId, identity.version, identity.revision, identity.host]);
}

function matchesCandidate(candidate: PluginCandidate, identity: PluginIdentity): boolean {
  return candidate.instanceId === identity.instanceId && candidate.manifest.id === identity.pluginId
    && candidate.manifest.version === identity.version && candidate.revision === identity.revision;
}

function matchesPackage(entry: PackageEntry, identity: PluginIdentity): boolean {
  return entry.instance.id === identity.instanceId && entry.package.manifest.id === identity.pluginId
    && entry.package.manifest.version === identity.version && entry.package.revision === identity.revision;
}

/** Associates package/configuration snapshots with actual published activations. */
export class PluginProfilePublication {
  private metadataByActivation = new Map<string, PublishedMetadata>();
  private lastProfile?: LoadedPluginProfile;

  capture(requested: LoadedPluginProfile | undefined, generation: PluginGeneration): Readonly<{
    profile: LoadedPluginProfile | undefined;
    diagnostics: readonly PluginProfilePublicationDiagnostic[];
  }> {
    const source = requested ?? this.lastProfile;
    const published = new Map<string, PublishedMetadata>();
    const entries: PublishedMetadata[] = [];
    const diagnostics: PluginProfilePublicationDiagnostic[] = [];
    for (const record of generation.records) {
      if (record.status !== "active") continue;
      const key = identityKey(record.identity);
      let metadata = this.metadataByActivation.get(key);
      // An unchanged activation keeps its original config/policy even when a
      // failed config-only update has exactly the same immutable package hash.
      if (!metadata && source) {
        const candidate = source.candidates.find(value => matchesCandidate(value, record.identity));
        const packageEntry = source.packages.find(value => matchesPackage(value, record.identity));
        if (candidate && packageEntry) metadata = Object.freeze({ candidate, packageEntry });
      }
      if (!metadata) {
        diagnostics.push(Object.freeze({ code: "active_package_metadata_unavailable", instanceId: record.identity.instanceId,
          pluginId: record.identity.pluginId, revision: record.identity.revision }));
        continue;
      }
      published.set(key, metadata);
      entries.push(metadata);
    }
    this.metadataByActivation = published;
    if (!source) return Object.freeze({ profile: undefined, diagnostics: Object.freeze(diagnostics) });
    const grantsById = new Map(entries.map(value => [value.packageEntry.instance.id, value.packageEntry.instance.grants]));
    const profile: LoadedPluginProfile = Object.freeze({
      profile: Object.freeze({ schemaVersion: 2, readyRequires: generation.readyRequires,
        instances: Object.freeze(entries.map(value => value.packageEntry.instance)) }),
      candidates: Object.freeze(entries.map(value => value.candidate)),
      packages: Object.freeze(entries.map(value => value.packageEntry)),
      loadFailures: source.loadFailures,
      grants(identity: PluginIdentity): readonly string[] { return grantsById.get(identity.instanceId) ?? Object.freeze([]); }
    });
    this.lastProfile = profile;
    return Object.freeze({ profile, diagnostics: Object.freeze(diagnostics) });
  }
}
