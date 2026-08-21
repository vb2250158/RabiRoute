export type WebPluginCatalogRevision = Readonly<{
  plugins: number;
  contributions: number;
}>;

export type WebPluginHost = "manager" | "gateway" | "web" | "desktop" | "worker";

export type WebPluginCatalogPlugin = Readonly<{
  instanceId: string;
  pluginId: string;
  status: "waiting_dependency" | "activating" | "active" | "failed" | "inactive";
  manifest: Readonly<{
    id: string;
    hosts: readonly WebPluginHost[];
    capabilities: readonly string[];
  }>;
}>;

export type WebPluginCatalog = Readonly<{
  schemaVersion: 2;
  generation: string;
  host: "web";
  revision: WebPluginCatalogRevision;
  plugins: readonly WebPluginCatalogPlugin[];
  contributions: readonly unknown[];
}>;

type JsonRecord = Record<string, unknown>;

const pluginStatuses = new Set<WebPluginCatalogPlugin["status"]>([
  "waiting_dependency",
  "activating",
  "active",
  "failed",
  "inactive"
]);
const pluginHosts = new Set<WebPluginHost>(["manager", "gateway", "web", "desktop", "worker"]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Plugin catalog ${field} is invalid.`);
  }
  return value as number;
}

function controlledSymbol(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Plugin catalog ${field} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)) {
    throw new Error(`Plugin catalog ${field} is invalid.`);
  }
  return normalized;
}

function parseSymbols(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Plugin catalog ${field} is invalid.`);
  const symbols = value.map((entry, index) => controlledSymbol(entry, `${field}[${index}]`));
  if (new Set(symbols).size !== symbols.length) throw new Error(`Plugin catalog ${field} is invalid.`);
  return symbols;
}

function parseHosts(value: unknown, field: string): readonly WebPluginHost[] {
  const hosts = parseSymbols(value, field);
  if (!hosts.length || hosts.some(host => !pluginHosts.has(host as WebPluginHost))) {
    throw new Error(`Plugin catalog ${field} is invalid.`);
  }
  return hosts as WebPluginHost[];
}

function parsePlugin(value: unknown, index: number): WebPluginCatalogPlugin {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    throw new Error(`Plugin catalog plugin[${index}] is invalid.`);
  }
  const status = value.status;
  if (typeof status !== "string" || !pluginStatuses.has(status as WebPluginCatalogPlugin["status"])) {
    throw new Error(`Plugin catalog plugin[${index}] status is invalid.`);
  }
  return {
    instanceId: controlledSymbol(value.instanceId, `plugin[${index}] instanceId`),
    pluginId: controlledSymbol(value.pluginId, `plugin[${index}] pluginId`),
    status: status as WebPluginCatalogPlugin["status"],
    manifest: {
      id: controlledSymbol(value.manifest.id, `plugin[${index}] manifest.id`),
      hosts: parseHosts(value.manifest.hosts, `plugin[${index}] manifest.hosts`),
      capabilities: parseSymbols(value.manifest.capabilities, `plugin[${index}] manifest.capabilities`)
    }
  };
}

function responseMessage(value: unknown): string {
  if (!isRecord(value) || typeof value.message !== "string" || !value.message.trim()) return "";
  return value.message.trim();
}

export function parseWebPluginCatalogResponse(value: unknown): WebPluginCatalog {
  if (!isRecord(value) || value.code !== 0 || !isRecord(value.data)) {
    throw new Error(responseMessage(value) || "Plugin catalog response is invalid.");
  }

  const data = value.data;
  if (data.schemaVersion !== 2 || data.host !== "web") {
    throw new Error("Plugin catalog schema or host is unsupported.");
  }
  if (!isRecord(data.revision) || !Array.isArray(data.plugins) || !Array.isArray(data.contributions)) {
    throw new Error("Plugin catalog payload is incomplete.");
  }

  return {
    schemaVersion: 2,
    generation: data.generation === undefined ? "" : controlledSymbol(data.generation, "generation"),
    host: "web",
    revision: {
      plugins: nonNegativeInteger(data.revision.plugins, "plugin revision"),
      contributions: nonNegativeInteger(data.revision.contributions, "contribution revision")
    },
    plugins: data.plugins.map(parsePlugin),
    contributions: [...data.contributions]
  };
}

async function readWebPluginCatalog(): Promise<WebPluginCatalog> {
  const response = await fetch("/api/plugins/catalog?host=web", {
    method: "GET",
    headers: { accept: "application/json" }
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Plugin catalog request failed: HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(responseMessage(body) || `Plugin catalog request failed: HTTP ${response.status}`);
  }
  return parseWebPluginCatalogResponse(body);
}

export const pluginCatalogClient = {
  readWeb: readWebPluginCatalog
};
