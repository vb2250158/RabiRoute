import { getTimeoutMs } from "../timeoutSettingsClient";
import type { ApiOperationContract } from "@rabiroute/plugin-sdk";

/** Forwarded by App's existing Manager event stream; the docs page owns no second stream. */
export const API_REFERENCE_CHANGED = "rabiroute:api-reference-changed";

export type ApiReferenceOperation = {
  contract: ApiOperationContract;
  contractDigest: string;
  owner: { instanceId: string };
  access?: { pathPrefix: string; contractHeader: string; contractDigest: string };
};

export type ApiReferenceCatalog = {
  schemaVersion: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  catalogDigest: string;
  catalogRevision: number;
  operations: ApiReferenceOperation[];
  coverage: {
    scope: string;
    globalCoverage: string;
    complete: boolean;
    gaps: { instanceId: string; routeId: string; path?: string; pathPrefix?: string; reason: string }[];
  };
};

type CatalogPage = ApiReferenceCatalog & { nextCursor: string };

export async function readApiReference(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ApiReferenceCatalog> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(getTimeoutMs("webgui.apiReference.read", 15000))]);
  const operations: ApiReferenceOperation[] = [];
  let cursor = "";
  let page: CatalogPage;
  do {
    const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    const response = await fetcher(`/api/agent/help?${query}`, { signal: requestSignal });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(result.message || `API catalog: HTTP ${response.status}`);
    page = result.data;
    if (page.schemaVersion !== "2") throw new Error(`Unsupported API catalog version: ${page.schemaVersion}`);
    operations.push(...page.operations);
    cursor = page.nextCursor;
  } while (cursor);
  // The server binds every cursor to the catalog identity/revision. Publish only a complete read.
  return { ...page, operations };
}

export function apiRequestTemplate(operation: ApiReferenceOperation): string {
  const contract = operation.contract;
  const path = contract.pathTemplate.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
  const query = contract.request.query;
  const requiredQuery = typeof query === "object" && Array.isArray(query.required) ? query.required as string[] : [];
  const suffix = requiredQuery.length ? `?${requiredQuery.map(name => `${encodeURIComponent(name)}={${name}}`).join("&")}` : "";
  const method = contract.method === "*" ? "<HTTP_METHOD>" : contract.method;
  const prefix = (operation.access?.pathPrefix || "").replace(/\/$/, "");
  const lines = [`curl --globoff --request '${method}' \"$MANAGER_BASE_URL${prefix}${path}${suffix}\"`];
  const header = operation.access?.contractHeader || contract.request.contractHeader || "x-rabiroute-api-contract";
  lines.push(`  --header '${header}: ${operation.access?.contractDigest || operation.contractDigest}'`);
  if (contract.request.body.kind === "json") {
    lines.push("  --header 'Content-Type: application/json'", "  --data '<JSON_BODY>'");
  }
  return lines.join(" \\\n");
}
