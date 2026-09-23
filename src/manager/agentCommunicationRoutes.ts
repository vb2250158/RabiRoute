import type http from "node:http";
import { createHash } from "node:crypto";

// Hash only immutable discovery data, never generatedAt, filters or runtime authority.
function discoveryDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
import { AGENT_SEND_CHANNEL_HELP, AGENT_SEND_REQUEST_CONTRACT, type AgentSendRequest } from "../agentSend.js";
import { listAgentApiOperations } from "./agentApiPolicy.js";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentSendTraceQuery } from "./agentSendIdempotency.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
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
  send: (request: AgentSendRequest, options?: { remoteSource?: TrustedLanAgentSource }) => Promise<AgentCommunicationHttpResponse>;
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

function handleAgentHelp(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/agent/help") return false;
  const catalog = listAgentApiOperations();
  const allowedQueryParameters = catalog.find(operation => operation.method === "GET" && operation.pathTemplate === requestUrl.pathname)!.queryParameters;
  const invalidQuery = [...requestUrl.searchParams.keys()].some(key =>
    !allowedQueryParameters.includes(key)
    || requestUrl.searchParams.getAll(key).length !== 1
    || !requestUrl.searchParams.get(key)?.trim()
  );
  if (invalidQuery) {
    context.jsonResponse(response, 400, {
      code: -1, errorCode: "AGENT_HELP_INVALID_QUERY",
      message: "Help filters must be supported, nonempty and single-valued.",
      help: { method: "GET", path: "/api/agent/help", allowedQueryParameters },
      repair: "Use operationId, path and/or method once each, or omit all filters to list the catalog. Do not put credentials in query parameters.",
      retryable: false
    });
    return true;
  }
  const operationId = requestUrl.searchParams.get("operationId")?.trim();
  const pathTemplate = requestUrl.searchParams.get("path")?.trim();
  const method = requestUrl.searchParams.get("method")?.trim().toUpperCase();
  const operations = catalog.filter(operation =>
    (!operationId || operation.id === operationId)
    && (!pathTemplate || operation.pathTemplate === pathTemplate)
    && (!method || operation.method === method)
  );
  if (operationId && operations.length === 0) {
    context.jsonResponse(response, 404, { code: -1, errorCode: "AGENT_HELP_NOT_FOUND", message: "No matching Agent API help entry.", repair: "Refresh GET /api/agent/help and select an exact operationId from data.operations." });
    return true;
  }
  context.jsonResponse(response, 200, {
    code: 0,
    data: {
      schemaVersion: "1",
      contractRevision: "agent-api-help-1",
      catalogDigest: discoveryDigest(catalog),
      generatedAt: new Date().toISOString(),
      operations,
      count: operations.length,
      refreshRule: "Refresh after Manager generation changes or contract errors; do not cache API or channel parameters.",
      errorRule: "Use errorCode/help/repair. On uncertain writes, read the receipt or resource before retrying."
    }
  });
  return true;
}

function handleSendCapabilities(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/agent/send/capabilities") return false;
  context.jsonResponse(response, 200, {
    code: 0,
    data: {
      schemaVersion: "1",
      contractRevision: "agent-send-help-1",
      channelsDigest: discoveryDigest(AGENT_SEND_CHANNEL_HELP),
      requestContractDigest: discoveryDigest(AGENT_SEND_REQUEST_CONTRACT),
      requestContract: AGENT_SEND_REQUEST_CONTRACT,
      generatedAt: new Date().toISOString(),
      channels: AGENT_SEND_CHANNEL_HELP,
      contract: {
        deliveryId: "stable caller-generated ID",
        retryRule: "On timeout or uncertain result, keep the same deliveryId and GET /api/agent/send/receipts/{deliveryId}; do not change channel or resend automatically.",
        qq: "QQ/NapCat uses channel=napcat, params.target=group|private; channel=qq is unsupported."
      }
    }
  });
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
    .then(body => {
      const remoteSource = getTrustedLanAgentSource(request);
      if (hasLanAgentBodyGuard(request) && !remoteSource) {
        throw new Error("Remote Agent trusted source session is unavailable.");
      }
      return context.send(body, { remoteSource });
    })
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
        message: errorMessage(error),
        ...(error && typeof error === "object" ? {
          errorCode: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "AGENT_SEND_CONTRACT_ERROR",
          supportedChannels: Array.isArray((error as { supportedChannels?: unknown }).supportedChannels) ? (error as { supportedChannels: string[] }).supportedChannels : undefined,
          help: Array.isArray((error as { help?: unknown }).help) ? (error as { help: unknown[] }).help : undefined,
          repair: typeof (error as { repair?: unknown }).repair === "string" ? (error as { repair: string }).repair : undefined
        } : {}),
        contract: {
          method: "POST",
          path: "/api/agent/send",
          requiredFields: ["deliveryId", "sender", "routeId", "channel", "params", "payload"],
          senderFields: ["agentType", "sessionId"],
          retryRule: "Keep the same deliveryId; on timeout or uncertain result, GET /api/agent/send/receipts/{deliveryId} before retrying."
        }
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
    || handleAgentHelp(request, requestUrl, response, context)
    || handleSendCapabilities(request, requestUrl, response, context)
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
