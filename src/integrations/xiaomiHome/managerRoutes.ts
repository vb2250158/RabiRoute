import type http from "node:http";
import {
  XiaomiHomeManagerApiClient,
  XiaomiHomeManagerApiError,
  type XiaomiHomeActionRequest
} from "./managerApi.js";
import type { ManagerPluginRouteHandler } from "../../manager/managerPluginRouteRegistry.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import { XiaomiHomeArtifactStore, type XiaomiHomeArtifactInput } from "./artifactStore.js";
import type { XiaomiHomeArtifactAccess } from "./artifactAccess.js";

export type XiaomiHomeManagerRoutesContext = {
  client: XiaomiHomeManagerApiClient;
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
  artifacts: XiaomiHomeArtifactStore;
  artifactAccess: XiaomiHomeArtifactAccess;
  runtimeHealth?: () => Record<string, unknown>;
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function presentedError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof XiaomiHomeManagerApiError) return { status: error.status, code: error.code, message: error.message };
  return { status: 500, code: "xiaomi_home_integration_error", message: "Xiaomi Home integration failed." };
}

function respond<T>(response: http.ServerResponse, context: XiaomiHomeManagerRoutesContext, operation: Promise<T>, status = 200): void {
  const tracked = context.trackOperation?.(operation) ?? operation;
  void tracked.then(data => context.jsonResponse(response, status, { code: 0, data })).catch(error => {
    const presented = presentedError(error);
    context.jsonResponse(response, presented.status, { code: -1, error: { code: presented.code, message: presented.message } });
  });
}

export function handleXiaomiHomeManagerApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): boolean {
  const root = "/api/agent/xiaomi-home";
  if (!requestUrl.pathname.startsWith(root)) return false;
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    context.jsonResponse(response, 403, { code: -1, error: { code: "xiaomi_home_loopback_required", message: "Xiaomi Home Agent API is available only on loopback." } });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/health`) {
    respond(response, context, context.client.getHealth().then(provider => ({
      ...provider,
      ...(context.runtimeHealth?.() ?? {})
    })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/resources`) {
    respond(response, context, context.client.listResources());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/resources/`)) {
    const resourceId = decodeURIComponent(requestUrl.pathname.slice(`${root}/resources/`.length));
    respond(response, context, context.client.getResource(resourceId));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/action-requests`) {
    const idempotencyKey = String(request.headers["idempotency-key"] || "");
    respond(response, context, context.readJsonBody<XiaomiHomeActionRequest>(request)
      .then(body => context.client.executeAction(body, idempotencyKey)), 202);
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/events`) {
    respond(response, context, context.readJsonBody<{ event: XiaomiHomeEvent; agentRoleId: string }>(request)
      .then(body => context.deliverEvent(body.event, { agentRoleId: body.agentRoleId })), 202);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts`) {
    respond(response, context, Promise.resolve(context.artifacts.list({
      resourceId: requestUrl.searchParams.get("resourceId") || undefined,
      eventKind: requestUrl.searchParams.get("eventKind") || undefined
    })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts/lifecycle`) {
    respond(response, context, Promise.resolve(context.artifacts.lifecycleContract()));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`) && requestUrl.pathname.endsWith("/content")) {
    const encoded = requestUrl.pathname.slice(`${root}/artifacts/`.length, -"/content".length);
    try {
      context.artifactAccess.stream(request, response, decodeURIComponent(encoded));
    } catch (error) {
      const presented = presentedError(error);
      context.jsonResponse(response, presented.status, { code: -1, error: { code: presented.code, message: presented.message } });
    }
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`)) {
    const artifactId = decodeURIComponent(requestUrl.pathname.slice(`${root}/artifacts/`.length));
    const artifact = context.artifacts.get(artifactId);
    if (!artifact) context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_artifact_not_found", message: "Artifact was not found." } });
    else context.jsonResponse(response, 200, { code: 0, data: artifact });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/artifacts`) {
    respond(response, context, context.readJsonBody<XiaomiHomeArtifactInput>(request).then(body => context.artifacts.register(body)), 201);
    return true;
  }
  context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_route_not_found", message: "Xiaomi Home API route was not found." } });
  return true;
}

export function createXiaomiHomeManagerRouteHandler(context: XiaomiHomeManagerRoutesContext): ManagerPluginRouteHandler {
  return (request, requestUrl, response) => handleXiaomiHomeManagerApi(request, requestUrl, response, context);
}
