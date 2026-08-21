import type http from "node:http";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type {
  AgentThreadRequest,
  AgentThreadRequestOptions,
  AgentThreadRequestResult
} from "../agentThreads.js";
import type {
  MessageProcessingBoardStore,
  MessageProcessingRequirement
} from "../messageProcessing/board.js";
import type { ManagerOperationalEvent, ManagerOperationalLog } from "./operationalLog.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import type { ManagerPluginRouteHandler } from "./managerPluginRouteRegistry.js";

export type AgentThreadControlRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  agentRequests: AgentRequestStore;
  messageProcessingBoard: Pick<MessageProcessingBoardStore, "submitOutcome" | "recordHandoffReturned">;
  applyManagedAgentThreadDefaults: (request: AgentThreadRequest) => AgentThreadRequest;
  agentThreadRequestOptions: (
    request: AgentThreadRequest,
    extra?: Partial<AgentThreadRequestOptions>
  ) => AgentThreadRequestOptions;
  handleAgentThreadRequest: (
    request: AgentThreadRequest,
    options: AgentThreadRequestOptions
  ) => Promise<AgentThreadRequestResult>;
  agentThreadRequestFailureData: (
    error: unknown,
    request?: Pick<AgentThreadRequest, "action" | "sourceAgentType">
  ) => Record<string, unknown>;
  setMessageProcessingPlanBaseline: (
    requirement: MessageProcessingRequirement,
    roleId?: string,
    planId?: string
  ) => void;
  refreshAgentRequestReminderTimers: () => void;
  publishManagerEvent: (eventType: string, data: unknown) => void;
  operationalLog: Pick<ManagerOperationalLog, "record">;
  operationalError: (error: unknown) => ManagerOperationalEvent["error"];
};

export type AgentThreadControlRoutes = {
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

async function handleAgentThreadBody(
  body: AgentThreadRequest,
  response: http.ServerResponse,
  context: AgentThreadControlRoutesContext
): Promise<void> {
  const managedBody = context.applyManagedAgentThreadDefaults(body);
  try {
    const result = await context.handleAgentThreadRequest(
      managedBody,
      context.agentThreadRequestOptions(managedBody, {
        agentRequests: context.agentRequests,
        onMessageProcessingHandoff: (event) => {
          const item = context.messageProcessingBoard.submitOutcome(event.requirementId, {
            decision: "handoff",
            decidedByThreadId: event.sourceThreadId,
            targetAgentType: event.targetAgentType,
            targetThreadId: event.targetThreadId,
            planId: event.planId,
            planTitle: event.planTitle
          });
          context.setMessageProcessingPlanBaseline(item, item.source.roleId, event.planId);
          context.publishManagerEvent("message_processing_board_changed", {
            requirementId: item.id,
            status: item.status
          });
        }
      })
    );

    const communication = result.data.communication && typeof result.data.communication === "object"
      ? result.data.communication as Record<string, unknown>
      : undefined;
    const repliedRequestId = String(communication?.inReplyToRequestId || "").trim();
    let handoffReturnWarning = "";
    if (repliedRequestId) {
      const repliedRequest = context.agentRequests.get(repliedRequestId);
      if (repliedRequest?.status === "responded" && repliedRequest.messageProcessingRequirementId) {
        try {
          const item = context.messageProcessingBoard.recordHandoffReturned(
            repliedRequest.messageProcessingRequirementId,
            repliedRequest.target.threadId
          );
          context.publishManagerEvent("message_processing_board_changed", {
            requirementId: item.id,
            status: item.status
          });
        } catch (error) {
          handoffReturnWarning = `Agent response was accepted, but the message-processing publisher could not be resumed: ${errorMessage(error)}`;
          context.operationalLog.record("warn", "agent_response_handoff_return_failed", {
            result: "tracking_failed",
            requestId: repliedRequestId,
            action: repliedRequest.messageProcessingRequirementId,
            error: context.operationalError(error)
          });
        }
      }
    }

    context.refreshAgentRequestReminderTimers();
    if (communication) context.publishManagerEvent("agent_requests_changed", communication);
    if (handoffReturnWarning) {
      result.data.ok = false;
      result.data.status = "delivered_tracking_failed";
      result.data.warning = [String(result.data.warning || "").trim(), handoffReturnWarning]
        .filter(Boolean)
        .join(" ");
      result.data.handoffReturn = {
        status: "tracking_failed",
        error: {
          stage: "message_processing_return_tracking",
          message: handoffReturnWarning,
          retryable: true
        }
      };
    }

    context.jsonResponse(response, result.statusCode, {
      code: result.data.ok === false ? -1 : 0,
      ...result.data
    });
  } catch (error) {
    context.jsonResponse(response, 400, {
      code: -1,
      ...context.agentThreadRequestFailureData(error, managedBody)
    });
  }
}

function handleAgentThreads(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentThreadControlRoutesContext,
  trackOperation: TrackOperation
): boolean {
  if (requestUrl.pathname !== "/api/agent/threads"
    || (request.method !== "GET" && request.method !== "POST")) {
    return false;
  }

  const requestBody = request.method === "GET"
    ? Promise.resolve<AgentThreadRequest>({
        action: "list",
        query: requestUrl.searchParams.get("query") ?? "",
        limit: Number(requestUrl.searchParams.get("limit") ?? "100"),
        offset: Number(requestUrl.searchParams.get("offset") ?? "0")
      })
    : context.readJsonBody<AgentThreadRequest>(request);

  trackHandledOperation(requestBody
    .then((body) => handleAgentThreadBody(body, response, context))
    .catch((error) => {
      context.jsonResponse(response, 400, {
        code: -1,
        status: "failed",
        message: errorMessage(error),
        error: {
          stage: "request_body",
          message: errorMessage(error),
          retryable: false
        }
      });
    }), trackOperation);
  return true;
}

export function handleAgentThreadControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: AgentThreadControlRoutesContext,
  trackOperation: TrackOperation = operation => operation
): boolean {
  return handleAgentThreads(request, requestUrl, response, context, trackOperation);
}

/**
 * Creates one activation-scoped route handler. During plugin disposal, unregister
 * `handler` from ManagerPluginRouteRegistry first, then await
 * `stopAcceptingAndDrain()` before releasing task stores or adapter resources.
 */
export function createAgentThreadControlRoutes(
  context: AgentThreadControlRoutesContext
): AgentThreadControlRoutes {
  const requestTracker = new ManagerPluginRequestTracker();
  return {
    handler: requestTracker.wrap((request, requestUrl, response) => (
      handleAgentThreadControlApi(
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
