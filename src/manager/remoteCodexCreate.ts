import { createHash, randomUUID } from "node:crypto";
import { normalizeAgentThreadInitialDeliveryRequest, type AgentThreadRequest, type AgentThreadRequestResult } from "../agentThreads.js";
import { currentOperationContext } from "../observability/dataMutationAudit.js";
import { normalizeEndpointExecutionOptions } from "../agentRequests/executionOptions.js";
import { assertAgentThreadTargetSelection } from "./instanceThreadRouting.js";
import type { EndpointDeliveryOptions } from "../agentRequests/endpointDelivery.js";
import { sourceScopedAgentDeliveryId, stableAgentEndpointIdentity } from "../agentRequests/endpoint.js";
import { AgentThreadContractError, callerAgentDeliveryId } from "../agentRequests/requestValidation.js";
import { agentIdentityForMessageSource, normalizeRabiMessageSource } from "../shared/rabiMessage.js";
import { normalizeAgentInstanceBinding } from "../shared/agentInstance.js";
import { lexicalWorkspaceKey } from "../codexTaskIdentity.js";
import { normalizeCodexThreadTitle } from "../shared/codexThreadTitle.js";
import { createCodexThreadWithReservation } from "../codexThreadCreationReservations.js";
import { CodexCreationIntentConflictError, CodexMetadataNotStartedError } from "../codexThreadCreationReservations.js";
import type { CallerCreationMetadataStatus } from "../callerCreationMetadata.js";

type MetadataRequest = AgentThreadRequest & { creationIntent: { callerKey: string; intentHash: string } };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Original Manager owns source proof and the immutable caller intent; metadata never executes its initial prompt. */
export async function createRemoteCodexAndDeliver(params: {
  rootDir: string;
  request: AgentThreadRequest;
  endpoint: Pick<EndpointDeliveryOptions, "resolveSource" | "authorize">;
  metadataStatus(binding: NonNullable<AgentThreadRequest["instanceBinding"]>, callerKey: string): Promise<CallerCreationMetadataStatus>;
  createMetadata(request: MetadataRequest): Promise<CallerCreationMetadataStatus>;
  sendPrepared(request: AgentThreadRequest): Promise<AgentThreadRequestResult>;
}): Promise<AgentThreadRequestResult> {
  const rawRequest = params.request;
  assertAgentThreadTargetSelection(rawRequest);
  normalizeEndpointExecutionOptions({ ...(rawRequest.cwd !== undefined ? { cwd: rawRequest.cwd } : {}), ...(rawRequest.model !== undefined ? { model: rawRequest.model } : {}), ...(rawRequest.reasoningEffort !== undefined ? { reasoningEffort: rawRequest.reasoningEffort } : {}), ...(rawRequest.sandbox !== undefined ? { sandbox: rawRequest.sandbox } : {}), ...(rawRequest.dshDeliveryMode !== undefined ? { dshDeliveryMode: rawRequest.dshDeliveryMode } : {}) });
  if (rawRequest.dshDeliveryMode !== undefined) throw new Error("dshDeliveryMode is only supported by DSH.");
  const request = normalizeAgentThreadInitialDeliveryRequest(rawRequest), binding = normalizeAgentInstanceBinding(request.instanceBinding);
  const explicitCallerId = callerAgentDeliveryId(request.deliveryId);
  // The existing HTTP owner assigns and exposes requestId before this handler. Capture it once;
  // a later request without the original returned ID is a new intent, never an automatic recovery.
  const operationId = currentOperationContext()?.requestId ?? randomUUID();
  const callerId = explicitCallerId ?? `auto-${createHash("sha256").update(operationId).digest("hex")}`;
  try {
  if (request.action !== "create" || request.agentAdapter !== "codex" || !binding || (request.instanceBinding && "ownerDeviceId" in request.instanceBinding && request.instanceBinding.ownerDeviceId) || !request.prompt) {
    throw new AgentThreadContractError("Remote Codex create with an initial message requires its explicit computer and complete initial message.", "deliveryId", "validation", "Keep the original caller ID and complete create intent.");
  }
  const source = await params.endpoint.resolveSource(request);
  const messageSource = normalizeRabiMessageSource(request.messageSource), identity = agentIdentityForMessageSource(messageSource);
  if (!source.endpoint || !identity || identity.sessionId !== source.threadId || identity.agentAdapter !== source.agentAdapter
    || request.sourceThreadId !== source.threadId || request.sourceAgentType !== source.agentType) {
    throw new AgentThreadContractError("Create source must match the admitted original task owner.", "messageSource", "source_verification", "Restore the original source owner; do not substitute another source.");
  }
  params.endpoint.authorize(source.endpoint, "source");
  const title = normalizeCodexThreadTitle(String(request.title || "")), workspace = lexicalWorkspaceKey(String(request.cwd || ""));
  const semantic = {
    source: stableAgentEndpointIdentity(source.endpoint), sourceAgentType: source.agentType,
    target: { binding, provider: request.agentAdapter, title, workspace },
    messageSource: messageSource.type === "plan" ? { type: messageSource.type, planId: messageSource.planId, planName: messageSource.planName } : { type: messageSource.type },
    prompt: request.prompt, contextBlocks: request.contextBlocks ?? [], controlBlocks: request.controlBlocks ?? [],
    responsePolicy: request.responsePolicy, responseInstruction: request.responseInstruction,
    inReplyToRequestId: request.inReplyToRequestId, result: request.result, nextAction: request.nextAction, messageProcessing: request.messageProcessing,
    execution: { cwd: request.cwd, model: request.model, reasoningEffort: request.reasoningEffort, sandbox: request.sandbox, dshDeliveryMode: request.dshDeliveryMode }
  };
  const hash = createHash("sha256").update(JSON.stringify(canonical(semantic))).digest("hex");
  const callerKey = sourceScopedAgentDeliveryId(source.endpoint, callerId);
  let statusPromise: Promise<CallerCreationMetadataStatus> | undefined;
  const readStatus = () => statusPromise ??= Promise.resolve().then(async () => {
    const status = await params.metadataStatus(binding, callerKey);
    params.endpoint.authorize(source.endpoint!, "source");
    if (!status || status.protocolVersion !== 1 || status.callerKey !== callerKey) throw new Error("The original target SDK does not support caller-bound metadata creation receipts; no metadata create was attempted.");
    if (status.state !== "absent" && status.intentHash !== hash) throw new CodexCreationIntentConflictError();
    return status;
  });
  const completedThread = (receipt: CallerCreationMetadataStatus) => {
    if (receipt.protocolVersion !== 1 || receipt.callerKey !== callerKey || receipt.intentHash !== hash || receipt.state !== "completed" || !receipt.thread?.id || receipt.threadId !== receipt.thread.id) throw new Error("Original caller metadata receipt did not identify its completed task.");
    return receipt.thread;
  };
  const metadataRequest: MetadataRequest = { action: "create", agentAdapter: "codex", instanceBinding: binding,
    creationIntent: { callerKey, intentHash: hash }, title, cwd: request.cwd, sandbox: request.sandbox, model: request.model, reasoningEffort: request.reasoningEffort };
  const created = await createCodexThreadWithReservation({ rootDir: params.rootDir, title, workspace,
    callerIntent: { key: callerKey, hash },
    recoverCreated: async () => { const status = await readStatus(); return status.state === "completed" ? completedThread(status) : undefined; },
    // A lost remote metadata acknowledgement cannot be proved absent by local title search.
    // Preserve its exact reservation instead of performing another remote create.
    create: async onStage => {
      params.endpoint.authorize(source.endpoint!, "source");
      let status: CallerCreationMetadataStatus;
      try { status = await readStatus(); }
      catch (error) { throw new CodexMetadataNotStartedError(error instanceof Error ? error.message : String(error)); }
      if (!["absent", "failed_before_create", "completed"].includes(status.state)) {
        if (status.threadId) onStage("thread_created", status.threadId);
        throw new Error("Original SDK metadata creation remains in progress or uncertain; preserve its caller receipt instead of creating another task.");
      }
      const thread = status.state === "completed" ? completedThread(status) : completedThread(await params.createMetadata(metadataRequest));
      onStage("thread_created", thread.id);
      return { id: thread.id, title: String(thread.title ?? title), cwd: typeof thread.cwd === "string" ? thread.cwd : request.cwd,
        updatedAt: String(thread.updatedAt ?? ""), source: "original-native-metadata", initialTurnStatus: "not-requested" };
    }
  });
  params.endpoint.authorize(source.endpoint, "source");
  const delivery = await params.sendPrepared({ ...request, action: "send", threadId: created.id, instanceBinding: binding, deliveryId: callerId });
  return { statusCode: delivery.statusCode, data: { ...delivery.data, action: "create", callerDeliveryId: callerId, thread: created,
    initialTurnStatus: delivery.data.status === "delivered" ? "started" : "unconfirmed" } };
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { callerDeliveryId: callerId });
    throw error;
  }
}
