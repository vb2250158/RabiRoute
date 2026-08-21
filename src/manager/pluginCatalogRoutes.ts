import type http from "node:http";
import type { RabiContributionHost } from "../runtime/contributionRegistry.js";
import type { ManagerPluginRuntimeMount } from "../runtime/managerPluginRuntime.js";

export type PluginCatalogApiContext = {
  runtime: ManagerPluginRuntimeMount;
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

export function handlePluginCatalogApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PluginCatalogApiContext
): boolean {
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
