import type { PluginGeneration } from "../plugin-kernel/generationRuntime.js";

export type PluginCatalogInput = Pick<PluginGeneration, "id" | "sequence" | "records" | "contributions">;

export type PluginCatalogPresentationDiagnostic = Readonly<{
  code: "PLUGIN_CONTRIBUTION_PRESENTATION_FAILED";
  instanceId: string;
  pluginId: string;
  kind: string;
  id: string;
  message: string;
}>;

function contributionPayload(generation: PluginCatalogInput, host?: "web" | "desktop") {
  const pluginIds = new Map(generation.records.map(record => [record.identity.instanceId, record.identity.pluginId]));
  const contributions: Record<string, unknown>[] = [];
  const diagnostics: PluginCatalogPresentationDiagnostic[] = [];
  for (const contribution of generation.contributions.contributions) {
    const pluginId = pluginIds.get(contribution.instanceId) ?? "";
    try {
      const value = contribution.value && typeof contribution.value === "object" && !Array.isArray(contribution.value)
        ? contribution.value as Record<string, unknown> : {};
      const declaredHosts = value.hosts;
      const hosts = Array.isArray(declaredHosts) ? declaredHosts.filter(item => typeof item === "string") as string[] : [];
      // Provider metadata describes the active Manager owner to every UI host.
      if (host && !hosts.includes(host) && contribution.kind !== "agent-adapter") continue;
      const payload = { instanceId: contribution.instanceId, pluginId, kind: contribution.kind, id: contribution.id, ...value };
      // Materialize this one JSON projection before publishing the collection.
      // A getter, cycle or toJSON failure must not break healthy contributions later.
      const snapshot: unknown = JSON.parse(JSON.stringify(payload));
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Contribution is not a JSON object.");
      contributions.push(snapshot as Record<string, unknown>);
    } catch {
      diagnostics.push({ code: "PLUGIN_CONTRIBUTION_PRESENTATION_FAILED", instanceId: contribution.instanceId,
        pluginId, kind: contribution.kind, id: contribution.id,
        message: "This plugin contribution could not be displayed; other contributions remain available." });
    }
  }
  return { contributions, diagnostics };
}

export function renderPluginCatalog(generation: PluginCatalogInput, host?: "web" | "desktop") {
  const presentation = contributionPayload(generation, host);
  return {
    schemaVersion: 2, generation: generation.id, host: host || "all",
    revision: { plugins: generation.sequence, contributions: generation.contributions.revision },
    plugins: generation.records.map(record => ({
      instanceId: record.identity.instanceId, pluginId: record.identity.pluginId,
      manifest: {
        id: record.manifest.id, version: record.manifest.version, kind: "package",
        hosts: Object.keys(record.manifest.entries), capabilities: record.manifest.provides
      },
      host: record.identity.host, scope: "global", status: record.status, missingCapabilities: record.missingCapabilities,
      ...(record.error ? { error: record.error } : {})
    })),
    contributions: presentation.contributions,
    ...(presentation.diagnostics.length ? { partial: true as const, diagnostics: presentation.diagnostics } : {})
  };
}
