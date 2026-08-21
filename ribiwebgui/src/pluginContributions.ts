import type { WebPluginCatalog, WebPluginCatalogPlugin } from "./pluginCatalogClient";

export type WebPluginCatalogStatus = "idle" | "loading" | "ready" | "unavailable";

type JsonRecord = Record<string, unknown>;

const webHostCapabilities = new Set([
  "web.navigation",
  "web.page",
  "web.command",
  "web.theme",
  "web.settings.renderer",
  "web.status.renderer",
  "web.settings.desktop",
  "web.status.speech",
  "web.status.performance"
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function controlledSymbol(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized === value && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized) ? normalized : "";
}

function requiredCapabilities(value: JsonRecord): readonly string[] | undefined {
  if (value.requiredCapabilities === undefined) return [];
  if (!Array.isArray(value.requiredCapabilities)) return undefined;
  const capabilities = value.requiredCapabilities.map(controlledSymbol);
  if (capabilities.some(capability => !capability) || new Set(capabilities).size !== capabilities.length) {
    return undefined;
  }
  return capabilities;
}

function activeWebPlugins(catalog: WebPluginCatalog): ReadonlyMap<string, WebPluginCatalogPlugin> {
  const plugins = new Map<string, WebPluginCatalogPlugin>();
  const ambiguousInstances = new Set<string>();
  for (const plugin of catalog.plugins) {
    const instanceId = controlledSymbol(plugin.instanceId);
    const pluginId = controlledSymbol(plugin.pluginId);
    if (
      !instanceId
      || !pluginId
      || plugin.status !== "active"
      || pluginId !== controlledSymbol(plugin.manifest.id)
      || !plugin.manifest.hosts.includes("web")
      || ambiguousInstances.has(instanceId)
    ) {
      continue;
    }
    if (plugins.has(instanceId)) {
      plugins.delete(instanceId);
      ambiguousInstances.add(instanceId);
      continue;
    }
    plugins.set(instanceId, plugin);
  }
  return plugins;
}

export function availableWebContributions(catalog: WebPluginCatalog): readonly unknown[] {
  const activePlugins = activeWebPlugins(catalog);
  return catalog.contributions.filter((value) => {
    if (!isRecord(value)) return false;
    const instanceId = controlledSymbol(value.instanceId);
    const pluginId = controlledSymbol(value.pluginId);
    const owner = instanceId ? activePlugins.get(instanceId) : undefined;
    if (!owner || !pluginId || owner.pluginId !== pluginId) return false;
    if (!Array.isArray(value.hosts) || !value.hosts.every(host => typeof host === "string") || !value.hosts.includes("web")) return false;
    const required = requiredCapabilities(value);
    return required !== undefined && required.every(capability => webHostCapabilities.has(capability));
  });
}
