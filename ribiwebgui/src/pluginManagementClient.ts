import { getTimeoutMs } from "./timeoutSettingsClient";

export type ManagedPlugin = Readonly<{
  instanceId: string;
  pluginId: string;
  enabled: boolean;
  status: string;
  manifest: Readonly<{
    id: string;
    version: string;
    hosts: readonly string[];
    capabilities: readonly string[];
    name?: string;
    displayName?: string;
    description?: string;
    icon?: string;
  }>;
  missingCapabilities: readonly string[];
  error?: unknown;
}>;

export type PluginManagementCatalog = Readonly<{
  revision: string;
  generation: string;
  plugins: readonly ManagedPlugin[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A malformed optional entry must not hide the other installed plugins. */
export function parsePluginManagementCatalog(value: unknown): PluginManagementCatalog {
  if (!record(value) || value.code !== 0 || !record(value.data) || value.data.schemaVersion !== 2 || !Array.isArray(value.data.plugins)) {
    throw new Error(record(value) && typeof value.message === "string" ? value.message : "Plugin catalog response is invalid.");
  }
  return {
    revision: "",
    generation: typeof value.data.generation === "string" ? value.data.generation : "",
    plugins: value.data.plugins.flatMap((item): ManagedPlugin[] => {
      if (!record(item) || typeof item.instanceId !== "string" || !item.instanceId || typeof item.pluginId !== "string"
        || !record(item.manifest) || typeof item.manifest.id !== "string" || typeof item.status !== "string") return [];
      return [{
        instanceId: item.instanceId, pluginId: item.pluginId, enabled: item.status !== "inactive", status: item.status,
        manifest: {
          id: item.manifest.id, version: typeof item.manifest.version === "string" ? item.manifest.version : "",
          hosts: strings(item.manifest.hosts), capabilities: strings(item.manifest.capabilities),
          ...(typeof item.manifest.name === "string" ? { name: item.manifest.name } : {}),
          ...(typeof item.manifest.displayName === "string" ? { displayName: item.manifest.displayName } : {}),
          ...(typeof item.manifest.description === "string" ? { description: item.manifest.description } : {}),
          ...(typeof item.manifest.icon === "string" && /^mdi-[a-z0-9-]+$/.test(item.manifest.icon) ? { icon: item.manifest.icon } : {})
        },
        missingCapabilities: strings(item.missingCapabilities), ...(item.error ? { error: item.error } : {})
      }];
    })
  };
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const deadline = AbortSignal.timeout(init.method === "PATCH" ? getTimeoutMs("webgui.plugins.update", 45000) : getTimeoutMs("webgui.plugins.read", 15000));
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(path, { ...init, signal, headers: { accept: "application/json", ...init.headers } });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(record(body) && typeof body.message === "string" ? body.message : `HTTP ${response.status}`);
  return body;
}

export function parsePluginInstances(value: unknown, catalog?: PluginManagementCatalog): PluginManagementCatalog {
  if (!record(value) || value.code !== 0 || !record(value.data) || typeof value.data.revision !== "string" || !Array.isArray(value.data.instances)) {
    throw new Error(record(value) && typeof value.message === "string" ? value.message : "Plugin instances response is invalid.");
  }
  const native = new Map(catalog?.plugins.map(plugin => [plugin.instanceId, plugin]));
  return {
    revision: value.data.revision, generation: catalog?.generation || "",
    plugins: value.data.instances.flatMap((item): ManagedPlugin[] => {
      if (!record(item) || typeof item.instanceId !== "string" || !item.instanceId || typeof item.pluginId !== "string" || typeof item.enabled !== "boolean") return [];
      const existing = native.get(item.instanceId);
      const manifest = record(item.manifest) ? item.manifest : {};
      return [{
        instanceId: item.instanceId, pluginId: item.pluginId, enabled: item.enabled,
        status: typeof item.status === "string" ? item.status : existing?.status || (!item.enabled ? "disabled" : "inactive"),
        manifest: {
          id: item.pluginId, version: typeof item.version === "string" ? item.version : existing?.manifest.version || "",
          hosts: Array.isArray(manifest.hosts) ? strings(manifest.hosts) : record(manifest.entries) ? Object.keys(manifest.entries) : existing?.manifest.hosts || [],
          capabilities: Array.isArray(manifest.capabilities) ? strings(manifest.capabilities) : Array.isArray(manifest.provides) ? strings(manifest.provides) : existing?.manifest.capabilities || [],
          ...(typeof manifest.name === "string" ? { name: manifest.name } : existing?.manifest.name ? { name: existing.manifest.name } : {}),
          ...(typeof manifest.displayName === "string" ? { displayName: manifest.displayName } : existing?.manifest.displayName ? { displayName: existing.manifest.displayName } : {}),
          ...(typeof manifest.description === "string" ? { description: manifest.description } : existing?.manifest.description ? { description: existing.manifest.description } : {}),
          ...(typeof manifest.icon === "string" && /^mdi-[a-z0-9-]+$/.test(manifest.icon) ? { icon: manifest.icon } : existing?.manifest.icon ? { icon: existing.manifest.icon } : {})
        },
        missingCapabilities: strings(item.missingCapabilities), ...(item.error ? { error: item.error } : {})
      }];
    })
  };
}

export async function readPluginManagementCatalog(signal?: AbortSignal): Promise<PluginManagementCatalog> {
  const [instances, catalog] = await Promise.allSettled([
    request("/api/plugins/instances", { signal }), request("/api/plugins/catalog", { signal }).then(parsePluginManagementCatalog)
  ]);
  if (instances.status === "rejected") throw instances.reason;
  return parsePluginInstances(instances.value, catalog.status === "fulfilled" ? catalog.value : undefined);
}

export async function updateManagedPlugin(instanceId: string, expectedRevision: string, enabled: boolean): Promise<PluginManagementCatalog> {
  return parsePluginInstances(await request(`/api/plugins/instances/${encodeURIComponent(instanceId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, enabled })
  }));
}

export function pluginDisplayName(plugin: ManagedPlugin): string {
  return plugin.manifest.displayName || plugin.manifest.name || plugin.pluginId;
}

export function filterManagedPlugins(plugins: readonly ManagedPlugin[], query: string, status = "all"): ManagedPlugin[] {
  const term = query.trim().toLocaleLowerCase();
  return plugins.filter(plugin => (status === "all" || (status === "disabled" ? !plugin.enabled : plugin.status === status))
    && (!term || [pluginDisplayName(plugin), plugin.pluginId, plugin.instanceId, plugin.manifest.description || "", ...plugin.manifest.capabilities]
      .some(value => value.toLocaleLowerCase().includes(term))));
}
