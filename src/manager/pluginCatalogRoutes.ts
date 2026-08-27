import path from "node:path";
import type http from "node:http";
import type { RabiContributionHost } from "../runtime/contributionRegistry.js";
import type { ManagerPluginRuntimeMount } from "../runtime/managerPluginRuntime.js";
import type {
  ManagerPluginReconciliationStatus,
  ManagerPluginReconciler
} from "../runtime/managerPluginReconciler.js";
import type { WebPluginModule } from "./webPluginModules.js";

export type PluginReconciliationApiContext = {
  reconciler: ManagerPluginReconciler;
  diagnostics?: () => readonly unknown[];
  reconcile?: () => Promise<ManagerPluginReconciliationStatus>;
};

export type PluginCatalogApiContext = {
  runtime: ManagerPluginRuntimeMount;
  reconciliation?: PluginReconciliationApiContext;
  webModules?: {
    list(): Promise<readonly WebPluginModule[]>;
    read(id: string, rev: string, relativePath: string): Promise<Readonly<{ module: WebPluginModule; source: Buffer; path: string }>>;
  };
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.setHeader("cache-control", "no-store");
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function contributionHost(value: string | null): RabiContributionHost | undefined | null {
  if (value === null || value === "") return undefined;
  if (value === "web" || value === "desktop") return value;
  return null;
}

function reconciliationPayload(context: PluginReconciliationApiContext): object {
  return {
    schemaVersion: 1,
    ...context.reconciler.status(),
    diagnostics: [...(context.diagnostics?.() ?? [])]
  };
}

export function handlePluginCatalogApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PluginCatalogApiContext
): boolean {
  const reconciliationRoute = requestUrl.pathname === "/api/plugins/reconciliation";
  if (reconciliationRoute) {
    if (!context.reconciliation) {
      jsonResponse(response, 503, { code: -1, message: "Plugin reconciliation is unavailable." });
      return true;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/plugins/reconciliation") {
      jsonResponse(response, 200, { code: 0, data: reconciliationPayload(context.reconciliation) });
      return true;
    }
    if (request.method === "POST") {
      if (!context.reconciliation.reconcile) {
        jsonResponse(response, 405, { code: -1, message: "Plugin reconciliation cannot be triggered." });
        return true;
      }
      void context.reconciliation.reconcile()
        .then(() => jsonResponse(response, 200, { code: 0, data: reconciliationPayload(context.reconciliation!) }))
        .catch(error => jsonResponse(response, 500, {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/plugins/modules") {
    if (!context.webModules) {
      jsonResponse(response, 200, { code: 0, data: { schemaVersion: 1, modules: [] } });
      return true;
    }
    void context.webModules.list()
      .then(modules => jsonResponse(response, 200, { code: 0, data: { schemaVersion: 1, modules } }))
      .catch(error => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  const moduleMatch = requestUrl.pathname.match(/^\/api\/plugins\/modules\/([^/]+)\/([a-f0-9]{64})\/(.+)$/);
  if (request.method === "GET" && moduleMatch) {
    if (!context.webModules) {
      jsonResponse(response, 404, { code: -1, message: "Web plugin module was not found." });
      return true;
    }
    let id = "";
    let relativePath = "";
    try {
      id = decodeURIComponent(moduleMatch[1]!);
      relativePath = decodeURIComponent(moduleMatch[3]!);
    } catch {
      jsonResponse(response, 400, { code: -1, message: "Web plugin module path is invalid." });
      return true;
    }
    const rev = moduleMatch[2]!;
    void context.webModules.read(id, rev, relativePath)
      .then(({ source, path: sourcePath }) => {
        const extension = path.extname(sourcePath).toLowerCase();
        const contentType = extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".js" || extension === ".mjs"
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream";
        // The revision is part of the URL and the module content is immutable for that revision.
        // Reusing it avoids re-downloading every active Web Bundle on each WebGUI visit.
        response.setHeader("cache-control", "public, max-age=31536000, immutable");
        response.setHeader("x-content-type-options", "nosniff");
        response.writeHead(200, { "content-type": contentType });
        response.end(source);
      })
      .catch(error => jsonResponse(response, (error as { code?: string }).code === "ENOENT" ? 404 : 500, {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      }));
    return true;
  }

  if (request.method !== "GET" || requestUrl.pathname !== "/api/plugins/catalog") return false;
  const host = contributionHost(requestUrl.searchParams.get("host"));
  if (host === null) {
    jsonResponse(response, 400, {
      code: -1,
      message: "Plugin catalog host must be web or desktop."
    });
    return true;
  }

  const plugins = context.runtime.catalog.snapshot();
  const contributions = context.runtime.contributions.catalog(host);
  jsonResponse(response, 200, {
    code: 0,
    data: {
      schemaVersion: 2,
      generation: context.runtime.generation,
      host: host ?? "all",
      revision: {
        plugins: plugins.revision,
        contributions: contributions.revision
      },
      plugins: plugins.plugins,
      contributions: contributions.contributions
    }
  });
  return true;
}
