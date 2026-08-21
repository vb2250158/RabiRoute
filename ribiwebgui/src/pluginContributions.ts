import type { WebPluginCatalog, WebPluginCatalogPlugin } from "./pluginCatalogClient";

export type WebPluginCatalogStatus = "idle" | "loading" | "ready" | "unavailable";

export type WebContributionVisibility = Readonly<{
  desktopSettings: boolean;
  speechStatus: boolean;
  performanceStatus: boolean;
}>;

type JsonRecord = Record<string, unknown>;

type ControlledContributionDefinition = Readonly<{
  kind: "settings-section" | "status-card";
  surface: "shared.settings" | "shared.status";
  id: string;
  slot: string;
  rendererId: string;
  queryId?: string;
  schemaId?: string;
  readCommandId?: string;
  writeCommandId?: string;
}>;

const webHostCapabilities = new Set([
  "web.navigation",
  "web.settings.desktop",
  "web.status.speech",
  "web.status.performance"
]);

const controlledContributions = {
  desktopSettings: {
    kind: "settings-section",
    surface: "shared.settings",
    id: "desktop-settings",
    slot: "desktop",
    rendererId: "builtin.desktop-settings.v1",
    schemaId: "desktop.settings.v1",
    readCommandId: "manager.desktop-settings.read",
    writeCommandId: "manager.desktop-settings.write"
  },
  speechStatus: {
    kind: "status-card",
    surface: "shared.status",
    id: "speech-status",
    slot: "runtime-status",
    rendererId: "builtin.speech-status.v1",
    queryId: "manager.speech-status"
  },
  performanceStatus: {
    kind: "status-card",
    surface: "shared.status",
    id: "performance-status",
    slot: "runtime-status",
    rendererId: "builtin.performance-status.v1",
    queryId: "manager.performance-status"
  }
} as const satisfies Record<keyof WebContributionVisibility, ControlledContributionDefinition>;

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
  for (const plugin of catalog.plugins) {
    if (
      plugin.status !== "active"
      || plugin.pluginId !== plugin.manifest.id
      || !plugin.manifest.hosts.includes("web")
    ) {
      continue;
    }
    plugins.set(plugin.instanceId, plugin);
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
    if (!Array.isArray(value.hosts) || !value.hosts.includes("web")) return false;
    const required = requiredCapabilities(value);
    return required !== undefined && required.every(capability => webHostCapabilities.has(capability));
  });
}

function matchesControlledContribution(value: unknown, expected: ControlledContributionDefinition): boolean {
  if (!isRecord(value)) return false;
  if (
    value.kind !== expected.kind
    || value.surface !== expected.surface
    || value.id !== expected.id
    || value.slot !== expected.slot
    || value.rendererId !== expected.rendererId
  ) {
    return false;
  }
  if (expected.kind === "status-card") {
    return value.queryId === expected.queryId;
  }
  return value.schemaId === expected.schemaId
    && value.readCommandId === expected.readCommandId
    && value.writeCommandId === expected.writeCommandId;
}

export function resolveWebContributionVisibility(
  contributions: readonly unknown[] | null,
  status: WebPluginCatalogStatus
): WebContributionVisibility {
  if (contributions === null) {
    return {
      desktopSettings: status === "unavailable",
      speechStatus: false,
      performanceStatus: false
    };
  }

  return {
    desktopSettings: contributions.some(value => matchesControlledContribution(value, controlledContributions.desktopSettings)),
    speechStatus: contributions.some(value => matchesControlledContribution(value, controlledContributions.speechStatus)),
    performanceStatus: contributions.some(value => matchesControlledContribution(value, controlledContributions.performanceStatus))
  };
}
