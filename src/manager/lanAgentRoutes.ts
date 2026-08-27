import type http from "node:http";
import type { LanAgentRegistry } from "./lanAgentRegistry.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

export type LanAgentRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  isReleaseRequestAuthorized: (request: http.IncomingMessage) => boolean;
  registry: LanAgentRegistry;
  releases: LanAgentReleaseStore;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentUnauthorized(response: http.ServerResponse, context: LanAgentRoutesContext): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("www-authenticate", "Bearer realm=\"RabiRoute LAN Agent\"");
  context.jsonResponse(response, 401, {
    code: -1,
    error: "LAN_AGENT_TOKEN_REQUIRED",
    message: "Rabi Agent resource access requires the LAN connection Token."
  });
}

function writeAsset(response: http.ServerResponse, content: Buffer, assetPath: string): void {
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", assetPath.endsWith(".mjs") ? "text/javascript; charset=utf-8" : "application/json; charset=utf-8");
  response.setHeader("content-length", content.byteLength);
  response.end(content);
}

export function handleLanAgentApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: LanAgentRoutesContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/lan-agent/releases/manifest") {
    if (!context.isReleaseRequestAuthorized(request)) {
      agentUnauthorized(response, context);
      return true;
    }
    try {
      context.jsonResponse(response, 200, { code: 0, release: context.releases.manifest() });
    } catch (error) {
      context.jsonResponse(response, 503, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  const releaseAssetMatch = request.method === "GET"
    ? requestUrl.pathname.match(/^\/api\/lan-agent\/releases\/([^/]+)\/([^/]+)\/(.+)$/)
    : null;
  if (releaseAssetMatch) {
    if (!context.isReleaseRequestAuthorized(request)) {
      agentUnauthorized(response, context);
      return true;
    }
    try {
      const version = decodeURIComponent(releaseAssetMatch[1] ?? "");
      const platform = decodeURIComponent(releaseAssetMatch[2] ?? "");
      const assetPath = (releaseAssetMatch[3] ?? "").split("/").map(decodeURIComponent).join("/");
      writeAsset(response, context.releases.readAsset(version, platform, assetPath), assetPath);
    } catch (error) {
      context.jsonResponse(response, 404, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/lan-agent/nodes") {
    const release = context.releases.manifest();
    context.jsonResponse(response, 200, {
      code: 0,
      nodes: context.registry.listNodes(),
      tasks: context.registry.listTasks(100),
      releaseVersion: release.version,
      releasePublicKeySha256: release.publicKeySha256
    });
    return true;
  }

  const nodeMatch = requestUrl.pathname.match(/^\/api\/lan-agent\/nodes\/([^/]+)\/(update|tasks)$/);
  if (request.method === "POST" && nodeMatch) {
    const nodeId = decodeURIComponent(nodeMatch[1] ?? "");
    const action = nodeMatch[2] ?? "";
    void context.readJsonBody<Record<string, unknown>>(request)
      .then(body => {
        if (action === "update") {
          const version = typeof body.version === "string" && body.version.trim()
            ? body.version.trim()
            : context.releases.manifest().version;
          return context.registry.requestUpdate(nodeId, version);
        }
        return context.registry.assignTask({
          nodeId,
          targetAgent: String(body.targetAgent ?? ""),
          message: String(body.message ?? ""),
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          taskId: typeof body.taskId === "string" ? body.taskId : undefined,
          idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined
        });
      })
      .then(result => context.jsonResponse(response, 202, { code: 0, result }))
      .catch(error => context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) }));
    return true;
  }

  return false;
}
