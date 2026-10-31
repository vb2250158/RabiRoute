import type http from "node:http";
import { createHash } from "node:crypto";

// Hash only immutable discovery data, never generatedAt, filters or runtime authority.
function discoveryDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
import type { AgentSendRequest } from "../agentSend.js";
import { createAgentSendOperations, agentSendCapabilities, agentSendError, runAgentSend } from "./agentSendOperations.js";
import { listAgentApiOperations } from "./agentApiPolicy.js";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentSendTraceQuery } from "./agentSendIdempotency.js";
import { type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { createAgentQqDiagnosticsOperation, handleAgentQqDiagnostics, type AgentQqDiagnosticsContext } from "./agentQqDiagnostics.js";
import { createAgentReceiptMaintenanceOperations, runAgentReceiptMaintenance, agentReceiptMaintenanceFailure } from "./agentSendReceiptOperations.js";
import { createAgentCommunicationRecordOperations, readAgentRequests, readAgentRequest, cancelAgentRequest, readAgentSendTraces } from "./agentCommunicationRecordOperations.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { createAgentChatHistoryOperation, readAgentChatHistoryResult } from "./agentChatHistoryOperation.js";
import { createAgentGroupFilesOperation, handleAgentGroupFiles, type AgentGroupFilesContext } from "./agentGroupFiles.js";
import { createQqMessageOperations, handleQqMessageRoutes, type QqMessageRoutesContext } from "./qqMessageRoutes.js";
import { createQqStickerOperations, handleQqStickerRoutes } from "./qqStickerRoutes.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";
import { createAgentDeliveryRecordOperations, readDeliveryRecords, type DeliveryRecordsContext } from "./agentDeliveryRecords.js";

export type AgentCommunicationHttpResponse = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type AgentCommunicationRoutesContext = {
  readNodeDeliveryRecords?: DeliveryRecordsContext["readNodeDeliveryRecords"];
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  receiptResponse: (deliveryId: string) => AgentCommunicationHttpResponse;
  findSendTraces: (query: AgentSendTraceQuery) => unknown[];
  send: (request: AgentSendRequest, options?: { remoteSource?: TrustedLanAgentSource; requestAuthority?: () => void }) => Promise<AgentCommunicationHttpResponse>;
  readChatHistory?: (url: URL) => Promise<unknown>;
  // Host owns authorization, original-request binding and trusted evidence callbacks.
  maintenance?: {
    verify: (deliveryId: string, originalRequest: AgentSendRequest, options: { remoteSource?: TrustedLanAgentSource; requestAuthority?: () => void }) => Promise<AgentCommunicationHttpResponse>;
    settle: (deliveryId: string, originalRequest: AgentSendRequest, options: { remoteSource?: TrustedLanAgentSource; requestAuthority?: () => void }) => Promise<AgentCommunicationHttpResponse>;
  };
  agentRequests: AgentRequestStore;
  refreshAgentRequestReminderTimers: () => void;
  publishManagerEvent: (eventType: string, data: unknown) => void;
  qqDiagnostics: AgentQqDiagnosticsContext;
  groupFiles: AgentGroupFilesContext;
  qqMessages?: QqMessageRoutesContext;
};

export type AgentCommunicationRoutes = {
  handler: ManagerPluginRouteHandler;
  operations: readonly ApiOperationDefinition[];
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
  const deliveryMatch = requestUrl.pathname.match(/^\/api\/agent\/deliveries(?:\/([^/]+))?$/);
  if (request.method === "GET" && deliveryMatch) {
    trackHandledOperation(readDeliveryRecords(context, requestUrl, deliveryMatch[1] ? decodeURIComponent(deliveryMatch[1]) : undefined)
      .then(result => { context.jsonResponse(response, result.status, result.body); }), trackOperation);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/agent/chat-history") {
    trackHandledOperation(readAgentChatHistoryResult(request, requestUrl, context)
      .then(result => { context.jsonResponse(response, result.status, result.body); }), trackOperation);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/agent/requests") {
    trackHandledOperation(readAgentRequests(requestUrl, context)
      .then(result => { context.jsonResponse(response, result.status, result.body); }), trackOperation);
    return true;
  }

  const requestMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)$/);
  if (request.method === "GET" && requestMatch) {
    const requestId = decodeURIComponent(requestMatch[1]);
    const result = readAgentRequest(requestId, context);
    context.jsonResponse(response, result.status, result.body);
    return true;
  }

  const cancelMatch = requestUrl.pathname.match(/^\/api\/agent\/requests\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const requestId = decodeURIComponent(cancelMatch[1]);
    trackHandledOperation(context.readJsonBody(request)
      .then(body => cancelAgentRequest(requestId, body, context))
      .then(result => { context.jsonResponse(response, result.status, result.body); })
      .catch(error => { context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) }); }), trackOperation);
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

function handleReceiptMaintenance(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext,
  trackOperation: TrackOperation
): boolean {
  const match = requestUrl.pathname.match(/^\/api\/agent\/send\/receipts\/([^/]+)\/(verify|settle)$/);
  if (request.method !== "POST" || !match) return false;
  trackHandledOperation(Promise.resolve().then(async () => {
    const action = match[2] as "verify" | "settle";
    let result;
    try {
      const id = decodeURIComponent(match[1]);
      const body = context.maintenance && typeof context.maintenance[action] === "function" ? await context.readJsonBody(request) : undefined;
      result = await runAgentReceiptMaintenance(request, requestUrl, id, action, body, context);
    } catch {
      result = agentReceiptMaintenanceFailure(400, "AGENT_SEND_MAINTENANCE_FAILED", "Receipt maintenance failed; read the original receipt before further action.");
    }
    context.jsonResponse(response, result.status, result.body);
  }), trackOperation);
  return true;
}

function handleTraces(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext
): boolean {
  if (request.method !== "GET" || requestUrl.pathname !== "/api/agent/send/traces") return false;

  const result = readAgentSendTraces(requestUrl, context);
  context.jsonResponse(response, result.status, result.body);
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
  const result = agentSendCapabilities();
  context.jsonResponse(response, result.status, result.body);
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
    .then(body => runAgentSend(request, body, context))
    .catch(agentSendError)
    .then(result => { context.jsonResponse(response, result.status, result.body); }), trackOperation);
  return true;
}

export function handleAgentCommunicationApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentCommunicationRoutesContext,
  trackOperation: TrackOperation = operation => operation
): boolean {
  if (context.qqMessages && handleQqStickerRoutes(request, requestUrl, response, context.qqMessages, trackOperation)) return true;
  if (context.qqMessages && handleQqMessageRoutes(request, requestUrl, response, context.qqMessages, trackOperation)) return true;
  if (request.method === "GET" && requestUrl.pathname === "/api/agent/qq/diagnostics") {
    trackHandledOperation(handleAgentQqDiagnostics(request, requestUrl, response, context.qqDiagnostics).then(() => undefined), trackOperation);
    return true;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/agent/qq/group-files") {
    trackHandledOperation(handleAgentGroupFiles(request, requestUrl, response, context.groupFiles).then(() => undefined), trackOperation);
    return true;
  }
  return handleAgentRequests(request, requestUrl, response, context, trackOperation)
    || handleReceiptMaintenance(request, requestUrl, response, context, trackOperation)
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
    operations: [createAgentChatHistoryOperation(context), createAgentQqDiagnosticsOperation(context.qqDiagnostics), createAgentGroupFilesOperation(context.groupFiles),
      ...(context.qqMessages ? [...createQqMessageOperations(context.qqMessages), ...createQqStickerOperations(context.qqMessages)] : []),
      ...createAgentSendOperations(context), ...createAgentReceiptMaintenanceOperations(context), ...createAgentCommunicationRecordOperations(context), ...createAgentDeliveryRecordOperations(context)],
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
