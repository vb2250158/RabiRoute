import path from "node:path";
import type http from "node:http";
import type { GenerationRuntime, PluginGeneration } from "../plugin-kernel/index.js";
import type { WebPluginModule } from "./webPluginModules.js";

export type PluginReconciliationApiContext = {
  diagnostics?: () => readonly unknown[];
  reconcile?: () => Promise<PluginGeneration>;
};
export type PluginCatalogApiContext = {
  runtime: GenerationRuntime;
  reconciliation?: PluginReconciliationApiContext;
  webModules?: {
    list(): Promise<readonly WebPluginModule[]> | readonly WebPluginModule[];
    read(id: string, rev: string, relativePath: string): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string }>>;
  };
};
function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.setHeader("cache-control", "no-store");
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function reconciliationPayload(context: PluginCatalogApiContext): object {
  const generation = context.runtime.current();
  return {
    schemaVersion: 1,
    state: generation.readiness.state === "ready" ? "idle" : "degraded",
    readiness: generation.readiness,
    active: generation.records.filter(record => record.status === "active").map(record => record.identity.instanceId),
    waiting: generation.records.filter(record => record.status === "waiting_dependency").map(record => record.identity.instanceId),
    failed: generation.records.filter(record => record.status === "failed").map(record => record.identity.instanceId),
    diagnostics: [...(context.reconciliation?.diagnostics?.() ?? [])]
  };
}
function contributionPayload(generation: PluginGeneration, host?: "web" | "desktop") {
  const pluginIds = new Map(generation.records.map(record => [record.identity.instanceId, record.identity.pluginId]));
  return generation.contributions.contributions.flatMap(contribution => {
    const value = contribution.value && typeof contribution.value === "object" && !Array.isArray(contribution.value)
      ? contribution.value as Record<string, unknown> : {};
    const hosts = Array.isArray(value.hosts) ? value.hosts.filter(item => typeof item === "string") as string[] : [];
    if (host && !hosts.includes(host)) return [];
    return [Object.freeze({ instanceId: contribution.instanceId, pluginId: pluginIds.get(contribution.instanceId) ?? "", kind: contribution.kind, id: contribution.id, ...value })];
  });
}
export function handlePluginCatalogApi(request: http.IncomingMessage, requestUrl: URL, response: http.ServerResponse, context: PluginCatalogApiContext): boolean {
  if (requestUrl.pathname === "/api/plugins/reconciliation") {
    if (request.method === "GET") { jsonResponse(response, 200, { code: 0, data: reconciliationPayload(context) }); return true; }
    if (request.method === "POST" && context.reconciliation?.reconcile) {
      void context.reconciliation.reconcile().then(() => jsonResponse(response, 200, { code: 0, data: reconciliationPayload(context) }))
        .catch(error => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." }); return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/plugins/modules") {
    void Promise.resolve(context.webModules?.list() ?? []).then(modules => jsonResponse(response, 200, { code: 0, data: { schemaVersion: 1, modules } }))
      .catch(error => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  const moduleMatch = requestUrl.pathname.match(/^\/api\/plugins\/modules\/([^/]+)\/([a-f0-9]{64})\/(.+)$/);
  if (request.method === "GET" && moduleMatch) {
    if (!context.webModules) { jsonResponse(response, 404, { code: -1, message: "Web plugin module was not found." }); return true; }
    let id = "", relativePath = "";
    try { id = decodeURIComponent(moduleMatch[1]!); relativePath = decodeURIComponent(moduleMatch[3]!); }
    catch { jsonResponse(response, 400, { code: -1, message: "Web plugin module path is invalid." }); return true; }
    void context.webModules.read(id, moduleMatch[2]!, relativePath).then(({ source, path: sourcePath }) => {
      const extension = path.extname(sourcePath).toLowerCase();
      const contentType = extension === ".css" ? "text/css; charset=utf-8" : extension === ".js" || extension === ".mjs" ? "text/javascript; charset=utf-8" : "application/octet-stream";
      response.setHeader("cache-control", "public, max-age=31536000, immutable"); response.setHeader("x-content-type-options", "nosniff");
      response.writeHead(200, { "content-type": contentType }); response.end(source);
    }).catch(error => jsonResponse(response, (error as { code?: string }).code === "ENOENT" ? 404 : 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.method !== "GET" || requestUrl.pathname !== "/api/plugins/catalog") return false;
  const requestedHost = requestUrl.searchParams.get("host");
  if (requestedHost && requestedHost !== "web" && requestedHost !== "desktop") { jsonResponse(response, 400, { code: -1, message: "Plugin catalog host must be web or desktop." }); return true; }
  const generation = context.runtime.current();
  const contributions = contributionPayload(generation, requestedHost as "web" | "desktop" | undefined);
  jsonResponse(response, 200, { code: 0, data: {
    schemaVersion: 2, generation: generation.id, host: requestedHost || "all",
    revision: { plugins: generation.sequence, contributions: generation.contributions.revision },
    plugins: generation.records.map(record => ({
      instanceId: record.identity.instanceId, pluginId: record.identity.pluginId,
      manifest: {
        id: record.manifest.id,
        version: record.manifest.version,
        kind: "package",
        hosts: Object.keys(record.manifest.entries),
        capabilities: record.manifest.provides
      },
      host: record.identity.host, scope: "global", status: record.status, missingCapabilities: record.missingCapabilities,
      ...(record.error ? { error: record.error } : {})
    })),
    contributions
  }});
  return true;
}
