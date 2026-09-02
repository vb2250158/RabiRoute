import type http from "node:http";
import {
  XiaomiHomeManagerApiError,
  type XiaomiHomeActionRequest
} from "./managerApi.js";
import type { ManagerPluginRouteHandler } from "../../manager/managerPluginRouteRegistry.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";
import type { XiaomiHomeArtifactInput } from "./artifactStore.js";
import type { XiaomiHomeSettingsUpdate } from "../../shared/xiaomiHomeSettingsContract.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";

export type XiaomiHomeManagerRoutesContext = {
  runtime: XiaomiHomeRuntimeController;
  lifecycleFence: Readonly<{
    applicationGenerationId: string;
    managerInstanceId: string;
  }>;
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
  controlPlaneAccessAllowed?: (request: http.IncomingMessage, requestUrl: URL) => boolean;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function isMessageEndpointConfigurationRequest(request: http.IncomingMessage, requestUrl: URL): boolean {
  const root = "/api/agent/xiaomi-home";
  return (request.method === "GET" && requestUrl.pathname === `${root}/health`)
    || (["GET", "PUT"].includes(request.method || "") && requestUrl.pathname === `${root}/settings`);
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

function requireLifecycleFence(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): boolean {
  const expectedApplicationGenerationId = String(request.headers["x-rabiroute-expected-application-generation-id"] || "").trim();
  const expectedManagerInstanceId = String(request.headers["x-rabiroute-expected-manager-instance-id"] || "").trim();
  if (!expectedApplicationGenerationId || !expectedManagerInstanceId) {
    context.jsonResponse(response, 400, {
      code: -1,
      error: { code: "xiaomi_home_lifecycle_fence_required", message: "Current application generation and Manager instance headers are required." }
    });
    return false;
  }
  if (
    expectedApplicationGenerationId !== context.lifecycleFence.applicationGenerationId
    || expectedManagerInstanceId !== context.lifecycleFence.managerInstanceId
  ) {
    context.jsonResponse(response, 409, {
      code: -1,
      error: { code: "xiaomi_home_lifecycle_fence_stale", message: "Manager lifecycle changed; reload /meta before retrying." }
    });
    return false;
  }
  return true;
}

export function handleXiaomiHomeManagerApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: XiaomiHomeManagerRoutesContext
): boolean {
  const root = "/api/agent/xiaomi-home";
  if (!requestUrl.pathname.startsWith(root)) return false;
  const loopback = isLoopbackAddress(request.socket.remoteAddress);
  const controlPlaneConfigurationAccess = isMessageEndpointConfigurationRequest(request, requestUrl)
    && context.controlPlaneAccessAllowed?.(request, requestUrl) === true;
  if (!loopback && !controlPlaneConfigurationAccess) {
    context.jsonResponse(response, 403, { code: -1, error: { code: "xiaomi_home_loopback_required", message: "Xiaomi Home device and artifact APIs are available only on loopback." } });
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/health`) {
    respond(response, context, context.runtime.health());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/settings`) {
    respond(response, context, Promise.resolve(context.runtime.settings()));
    return true;
  }
  if (request.method === "PUT" && requestUrl.pathname === `${root}/settings`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeSettingsUpdate>(request)
      .then(body => context.runtime.update(body.settings, String(body.revision || ""))));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/resources`) {
    respond(response, context, context.runtime.client.listResources());
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/resources/`)) {
    const resourceId = decodeURIComponent(requestUrl.pathname.slice(`${root}/resources/`.length));
    respond(response, context, context.runtime.client.getResource(resourceId));
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/action-requests`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    const idempotencyKey = String(request.headers["idempotency-key"] || "");
    respond(response, context, context.readJsonBody<XiaomiHomeActionRequest>(request)
      .then(body => context.runtime.client.executeAction(body, idempotencyKey)), 202);
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/events`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<{ event: XiaomiHomeEvent; agentRoleId: string }>(request)
      .then(body => context.deliverEvent(body.event, { agentRoleId: body.agentRoleId })), 202);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts`) {
    respond(response, context, Promise.resolve(context.runtime.artifacts.list({
      resourceId: requestUrl.searchParams.get("resourceId") || undefined,
      eventKind: requestUrl.searchParams.get("eventKind") || undefined
    })));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === `${root}/artifacts/lifecycle`) {
    respond(response, context, Promise.resolve(context.runtime.artifacts.lifecycleContract()));
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`) && requestUrl.pathname.endsWith("/content")) {
    const encoded = requestUrl.pathname.slice(`${root}/artifacts/`.length, -"/content".length);
    try {
      context.runtime.artifactAccess.stream(request, response, decodeURIComponent(encoded));
    } catch (error) {
      const presented = presentedError(error);
      context.jsonResponse(response, presented.status, { code: -1, error: { code: presented.code, message: presented.message } });
    }
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname.startsWith(`${root}/artifacts/`)) {
    const artifactId = decodeURIComponent(requestUrl.pathname.slice(`${root}/artifacts/`.length));
    const artifact = context.runtime.artifacts.get(artifactId);
    if (!artifact) context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_artifact_not_found", message: "Artifact was not found." } });
    else context.jsonResponse(response, 200, { code: 0, data: artifact });
    return true;
  }
  if (request.method === "POST" && requestUrl.pathname === `${root}/artifacts`) {
    if (!requireLifecycleFence(request, response, context)) return true;
    respond(response, context, context.readJsonBody<XiaomiHomeArtifactInput>(request).then(body => context.runtime.artifacts.register(body)), 201);
    return true;
  }
  context.jsonResponse(response, 404, { code: -1, error: { code: "xiaomi_home_route_not_found", message: "Xiaomi Home API route was not found." } });
  return true;
}

export function createXiaomiHomeManagerRouteHandler(context: XiaomiHomeManagerRoutesContext): ManagerPluginRouteHandler {
  return (request, requestUrl, response) => handleXiaomiHomeManagerApi(request, requestUrl, response, context);
}
