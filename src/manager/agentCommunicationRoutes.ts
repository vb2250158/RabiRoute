import type http from "node:http";
import type { AgentSendRequest } from "../agentSend.js";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentSendTraceQuery } from "./agentSendIdempotency.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export type AgentCommunicationHttpResponse = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type AgentCommunicationRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  receiptResponse: (deliveryId: string) => AgentCommunicationHttpResponse;
  findSendTraces: (query: AgentSendTraceQuery) => unknown[];
  send: (request: AgentSendRequest) => Promise<AgentCommunicationHttpResponse>;
  agentRequests: AgentRequestStore;
  refreshAgentRequestReminderTimers: () => void;
  publishManagerEvent: (eventType: string, data: unknown) => void;
};

export type AgentCommunicationRoutes = {
  handler: ManagerPluginRouteHandler;
  stopAcceptingAndDrain: () => Promise<void>;
  activeRequestCount: () => number;
};

type TrackOperation = <T>(operation: Promise<T>) => Promise<T>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackHandledOperation(operation: Promise<void>, trackOperation: TrackOperation): void {
  void trackOperation(operation).catch(() => undefined);
}

function handleAgentRequests(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext,
  trackOperation: TrackOperation
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/agent/requests") {
    const status = requestUrl.searchParams.get("status")?.trim();
    const requests = context.agentRequests.list().filter(item => !status || item.status === status);
    context.jsonResponse(response, 200, { code: 0, data: { requests } });
    return true;
  }

  const requestMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)$/);
  if (request.method === "GET" && requestMatch) {
    const requestId = decodeURIComponent(requestMatch[1]);
    const item = context.agentRequests.get(requestId);
    if (!item) {
      context.jsonResponse(response, 404, { code: -1, message: `Agent request not found: ${requestId}` });
      return true;
    }
    context.jsonResponse(response, 200, { code: 0, data: item });
    return true;
  }

  const cancelMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const requestId = decodeURIComponent(cancelMatch[1]);
    trackHandledOperation(context.readJsonBody<{ reason?: string }>(request)
      .then(body => context.agentRequests.cancel(requestId, body.reason))
      .then(data => {
        context.refreshAgentRequestReminderTimers();
        context.publishManagerEvent("agent_requests_changed", { requestId: data.id, status: data.status });
        context.jsonResponse(response, 200, { code: 0, data });
      })
      .catch(error => {
        context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
      }), trackOperation);
    return true;
  }

  return false;
}

function handleReceipt(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext
): boolean {
  const match = requestUrl.pathname.match(/^\/api\/agent\/send\/receipts\/([^/]+)$/);
  if (request.method !== "GET" || !match) return false;

  const result = context.receiptResponse(decodeURIComponent(match[1]));
  context.jsonResponse(response, result.statusCode, {
    code: result.statusCode < 400 ? 0 : -1,
    ...result.body
  });
  return true;
}

function handleTraces(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/agent/send/traces") return false;

  try {
    const matches = context.findSendTraces({
      channel: requestUrl.searchParams.get("channel"),
      sentMessageId: requestUrl.searchParams.get("sentMessageId"),
      routeId: requestUrl.searchParams.get("routeId")
    });
    context.jsonResponse(response, 200, { code: 0, data: { matches } });
  } catch (error) {
    context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
  }
  return true;
}

function handleSend(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext,
  trackOperation: TrackOperation
): boolean {
  if (request.method !== "POST" || requestUrl.pathname !== "/api/agent/send") return false;

  trackHandledOperation(context.readJsonBody<AgentSendRequest>(request)
    .then(body => context.send(body))
    .then(result => {
      context.jsonResponse(response, result.statusCode, {
        code: result.body.ok ? 0 : -1,
        ...result.body
      });
    })
    .catch(error => {
      context.jsonResponse(response, 400, {
        code: -1,
        ok: false,
        status: "blocked",
        message: errorMessage(error)
      });
    }), trackOperation);
  return true;
}

export function handleAgentCommunicationApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext,
  trackOperation: TrackOperation = operation => operation
): boolean {
  return handleAgentRequests(request, requestUrl, response, context, trackOperation)
    || handleReceipt(request, requestUrl, response, context)
    || handleTraces(request, requestUrl, response, context)
    || handleSend(request, requestUrl, response, context, trackOperation);
}

/**
 * Creates one activation-scoped Agent communication route handler. During plugin
 * disposal, unregister `handler` first, then await `stopAcceptingAndDrain()`
 * before releasing Outbox, approval, receipt, or message-processing services.
 */
export function createAgentCommunicationRoutes(
  context: AgentCommunicationRoutesContext
): AgentCommunicationRoutes {
  const requestTracker = new ManagerPluginRequestTracker();
  return {
    handler: requestTracker.wrap((request, requestUrl, response) => (
      handleAgentCommunicationApi(
        request,
        requestUrl,
        response,
        context,
        operation => requestTracker.trackOperation(operation)
      )
    )),
    stopAcceptingAndDrain: () => requestTracker.stop(),
    activeRequestCount: () => requestTracker.activeCount()
  };
}
