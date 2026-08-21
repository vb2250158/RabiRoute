import type http from "node:http";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export type DiagnosticsRoutesContext = {
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  metaPayload: () => unknown;
  gatewayDiagnosticsPayload: () => unknown;
};

export type DiagnosticsRoutes = {
  handler: ManagerPluginRouteHandler;
  stopAcceptingAndDrain: () => Promise<void>;
  activeRequestCount: () => number;
};

function handleDiagnosticsApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: DiagnosticsRoutesContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/meta") {
    context.jsonResponse(response, 200, context.metaPayload());
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/gateways") {
    context.jsonResponse(response, 200, context.gatewayDiagnosticsPayload());
    return true;
  }

  return false;
}

/**
 * Creates one activation-scoped diagnostics route handler. During plugin
 * disposal, unregister `handler` first, then await `stopAcceptingAndDrain()`.
 */
export function createDiagnosticsRoutes(
  context: DiagnosticsRoutesContext
): DiagnosticsRoutes {
  const requestTracker = new ManagerPluginRequestTracker();
  return {
    handler: requestTracker.wrap((request, requestUrl, response) => (
      handleDiagnosticsApi(request, requestUrl, response, context)
    )),
    stopAcceptingAndDrain: () => requestTracker.stop(),
    activeRequestCount: () => requestTracker.activeCount()
  };
}
