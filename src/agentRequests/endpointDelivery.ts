import { randomUUID } from "node:crypto";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, type EndpointExecutionOptions } from "./executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import { renderRabiDelivery, normalizeRabiMessageSource, agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import { renderAgentReplyParameters } from "./replyParameters.js";
import { renderAgentResponseContent } from "./responseContent.js";
import { agentDeliveryPromptHash, type AgentRequestStore, type AgentRequestParty, type AgentCommunicationPreparation } from "./store.js";
import { sameAgentEndpoint, sameAgentParty, type AgentRequestEndpoint } from "./endpoint.js";

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

export async function executeEndpointAgentDelivery(request: AgentThreadRequest, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
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
  if (request.imagePaths?.length) throw new Error("Endpoint delivery does not transfer local attachment paths.");
  const source = await options.resolveSource(request);
  const target = await options.resolveTarget(request);
  if (!source.endpoint || !target.endpoint || source.endpoint.managerInstanceId !== options.managerInstanceId
    || target.endpoint.managerInstanceId !== options.managerInstanceId) throw new Error("Both parties require verified Manager-owned endpoint identities.");
  const messageSource = normalizeRabiMessageSource(request.messageSource);
  const sourceIdentity = messageSource ? agentIdentityForMessageSource(messageSource) : undefined;
  if (!messageSource || !sourceIdentity || sourceIdentity.sessionId !== source.threadId
    || sourceIdentity.agentAdapter !== source.agentAdapter || request.sourceThreadId !== source.threadId
    || !request.sourceAgentType || request.sourceAgentType !== source.agentType) {
    throw new Error("Message source must match the authenticated complete source session and Agent type.");
  }
  await refreshEndpointIdentities({ source: source.endpoint, target: target.endpoint }, options);
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
  const preparation = options.store.prepare({ source, target, responsePolicy: request.responsePolicy!,
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
      target: target.endpoint, prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions, executionOptionsHash, preparation, state: "prepared" };
    options.store.bindEndpointDelivery(delivery);
    guard(delivery, options)();
  } catch (error) {
    options.store.abort(preparation);
    throw error;
  }
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
