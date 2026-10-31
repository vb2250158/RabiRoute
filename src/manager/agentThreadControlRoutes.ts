import type http from "node:http";
import type { AgentRequestStore } from "../agentRequests/store.js";
import type {
  AgentThreadRequest,
  AgentThreadRemoteSource,
  AgentThreadRequestOptions,
  AgentThreadRequestResult
} from "../agentThreads.js";
import type {
  MessageProcessingBoardStore,
  MessageProcessingRequirement
} from "../messageProcessing/board.js";
import type { ManagerOperationalEvent, ManagerOperationalLog } from "./operationalLog.js";
import { hasLanAgentBodyGuard, validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import type { EndpointDeliveryOptions } from "../agentRequests/endpointDelivery.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { sourceScopedAgentDeliveryId } from "../agentRequests/endpointDelivery.js";
import { callerAgentDeliveryId } from "../agentRequests/requestValidation.js";

export type AgentThreadControlRoutesContext = {
  getTrustedRemoteSource?: (request: http.IncomingMessage) => AgentThreadRemoteSource | undefined;
  getTrustedDeviceSource?: (request: http.IncomingMessage) => RabiLinkAgentPrincipal | undefined;
  assertCurrent?: () => void;
  agentRequests: AgentRequestStore;
  messageProcessingBoard: Pick<MessageProcessingBoardStore, "submitOutcome" | "recordHandoffReturned">;
  applyManagedAgentThreadDefaults: (request: AgentThreadRequest) => AgentThreadRequest;
  agentThreadRequestOptions: (
    request: AgentThreadRequest,
    extra?: Partial<AgentThreadRequestOptions>
  ) => AgentThreadRequestOptions;
  readEndpointDeliveryOptions?: (
    remoteSource: AgentThreadRemoteSource | undefined,
    requestAuthority: () => void,
    deviceSource?: RabiLinkAgentPrincipal
  ) => EndpointDeliveryOptions | undefined;
  handleAgentThreadRequest: (
    request: AgentThreadRequest,
    options: AgentThreadRequestOptions,
    trustedDeviceSource?: RabiLinkAgentPrincipal
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

export type AgentThreadControlResult = { status: number; body: Record<string, unknown>; mutationOutcome?: "unknown" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleAgentThreadBody(
  body: AgentThreadRequest,
  context: AgentThreadControlRoutesContext,
  remoteSource?: AgentThreadRemoteSource,
  requestAuthority?: () => void,
  trustedDeviceSource?: RabiLinkAgentPrincipal
): Promise<AgentThreadControlResult> {
  // Capture only caller-selected execution fields before Route defaults are applied.
  // The request body cannot supply this internal snapshot itself.
  const callerExecutionOptions = Object.freeze(Object.fromEntries(
    (["cwd", "model", "reasoningEffort", "sandbox", "dshDeliveryMode"] as const)
      .filter(field => Object.prototype.hasOwnProperty.call(body, field))
      .map(field => [field, body[field]])
  )) as NonNullable<AgentThreadRequestOptions["callerExecutionOptions"]>;
  const managedBody = context.applyManagedAgentThreadDefaults(body);
  try {
    const result = await context.handleAgentThreadRequest(
      managedBody,
      context.agentThreadRequestOptions(managedBody, {
        remoteSource, requestAuthority, callerExecutionOptions,
        agentRequests: context.agentRequests,
        onMessageProcessingHandoff: (event) => {
          requestAuthority?.();
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
      }),
      trustedDeviceSource
    );

    try { requestAuthority?.(); }
    catch (error) {
      if (managedBody.action !== "list" && managedBody.action !== "read" && error && typeof error === "object") Object.assign(error, { uncertain: true });
      throw error;
    }
    const communication = result.data.communication && typeof result.data.communication === "object"
      ? result.data.communication as Record<string, unknown>
      : undefined;
    const repliedRequestId = String(communication?.inReplyToRequestId || "").trim();
    let handoffReturnWarning = "";
    if (repliedRequestId) {
      try {
        const repliedRequest = context.agentRequests.get(repliedRequestId);
        if (repliedRequest?.status === "responded" && repliedRequest.messageProcessingRequirementId) {
          const item = context.messageProcessingBoard.recordHandoffReturned(
            repliedRequest.messageProcessingRequirementId,
            repliedRequest.target.threadId
          );
          context.publishManagerEvent("message_processing_board_changed", {
            requirementId: item.id,
            status: item.status
          });
        }
      } catch (error) {
        handoffReturnWarning = `Agent response tracking could not resume the message-processing publisher: ${errorMessage(error)}`;
        context.operationalLog.record("warn", "agent_response_handoff_return_failed", {
          result: "tracking_failed", requestId: repliedRequestId, error: context.operationalError(error)
        });
      }
    }

    if (communication || managedBody.action === "send" || managedBody.action === "reconcile_delivery") {
      try { context.refreshAgentRequestReminderTimers(); }
      catch (error) {
        if (!["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code))) throw error;
        const warning = `Agent request reminder scheduling is unavailable: ${errorMessage(error)}`;
        result.data.warning = [String(result.data.warning || "").trim(), warning].filter(Boolean).join(" ");
        if (result.data.status === "delivered" || result.data.status === "delivered_tracking_failed") {
          result.data.ok = false; result.data.status = "delivered_tracking_failed";
        }
        context.operationalLog.record("warn", "agent_request_reminder_refresh_failed", {
          result: "tracking_failed", requestId: communication?.requestId as string | undefined, error: context.operationalError(error)
        });
      }
    }
    if (communication) context.publishManagerEvent("agent_requests_changed", communication);
    if (handoffReturnWarning) {
      result.data.ok = false;
      if (result.data.status === "delivered" || result.data.status === "delivered_tracking_failed") result.data.status = "delivered_tracking_failed";
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

    return { status: result.statusCode, body: { code: result.data.ok === false ? -1 : 0, ...result.data } };
  } catch (error) {
    const unavailable = ["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code));
    const unknown = unavailable && (error as { commitState?: string }).commitState === "unknown";
    return { status: unavailable ? 503 : 400, ...(unknown ? { mutationOutcome: "unknown" as const } : {}),
      body: { code: -1, ...context.agentThreadRequestFailureData(error, managedBody), ...((error as { uncertain?: boolean })?.uncertain || unknown ? { uncertain: true } : {}) } };
  }
}

export function agentThreadBodyFailure(error: unknown): AgentThreadControlResult {
  const unavailable = ["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code));
  const unknown = unavailable && (error as { commitState?: string }).commitState === "unknown";
  return { status: unavailable ? 503 : 400, ...(unknown ? { mutationOutcome: "unknown" as const } : {}),
    body: { code: -1, status: "failed", message: errorMessage(error), error: { stage: unavailable ? "request_store" : "request_body", message: errorMessage(error), retryable: false,
      ...(unavailable ? { code: (error as { code: string }).code, commitState: unknown ? "unknown" : "not_started" } : {}) },
    ...((error as { uncertain?: boolean })?.uncertain || unknown ? { uncertain: true } : {}) } };
}

/** Business orchestration only; HTTP decoding, tracking and discovery belong to executable registration. */
export function createAgentThreadControlOwner(context: AgentThreadControlRoutesContext) {
  return Object.freeze({
    prepare(request: http.IncomingMessage, signal?: AbortSignal) {
      const remote = context.getTrustedRemoteSource?.(request), device = context.getTrustedDeviceSource?.(request);
      const connectionSource = remote ? Object.freeze({ ...remote }) : undefined;
      const devicePrincipal = device ? Object.freeze({ ...device }) : undefined;
      const guarded = hasLanAgentBodyGuard(request);
      const fence = () => {
        context.assertCurrent?.(); signal?.throwIfAborted();
        assertTrustedLanAgentPrincipal(request); hasAuthenticatedConnectionRequest(request);
        const currentRemote = context.getTrustedRemoteSource?.(request), currentDevice = context.getTrustedDeviceSource?.(request);
        // Saved session context is discovery metadata; connector identity remains authoritative.
        if (Boolean(currentRemote) !== Boolean(connectionSource)
          || (currentRemote && connectionSource && ["nodeId", "agentId", "provider"].some(key => currentRemote[key as keyof AgentThreadRemoteSource] !== connectionSource[key as keyof AgentThreadRemoteSource]))
          || JSON.stringify(currentDevice) !== JSON.stringify(devicePrincipal)) throw new Error("Agent request source connection changed.");
      };
      fence();
      return Object.freeze({
        async lookupCallerDelivery(callerId: string, source: Pick<AgentThreadRequest, "sourceThreadId" | "sourceAgentType" | "messageSource"> = {}): Promise<AgentThreadControlResult> {
          fence();
          const id = callerAgentDeliveryId(callerId);
          if (!id) return { status: 400, body: { code: -1, message: "A valid stable caller delivery ID is required." } };
          const sourceThreadId = source.sourceThreadId ?? connectionSource?.sessionId;
          const messageSource = source.messageSource ?? (connectionSource && sourceThreadId
            ? { type: "agent" as const, agentAdapter: connectionSource.provider, sessionId: sourceThreadId, sessionName: connectionSource.sessionName }
            : undefined);
          // Apply the same explicit source attribution guard as send. Saved connector
          // context may be stale; a query must never prove absence for another task.
          if (connectionSource) validateLanAgentRequestBody(request, { action: "send", sourceThreadId, messageSource });
          const effectiveRemote = connectionSource ? { ...connectionSource, sessionId: sourceThreadId! } : undefined;
          const endpointOptions = context.readEndpointDeliveryOptions?.(effectiveRemote, fence, devicePrincipal);
          if (!endpointOptions) return { status: 503, body: { code: -1, message: "The original delivery owner is unavailable." } };
          const endpoint = (await endpointOptions.resolveSource({ action: "read", ...source,
            sourceThreadId, sourceAgentType: source.sourceAgentType ?? "agent", messageSource })).endpoint;
          fence();
          if (!endpoint) return { status: 400, body: { code: -1, message: "Exact source endpoint identity is required to read an original caller delivery." } };
          endpointOptions.authorize(endpoint, "source");
          const deliveryId = sourceScopedAgentDeliveryId(endpoint, id);
          let delivery: Awaited<ReturnType<AgentRequestStore["readCallerEndpointDelivery"]>>;
          try { delivery = await context.agentRequests.readCallerEndpointDelivery(endpoint, id); fence(); }
          catch (error) {
            fence();
            if (["AGENT_DELIVERY_RESERVATION_EXISTS", "AGENT_DELIVERY_ID_CONFLICT"].includes(String((error as { code?: unknown })?.code))) return { status: 409, body: {
              code: -1, errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE", canSubmitSameIntent: false,
              message: "Original caller delivery evidence is reserved, damaged or ambiguous. Preserve its ID and inspect the original receipts." } };
            if (!["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code))) throw error;
            return { status: 503, body: { code: -1, errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE", canSubmitSameIntent: false,
              message: "The original delivery store cannot prove absence. Preserve the original ID until its evidence is restored." } };
          }
          if (!delivery) {
            if (context.agentRequests.hasEndpointDeliveryReservation(deliveryId)) return { status: 409, body: {
              code: -1, errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE", canSubmitSameIntent: false,
              message: "The original delivery is reserved but its evidence cannot currently be read. Preserve its ID; do not submit another prompt." } };
            if (!context.agentRequests.getEndpointDeliveryEvidenceStatus().available) return { status: 503, body: {
              code: -1, errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE", canSubmitSameIntent: false,
              message: "The original delivery store cannot prove absence. Preserve the original ID until its evidence is restored." } };
            return { status: 404, body: { code: -1, errorCode: "DELIVERY_NOT_RESERVED", canSubmitSameIntent: true,
              message: "No reservation exists for this authenticated source and caller ID. The same intent may be submitted." } };
          }
          endpointOptions.authorize(delivery.source, "source");
          fence();
          return { status: 200, body: { code: 0, data: { deliveryId: delivery.deliveryId, state: delivery.state,
            canSubmitSameIntent: delivery.state === "prepared", ...(delivery.receipt ? { receipt: delivery.receipt } : {}) } } };
        },
        async execute(body: AgentThreadRequest): Promise<AgentThreadControlResult> {
          const sourceEvent = body.action === "send" || (body.action === "create" && Boolean(body.prompt));
          const deviceSource = devicePrincipal?.deviceOwner ? devicePrincipal : undefined;
          const remoteSource = connectionSource && sourceEvent
            ? { ...connectionSource, sessionId: String(body.sourceThreadId ?? ""), sessionName: (body.messageSource?.type === "agent" || body.messageSource?.type === "agent_hook") ? body.messageSource.sessionName : connectionSource.sessionName }
            : connectionSource;
          try {
            fence();
            if (sourceEvent && guarded && !remoteSource && !deviceSource?.deviceOwner) throw new Error("Remote Agent trusted source session is unavailable.");
            const result = await handleAgentThreadBody(body, context, remoteSource, fence, deviceSource);
            try { fence(); }
            catch (error) {
              if (body.action !== "list" && body.action !== "read" && error && typeof error === "object") Object.assign(error, { uncertain: true });
              throw error;
            }
            return result;
          } catch (error) { return agentThreadBodyFailure(error); }
        }
      });
    }
  });
}
export type AgentThreadControlOwner = ReturnType<typeof createAgentThreadControlOwner>;
