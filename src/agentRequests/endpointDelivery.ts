import { createHash, randomUUID } from "node:crypto";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, type EndpointExecutionOptions } from "./executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import { renderRabiDelivery, normalizeRabiMessageSource, agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import { renderAgentReplyParameters } from "./replyParameters.js";
import { renderAgentResponseContent } from "./responseContent.js";
import { agentDeliveryPromptHash, type AgentRequestStore, type AgentRequestParty, type AgentCommunicationPreparation } from "./store.js";
import { normalizeAgentRequestEndpoint, sameAgentEndpoint, sameAgentParty, type AgentRequestEndpoint } from "./endpoint.js";
import { AgentThreadContractError, callerAgentDeliveryId, completeAgentSessionId, normalizeAgentThreadSourceType } from "./requestValidation.js";

export type PreparedEndpointDelivery = {
  deliveryId: string;
  generation: string;
  source: AgentRequestEndpoint;
  target: AgentRequestEndpoint;
  prompt: string;
  promptHash: string;
  executionOptionsHash: string;
  executionOptions: EndpointExecutionOptions;
  preparation: AgentCommunicationPreparation;
  state: "prepared" | "dispatching" | "committed" | "cancelled";
  /** Original caller key and semantic input proof; optional for legacy deliveries. */
  callerDeliveryId?: string;
  requestHash?: string;
  receipt?: EndpointDeliveryReceipt;
};
export type EndpointDeliveryReceipt = {
  deliveryId: string;
  generation: string;
  endpoint: AgentRequestEndpoint;
  promptHash: string;
  executionOptionsHash: string;
  accepted: true;
  action: string;
  transport: string;
};

/** Resolvers and authorizer are Manager-owned callbacks; request bodies never supply authority. */
export type EndpointDeliveryOptions = {
  store: AgentRequestStore;
  managerInstanceId: string;
  resolveSource: (request: AgentThreadRequest) => Promise<AgentRequestParty> | AgentRequestParty;
  resolveTarget: (request: AgentThreadRequest) => Promise<AgentRequestParty> | AgentRequestParty;
  resolveExecutionOptions: (request: AgentThreadRequest, target: AgentRequestParty) => EndpointExecutionOptions;
  /** Captured from the original HTTP body before Manager defaults; never read as a body authority object. */
  callerExecutionOptions?: Pick<AgentThreadRequest, "cwd" | "model" | "reasoningEffort" | "sandbox" | "dshDeliveryMode">;
  authorize: (endpoint: AgentRequestEndpoint, role?: "source" | "target") => void;
  refreshEndpoints?: (identities: Pick<PreparedEndpointDelivery, "source" | "target">) => Promise<void>;
  dispatch: (delivery: PreparedEndpointDelivery, assertAuthorized: () => void) => Promise<EndpointDeliveryReceipt>;
  reconcile: (delivery: PreparedEndpointDelivery, assertAuthorized: () => void) => Promise<EndpointDeliveryReceipt | undefined>;
};

async function refreshEndpointIdentities(identities: Pick<PreparedEndpointDelivery, "source" | "target">, options: EndpointDeliveryOptions): Promise<void> {
  await options.refreshEndpoints?.({ source: Object.freeze({ ...identities.source }), target: Object.freeze({ ...identities.target }) });
  options.authorize(identities.source, "source");
  options.authorize(identities.target, "target");
}

export function validateEndpointReceipt(delivery: PreparedEndpointDelivery, receipt: EndpointDeliveryReceipt): void {
  if (!receipt || receipt.accepted !== true || receipt.deliveryId !== delivery.deliveryId
    || receipt.generation !== delivery.generation || receipt.promptHash !== delivery.promptHash
    || receipt.executionOptionsHash !== delivery.executionOptionsHash
    || !sameAgentEndpoint(receipt.endpoint, delivery.target) || !receipt.action || !receipt.transport) {
    throw new Error("Prepared delivery receipt does not match the original endpoint, incarnation, generation and prompt hash.");
  }
}

function guard(delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): () => void {
  return () => {
    options.authorize(delivery.source, "source");
    options.authorize(delivery.target, "target");
    options.store.assertEndpointDeliveryActive(delivery.deliveryId);
  };
}

function result(delivery: PreparedEndpointDelivery, confirmed: boolean, error?: unknown): AgentThreadRequestResult {
  return { statusCode: confirmed ? 200 : 202, data: {
    action: "send", ok: confirmed, status: confirmed ? "delivered" : "delivery_unconfirmed",
    threadId: delivery.target.sessionId,
    delivery: { deliveryId: delivery.deliveryId, generation: delivery.generation,
      status: confirmed ? "accepted" : "unconfirmed", targetThreadId: delivery.target.sessionId, retryable: false },
    communication: { deliveryId: delivery.deliveryId, requestId: delivery.preparation.requestId,
      inReplyToRequestId: delivery.preparation.inReplyToRequestId, responsePolicy: delivery.preparation.responsePolicy },
    ...(error ? { error: { stage: "target_delivery", message: error instanceof Error ? error.message : String(error), retryable: false } } : {})
  } };
}

export function sourceScopedAgentDeliveryId(source: AgentRequestEndpoint, callerDeliveryId: string): string {
  // A rebound incarnation must find the original key and fail its owner proof, not start a new operation.
  return `agent-${createHash("sha256").update(JSON.stringify([source.managerInstanceId, source.kind, source.instanceId,
    source.nodeId, source.agentId, source.provider, source.sessionId, callerDeliveryId])).digest("hex")}`;
}

function requestInputHash(request: AgentThreadRequest, source: AgentRequestParty, target: AgentRequestParty,
  callerExecutionOptions?: EndpointDeliveryOptions["callerExecutionOptions"]): string {
  const messageSource = normalizeRabiMessageSource(request.messageSource);
  const explicit = callerExecutionOptions ?? request;
  return createHash("sha256").update(JSON.stringify({
    source: normalizeAgentRequestEndpoint(source.endpoint!), target: normalizeAgentRequestEndpoint(target.endpoint!),
    sourceAgentType: source.agentType, targetAgentType: target.agentType,
    messageSource: messageSource.type === "plan" ? { type: messageSource.type, planId: messageSource.planId, planName: messageSource.planName } : { type: messageSource.type },
    prompt: request.prompt, contextBlocks: request.contextBlocks ?? [], controlBlocks: request.controlBlocks ?? [],
    responsePolicy: request.responsePolicy, responseInstruction: request.responseInstruction,
    inReplyToRequestId: request.inReplyToRequestId, result: request.result, nextAction: request.nextAction,
    messageProcessing: request.messageProcessing ? { requirementId: request.messageProcessing.requirementId, outcome: request.messageProcessing.outcome,
      targetAgentType: request.messageProcessing.targetAgentType, planId: request.messageProcessing.planId, planTitle: request.messageProcessing.planTitle } : undefined,
    // Unspecified defaults belong to the original frozen delivery, not the retry's current Route configuration.
    execution: { cwd: explicit.cwd, model: explicit.model, reasoningEffort: explicit.reasoningEffort, sandbox: explicit.sandbox, dshDeliveryMode: explicit.dshDeliveryMode }
  })).digest("hex");
}

function resumeCallerDelivery(request: AgentThreadRequest, source: AgentRequestParty, target: AgentRequestParty,
  deliveryId: string | undefined, requestHash: string | undefined, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> | undefined {
  if (!deliveryId) return undefined;
  const original = options.store.getEndpointDelivery(deliveryId);
  if (!original) return undefined;
  if (original.callerDeliveryId !== request.deliveryId || original.requestHash !== requestHash
    || !sameAgentParty(source, original.preparation.source) || !sameAgentParty(target, original.preparation.target)) {
    throw new AgentThreadContractError("deliveryId conflicts with the original complete endpoints or request content.", "deliveryId", "validation",
      "Keep the original endpoints and payload on retries; use a new deliveryId only for a new operation.", "AGENT_DELIVERY_ID_CONFLICT");
  }
  guard(original, options)();
  if (original.state === "prepared") return dispatchPreparedDelivery(original, options);
  if (original.state === "dispatching") return reconcileEndpointDelivery(original.deliveryId, options).then(() => {
    const current = options.store.getEndpointDelivery(original.deliveryId)!;
    return result(current, current.state === "committed");
  });
  return Promise.resolve(result(original, original.state === "committed"));
}

export async function executeEndpointAgentDelivery(request: AgentThreadRequest, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  request = { ...request, sourceThreadId: completeAgentSessionId(request.sourceThreadId, "sourceThreadId"),
    sourceAgentType: normalizeAgentThreadSourceType(request.sourceAgentType, true) };
  if (request.action === "reconcile_delivery") {
    const delivery = options.store.getEndpointDelivery(request.deliveryId || "");
    if (!delivery) throw new Error("Original endpoint delivery evidence is unavailable; automatic replay is forbidden.");
    const source = await options.resolveSource(request);
    if (!sameAgentParty(source, delivery.preparation.source) && !sameAgentParty(source, delivery.preparation.target)) {
      throw new Error("Only an original endpoint may reconcile this delivery.");
    }
    await reconcileEndpointDelivery(delivery.deliveryId, options);
    return result(options.store.getEndpointDelivery(delivery.deliveryId)!, options.store.getEndpointDelivery(delivery.deliveryId)?.state === "committed");
  }
  if (request.action !== "send") throw new Error("Endpoint delivery only supports send and reconcile_delivery.");
  request = { ...request, threadId: completeAgentSessionId(request.threadId, "threadId") };
  const callerDeliveryId = callerAgentDeliveryId(request.deliveryId);
  if (request.imagePaths?.length) throw new Error("Endpoint delivery does not transfer local attachment paths.");
  const source = await options.resolveSource(request);
  const resolvedTarget = await options.resolveTarget(request);
  const originalRequest = request.inReplyToRequestId ? options.store.get(request.inReplyToRequestId) : undefined;
  // The original request owns the reply's target role. Fresh resolvers still own its complete endpoint identity.
  const target = originalRequest ? { ...resolvedTarget, agentType: originalRequest.source.agentType } : resolvedTarget;
  if (target.threadId !== request.threadId || (request.agentAdapter && target.agentAdapter !== request.agentAdapter)) {
    throw new AgentThreadContractError("Resolved target does not match the complete requested owner.", "threadId", "validation",
      "Select the exact target adapter and session; a resolver cannot substitute another owner.");
  }
  if (!source.endpoint || !target.endpoint || source.endpoint.managerInstanceId !== options.managerInstanceId
    || target.endpoint.managerInstanceId !== options.managerInstanceId) throw new Error("Both parties require verified Manager-owned endpoint identities.");
  const messageSource = normalizeRabiMessageSource(request.messageSource);
  const sourceIdentity = messageSource ? agentIdentityForMessageSource(messageSource) : undefined;
  if (!messageSource || !sourceIdentity || sourceIdentity.sessionId !== source.threadId
    || sourceIdentity.agentAdapter !== source.agentAdapter || request.sourceThreadId !== source.threadId
    || !request.sourceAgentType || request.sourceAgentType !== source.agentType) {
    throw new AgentThreadContractError("Message source must match the authenticated complete source session and Agent type.",
      "messageSource", "source_verification", "Declare the actual Agent owner or plan.sourceAgent matching sourceThreadId and sourceAgentType; system sources cannot replace that owner.");
  }
  await refreshEndpointIdentities({ source: source.endpoint, target: target.endpoint }, options);
  const stableDeliveryId = callerDeliveryId === undefined ? undefined : sourceScopedAgentDeliveryId(source.endpoint, callerDeliveryId);
  const requestHash = callerDeliveryId === undefined ? undefined : requestInputHash(request, source, target, options.callerExecutionOptions);
  const resumed = resumeCallerDelivery(request, source, target, stableDeliveryId, requestHash, options);
  if (resumed) return resumed;
  if (request.inReplyToRequestId) {
    const original = options.store.get(request.inReplyToRequestId);
    if (original?.status === "pending_delivery" && original.source.endpoint && original.target.endpoint) {
      if (!sameAgentParty(source, original.target) || !sameAgentParty(target, original.source)) {
        throw new Error("Formal reply must reverse the original exact authenticated endpoints.");
      }
      await reconcileEndpointDelivery(original.deliveryId, options);
    }
    if (original?.pendingResponseDeliveryId) {
      // Durable reservation never triggers another dispatch, including after Manager restart.
      const pending = options.store.getEndpointDelivery(original.pendingResponseDeliveryId);
      if (!pending || !sameAgentParty(source, pending.preparation.source) || !sameAgentParty(target, pending.preparation.target)) {
        throw new Error("Pending reply lacks exact authenticated endpoint evidence; reconcile the original delivery.");
      }
      return result(pending, pending.state === "committed");
    }
  }
  const executionOptions = normalizeEndpointExecutionOptions(options.resolveExecutionOptions(request, target));
  const executionOptionsHash = endpointExecutionOptionsHash(executionOptions);
  // An awaited formal-reply reconciliation may have allowed another identical caller to reserve this key.
  const reserved = resumeCallerDelivery(request, source, target, stableDeliveryId, requestHash, options);
  if (reserved) return reserved;
  const preparation = options.store.prepare({ source, target, responsePolicy: request.responsePolicy!,
    ...(stableDeliveryId ? { deliveryId: stableDeliveryId } : {}),
    responseInstruction: request.responseInstruction, inReplyToRequestId: request.inReplyToRequestId,
    result: request.result, nextAction: request.nextAction,
    messageProcessingRequirementId: request.messageProcessing?.requirementId, planId: request.messageProcessing?.planId });
  let delivery: PreparedEndpointDelivery;
  try {
    const content = preparation.inReplyToRequestId ? renderAgentResponseContent(request.prompt || "", preparation.result || "", preparation.nextAction || "") : request.prompt;
    if (typeof content !== "string" || !content.trim() || content.length > 200_000) throw new Error("Endpoint delivery requires a non-empty bounded prompt.");
    const verifiedIdentity = { ...sourceIdentity, sessionName: source.threadName || source.endpoint!.agentId,
      workspace: source.workspace, agentType: source.agentType };
    const verifiedSource = messageSource.type === "plan" ? { ...messageSource, sourceAgent: verifiedIdentity }
      : { ...verifiedIdentity, type: "agent" as const };
    const prompt = renderRabiDelivery({ messageSource: verifiedSource, messageContent: content,
      contextBlocks: request.contextBlocks, controlBlocks: [...(request.controlBlocks ?? []), renderAgentReplyParameters(preparation)] });
    delivery = { deliveryId: preparation.deliveryId, generation: randomUUID(), source: source.endpoint,
      target: target.endpoint, prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions, executionOptionsHash, preparation, state: "prepared",
      ...(callerDeliveryId === undefined ? {} : { callerDeliveryId, requestHash }) };
    options.store.bindEndpointDelivery(delivery);
    guard(delivery, options)();
  } catch (error) {
    options.store.abort(preparation);
    throw error;
  }
  return dispatchPreparedDelivery(delivery, options);
}

async function dispatchPreparedDelivery(delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  // Persist before crossing the execution boundary. A crash here stays unknown, never resend.
  options.store.markEndpointDispatching(delivery.deliveryId);
  delivery.state = "dispatching";
  const assertAuthorized = guard(delivery, options);
  try {
    await refreshEndpointIdentities(delivery, options);
    assertAuthorized();
    const receipt = await options.dispatch(delivery, assertAuthorized);
    await refreshEndpointIdentities(delivery, options);
    assertAuthorized();
    validateEndpointReceipt(delivery, receipt);
    options.store.commitEndpointReceipt(delivery.deliveryId, receipt);
    return result(delivery, true);
  } catch (error) {
    return result(delivery, false, error);
  }
}

export async function reconcileEndpointDelivery(deliveryId: string, options: EndpointDeliveryOptions): Promise<boolean> {
  const delivery = options.store.getEndpointDelivery(deliveryId);
  if (!delivery) throw new Error("Original endpoint delivery is unavailable.");
  const assertAuthorized = guard(delivery, options);
  await refreshEndpointIdentities(delivery, options);
  assertAuthorized();
  if (delivery.state === "committed") return true;
  if (delivery.state !== "dispatching") return false;
  const receipt = await options.reconcile(delivery, assertAuthorized);
  await refreshEndpointIdentities(delivery, options);
  assertAuthorized();
  if (!receipt) return false;
  validateEndpointReceipt(delivery, receipt);
  options.store.commitEndpointReceipt(deliveryId, receipt);
  return true;
}

/** Called on startup, connection/catalog/receipt/turn events, never on an interval. */
export class EndpointDeliveryRecovery {
  private readonly active = new Map<string, Promise<boolean>>();
  constructor(private readonly options: EndpointDeliveryOptions) {}
  recover(deliveryId: string): Promise<boolean> {
    const existing = this.active.get(deliveryId);
    if (existing) return existing;
    const promise = reconcileEndpointDelivery(deliveryId, this.options).finally(() => this.active.delete(deliveryId));
    this.active.set(deliveryId, promise);
    return promise;
  }
  async onEvent(endpoint?: AgentRequestEndpoint): Promise<void> {
    await Promise.allSettled(this.options.store.listEndpointDeliveries()
      .filter(delivery => delivery.state === "dispatching" && (!endpoint || sameAgentEndpoint(endpoint, delivery.target)))
      .map(delivery => this.recover(delivery.deliveryId)));
  }
}
