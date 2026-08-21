export type WebPluginCatalogRevision = Readonly<{
  plugins: number;
  contributions: number;
}>;

export type WebPluginCatalog = Readonly<{
  schemaVersion: 2;
  host: "web";
  revision: WebPluginCatalogRevision;
  contributions: readonly unknown[];
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Plugin catalog ${field} is invalid.`);
  }
  return value as number;
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
    host: "web",
    revision: {
      plugins: nonNegativeInteger(data.revision.plugins, "plugin revision"),
      contributions: nonNegativeInteger(data.revision.contributions, "contribution revision")
    },
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
