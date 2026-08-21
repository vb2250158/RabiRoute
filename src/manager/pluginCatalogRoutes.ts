import type http from "node:http";
import type { RabiContributionHost } from "../runtime/contributionRegistry.js";
import type { ManagerPluginRuntimeMount } from "../runtime/managerPluginRuntime.js";
import type {
  ManagerPluginReconciliationStatus,
  ManagerPluginReconciler
} from "../runtime/managerPluginReconciler.js";

export type PluginReconciliationApiContext = {
  reconciler: ManagerPluginReconciler;
  diagnostics?: () => readonly unknown[];
  reconcile?: () => Promise<ManagerPluginReconciliationStatus>;
};

export type PluginCatalogApiContext = {
  runtime: ManagerPluginRuntimeMount;
  reconciliation?: PluginReconciliationApiContext;
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
  const reconciliationRoute = requestUrl.pathname === "/api/plugins/reconciliation"
    || requestUrl.pathname === "/api/plugins/reconcile";
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
