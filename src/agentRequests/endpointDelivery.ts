import type { NativeOwnerDeliveryEvidence } from "./nativeOwnerDelivery.js";
import { createHash, randomUUID } from "node:crypto";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions, type EndpointExecutionOptions } from "./executionOptions.js";
import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import { renderRabiDelivery, normalizeRabiMessageSource } from "../shared/rabiMessage.js";
import { renderAgentReplyParameters } from "./replyParameters.js";
import { renderAgentResponseContent } from "./responseContent.js";
import { agentDeliveryPromptHash, type AgentRequestStore, type AgentRequestParty, type AgentCommunicationPreparation } from "./store.js";
import { normalizeAgentRequestEndpoint, normalizeAgentDeliverySource, agentDeliverySourceForParty, stableAgentEndpointIdentity, agentDeliverySourceIdentity, agentDeliveryCallerSourceIdentity, sourceScopedAgentDeliveryId, sameAgentEndpoint, sameAgentParty, sameAgentPartyAddress, type AgentRequestEndpoint, type AgentDeliverySource } from "./endpoint.js";
export { sourceScopedAgentDeliveryId } from "./endpoint.js";
import { AgentThreadContractError, callerAgentDeliveryId, completeAgentSessionId, normalizeAgentThreadSourceType } from "./requestValidation.js";
import { EndpointDeliveryNotSentError, type EndpointDeliveryNoFrameProof } from "./deliveryFailure.js";

export type PreparedEndpointDelivery = {
  deliveryId: string;
  generation: string;
  source: AgentDeliverySource;
  target: AgentRequestEndpoint;
  prompt: string;
  promptHash: string;
  executionOptionsHash: string;
  executionOptions: EndpointExecutionOptions;
  preparation: AgentCommunicationPreparation;
  state: "prepared" | "dispatching" | "committed" | "cancelled";
  createdAt?: string;
  updatedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  attemptCount?: number;
  retryCount?: number;
  dispatchAttemptId?: string;
  lastNoFrameProof?: EndpointDeliveryNoFrameProof;
  lastError?: { code?: string; message: string };
  blockedReason?: string;
  /** Original caller key (when supplied) and semantic input proof; absent on legacy deliveries. */
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
  /** Original request-lifetime fence; background recovery has no HTTP request. */
  assertRequestCurrent?: () => void;
  authorize: (endpoint: AgentRequestEndpoint, role?: "source" | "target") => void;
  refreshEndpoints?: (identities: Pick<PreparedEndpointDelivery, "source" | "target">, phase?: "prepare" | "dispatch" | "reconcile") => Promise<void>;
  dispatch: (delivery: PreparedEndpointDelivery, assertAuthorized: () => void) => Promise<EndpointDeliveryReceipt>;
  reconcile: (delivery: PreparedEndpointDelivery, assertAuthorized: () => void) => Promise<EndpointDeliveryReceipt | undefined>;
};

/** Identifies which original endpoint failed a fresh owner proof, so pre-send failures report an exact stage. */
export class EndpointVerificationError extends Error {
  readonly role: "source" | "target";
  constructor(role: "source" | "target", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "EndpointVerificationError";
    this.role = role;
    if (cause instanceof Error && (cause as { code?: unknown }).code !== undefined) (this as { code?: unknown }).code = (cause as { code?: unknown }).code;
  }
}

function verificationRole(error: unknown): "source" | "target" | undefined {
  return error instanceof EndpointVerificationError ? error.role
    : error && typeof error === "object" && ((error as { role?: unknown }).role === "source" || (error as { role?: unknown }).role === "target")
      ? (error as { role: "source" | "target" }).role : undefined;
}

async function refreshEndpointIdentities(identities: Pick<PreparedEndpointDelivery, "source" | "target">, options: EndpointDeliveryOptions,
  phase: "prepare" | "dispatch" | "reconcile"): Promise<void> {
  await options.refreshEndpoints?.({ source: Object.freeze({ ...identities.source }), target: Object.freeze({ ...identities.target }) }, phase);
  try { options.authorize(identities.target, "target"); } catch (error) { throw verificationRole(error) ? error : new EndpointVerificationError("target", error); }
}

export function validateEndpointReceipt(delivery: NativeOwnerDeliveryEvidence, receipt: EndpointDeliveryReceipt): void {
  if (!receipt || receipt.accepted !== true || receipt.deliveryId !== delivery.deliveryId
    || receipt.generation !== delivery.generation || receipt.promptHash !== delivery.promptHash
    || receipt.executionOptionsHash !== delivery.executionOptionsHash
    || !sameAgentEndpoint(receipt.endpoint, delivery.target) || !receipt.action || !receipt.transport) {
    throw new Error("Prepared delivery receipt does not match the original endpoint, incarnation, generation and prompt hash.");
  }
}

function guard(delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): () => void {
  return () => {
    options.authorize(delivery.target, "target");
    options.store.assertEndpointDeliveryActive(delivery.deliveryId);
  };
}

/** Nothing crossed the execution boundary: the delivery stays prepared and the same deliveryId may safely retry. */
function notSentResult(delivery: PreparedEndpointDelivery, error: unknown): AgentThreadRequestResult {
  const stage = "target_verification";
  return { statusCode: 503, data: {
    action: "send", ok: false, status: "failed", threadId: delivery.target.sessionId,
    delivery: { deliveryId: delivery.deliveryId, generation: delivery.generation,
      status: "prepared", targetThreadId: delivery.target.sessionId, retryable: true },
    communication: { deliveryId: delivery.deliveryId, requestId: delivery.preparation.requestId,
      inReplyToRequestId: delivery.preparation.inReplyToRequestId, responsePolicy: delivery.preparation.responsePolicy },
    error: { stage, message: error instanceof Error ? error.message : String(error), retryable: true }
  } };
}

function result(delivery: Omit<PreparedEndpointDelivery, "prompt">, confirmed: boolean, error?: unknown): AgentThreadRequestResult {
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

function requestInputHash(request: AgentThreadRequest, source: AgentRequestParty, target: AgentRequestParty,
  callerExecutionOptions?: EndpointDeliveryOptions["callerExecutionOptions"],
  sourceFormat: "current" | "previous-metadata" | "previous-aliases" | "previous-address" = "current"): string {
  const messageSource = normalizeRabiMessageSource(request.messageSource);
  const explicit = callerExecutionOptions ?? request;
  const legacyAliases = sourceFormat === "previous-aliases";
  const legacySourceMetadata = sourceFormat === "previous-metadata" || legacyAliases;
  const sourceAddress = agentDeliverySourceForParty(source)!;
  return createHash("sha256").update(JSON.stringify({
    source: legacySourceMetadata && sourceAddress.kind !== "connection" ? (legacyAliases ? normalizeAgentRequestEndpoint : stableAgentEndpointIdentity)(sourceAddress)
      : JSON.parse((sourceFormat === "previous-address" ? agentDeliverySourceIdentity : agentDeliveryCallerSourceIdentity)(sourceAddress)),
    target: (legacyAliases ? normalizeAgentRequestEndpoint : stableAgentEndpointIdentity)(target.endpoint!),
    ...(legacySourceMetadata ? { sourceAgentType: source.agentType } : {}), targetAgentType: target.agentType,
    messageSource: messageSource.type === "plan" ? { type: messageSource.type, planId: messageSource.planId, planName: messageSource.planName } : { type: messageSource.type },
    prompt: request.prompt, contextBlocks: request.contextBlocks ?? [], controlBlocks: request.controlBlocks ?? [],
    responsePolicy: request.responsePolicy, responseInstruction: request.responseInstruction,
    inReplyToRequestId: request.inReplyToRequestId, result: request.result, nextAction: request.nextAction,
    messageProcessing: request.messageProcessing ? { requirementId: request.messageProcessing.requirementId, outcome: request.messageProcessing.outcome,
      targetAgentType: request.messageProcessing.targetAgentType, planId: request.messageProcessing.planId, planTitle: request.messageProcessing.planTitle } : undefined,
    // Unspecified defaults belong to the original frozen delivery, not the retry's current Route configuration.
    execution: { cwd: explicit.cwd, model: explicit.model, reasoningEffort: explicit.reasoningEffort, sandbox: explicit.sandbox, dshDeliveryMode: explicit.dshDeliveryMode,
      ...(request.grokBotDelivery === undefined ? {} : { grokBotDelivery: request.grokBotDelivery }) }
  })).digest("hex");
}

function matchesRequestHash(original: PreparedEndpointDelivery, request: AgentThreadRequest, options: EndpointDeliveryOptions): boolean {
  return [requestInputHash(request, original.preparation.source, original.preparation.target, options.callerExecutionOptions),
    requestInputHash(request, original.preparation.source, original.preparation.target, options.callerExecutionOptions, "previous-metadata"),
    requestInputHash(request, original.preparation.source, original.preparation.target, options.callerExecutionOptions, "previous-aliases"),
    requestInputHash(request, original.preparation.source, original.preparation.target, options.callerExecutionOptions, "previous-address")]
    .includes(original.requestHash!);
}

async function resumeCallerDelivery(request: AgentThreadRequest, source: AgentRequestParty, target: AgentRequestParty,
  deliveryId: string | undefined, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult | undefined> {
  if (!deliveryId) return undefined;
  const original = await options.store.readCallerEndpointDelivery(agentDeliverySourceForParty(source)!, request.deliveryId!);
  if (!original) return undefined;
  if (original.callerDeliveryId !== request.deliveryId
    || !sameAgentParty(target, original.preparation.target)
    || !matchesRequestHash(original, request, options)) {
    throw new AgentThreadContractError("deliveryId conflicts with the original complete endpoints or request content.", "deliveryId", "validation",
      "Keep the original endpoints and payload on retries; use a new deliveryId only for a new operation.", "AGENT_DELIVERY_ID_CONFLICT");
  }
  return resumeReservedDelivery(original, options);
}

function resumeReservedDelivery(original: PreparedEndpointDelivery, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  guard(original, options)();
  if (original.state === "prepared") return dispatchPreparedDelivery(original, options);
  if (original.state === "dispatching") return reconcileEndpointDelivery(original.deliveryId, options).then(() => {
    const current = options.store.getEndpointDelivery(original.deliveryId)!;
    return result(current, current.state === "committed");
  });
  return Promise.resolve(result(original, original.state === "committed"));
}

function sourceDescription(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.replace(/[\r\n\u2028\u2029]/g, " ").trim().slice(0, limit) || undefined : undefined;
}

function resolvedSourceMetadata(source: AgentRequestParty) {
  return { agentAdapter: source.agentAdapter!, sessionId: source.threadId,
    sessionName: sourceDescription(source.threadName, 500) || sourceDescription(source.endpoint?.agentId, 500) || "Agent",
    workspace: sourceDescription(source.workspace, 2_000), agentType: normalizeAgentThreadSourceType(source.agentType) };
}

function resolvedMessageSource(request: AgentThreadRequest, source: AgentRequestParty) {
  if (source.connection) return { type: "system" as const, eventType: "agent_connection", eventName: "Connected sender",
    eventId: source.connection.id.slice(0, 300), actorType: source.connection.transport,
    actorId: source.connection.id.slice(0, 300), actorName: sourceDescription(source.threadName, 500) };
  const identity = resolvedSourceMetadata(source), declared = request.messageSource;
  if (declared?.type === "plan") {
    const planId = sourceDescription(declared.planId, 500);
    if (planId) return { type: "plan" as const, planId, planName: sourceDescription(declared.planName, 500) || planId, sourceAgent: identity };
  }
  return { ...identity, type: declared?.type === "agent_hook" ? "agent_hook" as const : "agent" as const };
}

function renderEndpointPrompt(request: AgentThreadRequest, source: AgentRequestParty, preparation: AgentCommunicationPreparation,
  executionOptions: EndpointExecutionOptions, sentAt?: string, replyParameters = renderAgentReplyParameters(preparation)): string {
  const content = preparation.inReplyToRequestId ? renderAgentResponseContent(request.prompt || "", preparation.result || "", preparation.nextAction || "") : request.prompt;
  if (typeof content !== "string" || !content.trim() || content.length > 200_000) throw new Error("Endpoint delivery requires a non-empty bounded prompt.");
  const messageSource = resolvedMessageSource(request, source);
  return preparation.target.endpoint!.kind === "service" && preparation.target.endpoint!.provider === "grokBot" && executionOptions.grokBotDelivery
    ? content
    : renderRabiDelivery({ messageSource, messageContent: content, sentAt,
      contextBlocks: request.contextBlocks, controlBlocks: [...(request.controlBlocks ?? []), replyParameters] });
}

/** Old snapshots can prove the original payload without inventing a missing semantic input hash. */
function matchesLegacyReply(request: AgentThreadRequest, delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): boolean {
  const preparation = delivery.preparation;
  if (request.responsePolicy !== preparation.responsePolicy || (request.responseInstruction?.trim() || undefined) !== preparation.responseInstruction
    || request.messageProcessing?.requirementId !== preparation.messageProcessingRequirementId || request.messageProcessing?.planId !== preparation.planId) return false;
  const explicit = options.callerExecutionOptions ?? request;
  const execution = { ...delivery.executionOptions };
  for (const key of ["cwd", "model", "reasoningEffort", "sandbox", "dshDeliveryMode", "grokBotDelivery"] as const) {
    const value = key === "grokBotDelivery" ? request.grokBotDelivery : explicit[key];
    if (value !== undefined) Object.assign(execution, { [key]: value });
  }
  if (endpointExecutionOptionsHash(execution) !== delivery.executionOptionsHash) return false;
  const frozen = delivery.prompt.replace(/\r\n/g, "\n");
  const sentAt = /^(?:- )?(?:投递时间|消息包发送时间)：(.+)$/m.exec(frozen)?.[1];
  const footerAt = frozen.lastIndexOf("[回传参数]\n");
  const direct = delivery.target.kind === "service" && delivery.target.provider === "grokBot" && !!execution.grokBotDelivery;
  if (!direct && (!sentAt || footerAt < 0)) return false;
  // Preserve the original machine-generated footer and timestamp, including historical template versions.
  let prompt = renderEndpointPrompt(request, preparation.source, { ...preparation, result: request.result, nextAction: request.nextAction },
    delivery.executionOptions, sentAt, footerAt < 0 ? "" : frozen.slice(footerAt));
  // Old frozen snapshots must still be compared byte-for-byte using their original envelope.
  if (frozen.startsWith("[消息源]\n") && prompt.startsWith("## 消息源\n")) {
    const boundary = prompt.indexOf("\n\n## 消息内容\n");
    if (boundary >= 0) {
      const header = prompt.slice(0, boundary).split("\n").slice(1).map(line => line.replace(/^- /, ""));
      prompt = ["[消息源]", ...header].join("\n") + "\n\n[消息内容]\n" + prompt.slice(boundary + "\n\n## 消息内容\n".length);
    }
  }
  return agentDeliveryPromptHash(prompt) === delivery.promptHash;
}

async function resumeFormalReply(request: AgentThreadRequest, target: AgentRequestParty, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult | undefined> {
  if (!request.inReplyToRequestId) return undefined;
  const original = options.store.get(request.inReplyToRequestId);
  const deliveryId = original?.pendingResponseDeliveryId ?? original?.response?.deliveryId;
  if (!deliveryId) return undefined;
  const delivery = await options.store.readEndpointDelivery(deliveryId);
  if (!delivery || !sameAgentParty(target, delivery.preparation.target)) {
    throw new Error("Reserved reply lacks exact authenticated endpoint evidence; reconcile the original delivery.");
  }
  if (delivery.requestHash ? !matchesRequestHash(delivery, request, options) : !matchesLegacyReply(request, delivery, options)) {
    throw new AgentThreadContractError("Reply conflicts with its original frozen payload or its legacy evidence cannot establish an exact match.",
      "inReplyToRequestId", "validation", "Keep the original payload and endpoints. Reconcile the original delivery if its legacy evidence is incomplete; do not replace its reservation.",
      "AGENT_DELIVERY_ID_CONFLICT");
  }
  return resumeReservedDelivery(delivery, options);
}

const inflightPreparations = new WeakMap<AgentRequestStore, Map<string, { requestHash: string; result: Promise<AgentThreadRequestResult> }>>();

function prepareSingleDelivery(store: AgentRequestStore, key: string | undefined, requestHash: string,
  prepare: () => Promise<AgentThreadRequestResult>): Promise<AgentThreadRequestResult> {
  if (!key) return prepare();
  let entries = inflightPreparations.get(store);
  if (!entries) inflightPreparations.set(store, entries = new Map());
  const existing = entries.get(key);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new AgentThreadContractError("Concurrent delivery conflicts with the original endpoints or payload.",
      "deliveryId", "validation", "Keep the original endpoints and payload when reconciling the existing delivery.", "AGENT_DELIVERY_ID_CONFLICT");
    return existing.result;
  }
  // Reserve the whole prepare/bind/dispatch workflow before its first async store
  // transaction. Individual durable commands do not form one implicit transaction.
  const pending = Promise.resolve().then(prepare).finally(() => entries!.delete(key));
  entries.set(key, { requestHash, result: pending });
  return pending;
}

export async function executeEndpointAgentDelivery(request: AgentThreadRequest, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  await options.store.ready();
  if (request.action === "reconcile_delivery") {
    const deliveryId = callerAgentDeliveryId(request.deliveryId);
    if (!deliveryId) throw new Error("Reconciliation requires the original delivery ID.");
    const delivery = await options.store.readEndpointDelivery(deliveryId);
    if (!delivery) throw new Error("Original endpoint delivery evidence is unavailable; automatic replay is forbidden.");
    options.assertRequestCurrent?.();
    await reconcileEndpointDelivery(delivery.deliveryId, options, { receiptOnly: true });
    const current = options.store.getEndpointDelivery(delivery.deliveryId)!;
    return result(current, current.state === "committed");
  }
  if (request.action !== "send") throw new Error("Endpoint delivery only supports send and reconcile_delivery.");
  const originalConnectionRequest = request.inReplyToRequestId ? options.store.get(request.inReplyToRequestId) : undefined;
  if (originalConnectionRequest?.source.connection) {
    if (request.responsePolicy !== undefined && request.responsePolicy !== "none" && request.responsePolicy !== "required") throw new AgentThreadContractError("Record-only responsePolicy must be none.",
      "responsePolicy", "validation", "Use none when recording the original request result.");
    if (request.responsePolicy === "required") throw new AgentThreadContractError("A record-only response needs an actual target for a new required follow-up.",
      "responsePolicy", "validation", "Record this response with none; address a new required send to its actual task target.");
    if (originalConnectionRequest.status === "pending_delivery") await reconcileEndpointDelivery(originalConnectionRequest.deliveryId, options, { receiptOnly: true });
    const source = await options.resolveSource({ ...request, sourceAgentType: normalizeAgentThreadSourceType(request.sourceAgentType) });
    const address = agentDeliverySourceForParty(source);
    if (!address) throw new Error("The connected response source is unavailable.");
    const callerId = callerAgentDeliveryId(request.deliveryId) ?? `response:${originalConnectionRequest.id}`;
    const responseId = sourceScopedAgentDeliveryId(address, callerId);
    options.assertRequestCurrent?.();
    const recorded = await options.store.recordConnectionResponse(originalConnectionRequest.id, source, responseId, request.result || "", request.nextAction || "",
      options.assertRequestCurrent);
    try { options.assertRequestCurrent?.(); }
    catch (error) {
      if (error && typeof error === "object") Object.assign(error, { uncertain: true });
      throw error;
    }
    return { statusCode: 200, data: { action: "send", ok: true, status: "response_recorded",
      communication: { deliveryId: recorded.response!.deliveryId, inReplyToRequestId: recorded.id, responsePolicy: "none" }, response: recorded.response } };
  }
  request = { ...request, threadId: completeAgentSessionId(request.threadId, "threadId"),
    sourceAgentType: normalizeAgentThreadSourceType(request.sourceAgentType), responsePolicy: request.responsePolicy === undefined ? "none" : request.responsePolicy };
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
  const sourceAddress = agentDeliverySourceForParty(source);
  if (!sourceAddress || !target.endpoint || target.endpoint.managerInstanceId !== options.managerInstanceId) {
    throw new Error("The current delivery record requires a source address and an exact target endpoint.");
  }
  const sourceEndpoint = normalizeAgentDeliverySource(sourceAddress), targetEndpoint = target.endpoint;
  // Source metadata is attached from the resolver snapshot, never compared as a second admission gate.
  request = { ...request, sourceThreadId: source.threadId, sourceAgentType: source.agentType,
    messageSource: resolvedMessageSource(request, source) };
  await refreshEndpointIdentities({ source: sourceEndpoint, target: target.endpoint }, options, "prepare");
  const stableDeliveryId = callerDeliveryId === undefined ? undefined : sourceScopedAgentDeliveryId(sourceEndpoint, callerDeliveryId);
  const requestHash = requestInputHash(request, source, target, options.callerExecutionOptions);
  return prepareSingleDelivery(options.store, stableDeliveryId ? `delivery:${agentDeliveryCallerSourceIdentity(sourceEndpoint)}:${callerDeliveryId}`
    : request.inReplyToRequestId ? `reply:${request.inReplyToRequestId}` : undefined, requestHash, async () => {
    const resumed = await resumeCallerDelivery(request, source, target, stableDeliveryId, options);
    if (resumed) return resumed;
    if (request.inReplyToRequestId) {
      const original = options.store.get(request.inReplyToRequestId);
      if (original?.status === "pending_delivery" && original.source.endpoint && original.target.endpoint) {
        if (!sameAgentPartyAddress(target, original.source)) {
          throw new Error("Formal reply must use the original request target address.");
        }
        await reconcileEndpointDelivery(original.deliveryId, options);
      }
      const reply = await resumeFormalReply(request, target, options);
      if (reply) return reply;
    }
    const executionOptions = normalizeEndpointExecutionOptions(options.resolveExecutionOptions(request, target));
    const executionOptionsHash = endpointExecutionOptionsHash(executionOptions);
    // An awaited formal-reply reconciliation may have allowed another identical caller to reserve this key.
    const reserved = await resumeCallerDelivery(request, source, target, stableDeliveryId, options);
    if (reserved) return reserved;
    options.assertRequestCurrent?.();
    const preparation = await options.store.prepare({ source, target, responsePolicy: request.responsePolicy!,
      ...(stableDeliveryId ? { deliveryId: stableDeliveryId } : {}),
      responseInstruction: request.responseInstruction, inReplyToRequestId: request.inReplyToRequestId,
      result: request.result, nextAction: request.nextAction,
      messageProcessingRequirementId: request.messageProcessing?.requirementId, planId: request.messageProcessing?.planId });
    let delivery: PreparedEndpointDelivery;
    try {
      const prompt = renderEndpointPrompt(request, source, preparation, executionOptions);
      delivery = { deliveryId: preparation.deliveryId, generation: randomUUID(), source: sourceEndpoint,
        target: targetEndpoint, prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions, executionOptionsHash, preparation, state: "prepared",
        requestHash, ...(callerDeliveryId === undefined ? {} : { callerDeliveryId }) };
      options.assertRequestCurrent?.();
      await options.store.bindEndpointDelivery(delivery);
      guard(delivery, options)();
    } catch (error) {
      await options.store.abort(preparation);
      throw error;
    }
    return dispatchPreparedDelivery(delivery, options);
  });
}

// Pre-send verification is async; concurrent retries of one prepared delivery must share a single dispatch.
const inflightDispatches = new WeakMap<object, Map<string, Promise<AgentThreadRequestResult>>>();

function dispatchPreparedDelivery(delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  let byStore = inflightDispatches.get(options.store);
  if (!byStore) inflightDispatches.set(options.store, byStore = new Map());
  const existing = byStore.get(delivery.deliveryId);
  if (existing) return existing;
  const pending = verifyThenDispatch(delivery, options).finally(() => byStore!.delete(delivery.deliveryId));
  byStore.set(delivery.deliveryId, pending);
  return pending;
}

async function verifyThenDispatch(delivery: PreparedEndpointDelivery, options: EndpointDeliveryOptions): Promise<AgentThreadRequestResult> {
  const assertAuthorized = guard(delivery, options);
  // Verify fresh owner proofs before anything is persisted as dispatching. A failure here sent nothing,
  // so the delivery stays prepared and a retry with the same deliveryId really sends.
  try {
    await refreshEndpointIdentities(delivery, options, "dispatch");
    assertAuthorized();
  } catch (error) {
    await options.store.noteEndpointDeliveryFailure(delivery.deliveryId, error);
    return notSentResult(delivery, error);
  }
  // Persist before crossing the execution boundary. A crash here stays unknown, never resend.
  delivery.dispatchAttemptId = await options.store.markEndpointDispatching(delivery.deliveryId);
  delivery.state = "dispatching";
  try {
    assertAuthorized();
    const receipt = await options.dispatch(delivery, assertAuthorized);
    await refreshEndpointIdentities(delivery, options, "dispatch");
    assertAuthorized();
    validateEndpointReceipt(delivery, receipt);
    await options.store.commitEndpointReceipt(delivery.deliveryId, receipt);
    return result(delivery, true);
  } catch (error) {
    if (error instanceof EndpointDeliveryNotSentError) {
      try {
        await options.store.markEndpointNotSent(delivery.deliveryId, error.proof);
        await options.store.noteEndpointDeliveryFailure(delivery.deliveryId, error);
        delivery.state = "prepared";
        return notSentResult(delivery, error);
      } catch (trackingError) {
        return result(delivery, false, new AggregateError([error, trackingError],
          "Original delivery remains unconfirmed because its no-frame evidence could not be fully recorded. Preserve its existing ID; do not replay."));
      }
    }
    try { await options.store.noteEndpointDeliveryFailure(delivery.deliveryId, error); }
    catch (trackingError) {
      return result(delivery, false, new AggregateError([error, trackingError],
        "Original delivery remains unconfirmed after its execution boundary; secondary tracking failure does not prove that nothing was sent."));
    }
    return result(delivery, false, error);
  }
}

export async function reconcileEndpointDelivery(deliveryId: string, options: EndpointDeliveryOptions, policy: { receiptOnly?: boolean } = {}): Promise<boolean> {
  await options.store.ready();
  const delivery = await options.store.readEndpointDelivery(deliveryId);
  if (!delivery) throw new Error("Original endpoint delivery is unavailable.");
  try {
    const assertAuthorized = guard(delivery, options);
    await refreshEndpointIdentities(delivery, options, "reconcile");
    assertAuthorized();
    if (delivery.state === "committed") return true;
    if (delivery.state !== "dispatching") return false;
    const receipt = await options.reconcile(delivery, assertAuthorized);
    await refreshEndpointIdentities(delivery, options, "reconcile");
    assertAuthorized();
    if (!receipt) return false;
    validateEndpointReceipt(delivery, receipt);
    await options.store.commitEndpointReceipt(deliveryId, receipt);
    return true;
  } catch (error) {
    try {
      if (!policy.receiptOnly && error instanceof EndpointDeliveryNotSentError && options.store.getEndpointDelivery(deliveryId)?.state === "dispatching") {
        await options.store.markEndpointNotSent(deliveryId, error.proof);
      }
      await options.store.noteEndpointDeliveryFailure(deliveryId, error);
    } catch (trackingError) {
      throw Object.assign(new AggregateError([error, trackingError],
        `Original delivery reconciliation remains unconfirmed: ${trackingError instanceof Error ? trackingError.message : String(trackingError)}`), {
        code: "AGENT_REQUEST_COMMIT_UNKNOWN", statusCode: 503, commitState: "unknown", retryable: false
      });
    }
    throw error;
  }
}

/** Events reconcile unknown attempts; a bounded timer retries only prepared host reservations. */
export class EndpointDeliveryRecovery {
  private readonly active = new Map<string, Promise<boolean>>();
  private readonly pendingEvents = new Set<string>();
  private executing = 0;
  private readonly waiters: Array<() => void> = [];
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private started = false;
  private starting?: Promise<void>;
  private releaseReadinessWait?: () => void;
  private stopped = false;
  private readonly minimumDelayMs: number;
  private readonly maximumBatchSize: number;
  constructor(private readonly options: EndpointDeliveryOptions, policy: { minimumDelayMs?: number; maximumBatchSize?: number } = {}) {
    this.minimumDelayMs = Math.max(10, policy.minimumDelayMs ?? 1_000);
    this.maximumBatchSize = Math.max(1, Math.min(16, policy.maximumBatchSize ?? 16));
  }
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.starting ??= (async () => {
      await Promise.race([this.options.store.ready(), new Promise<void>(resolve => { this.releaseReadinessWait = resolve; })]);
      this.releaseReadinessWait = undefined;
      if (this.started || this.stopped) return;
      this.started = true;
      this.unsubscribe = this.options.store.onEndpointDeliveryChange(() => this.schedule());
      this.schedule();
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.releaseReadinessWait?.();
    this.releaseReadinessWait = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.starting?.catch(() => {});
    await Promise.allSettled([...this.active.values()]);
  }
  private retryablePrepared() {
    return this.options.store.listEndpointDeliveryMetadata().filter(delivery => delivery.state === "prepared"
      && (delivery.target.kind === "local" || delivery.target.kind === "instance") && !delivery.blockedReason && !this.active.has(delivery.deliveryId));
  }
  private schedule(): void {
    if (!this.started || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active.size >= this.maximumBatchSize) return;
    const records = this.retryablePrepared();
    if (!records.length) return;
    const dueAt = records.reduce((earliest, record) => Math.min(earliest,
      Number.isFinite(Date.parse(record.nextAttemptAt ?? "")) ? Date.parse(record.nextAttemptAt!) : Date.now()), Infinity);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const due = this.retryablePrepared().filter(record => !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= Date.now())
        .sort((left, right) => (left.nextAttemptAt ?? "").localeCompare(right.nextAttemptAt ?? ""))
        .slice(0, Math.max(0, this.maximumBatchSize - this.active.size));
      void Promise.allSettled(due.map(record => this.recover(record.deliveryId))).finally(() => this.schedule());
    }, Math.max(this.minimumDelayMs, Math.min(2_147_483_647, dueAt - Date.now())));
    this.timer.unref?.();
  }
  recover(deliveryId: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const existing = this.active.get(deliveryId);
    if (existing) return existing;
    // Publish the single flight before entering it, including synchronous stop/read failures.
    const recovery = Promise.resolve().then(async () => {
      if (this.executing >= this.maximumBatchSize) await new Promise<void>(resolve => this.waiters.push(resolve));
      else this.executing++;
      try {
        let recovered = false, failed = false, failure: unknown, passes = 0;
        do {
          this.pendingEvents.delete(deliveryId);
          if (this.stopped) return false;
          try {
            const delivery = await this.options.store.readEndpointDelivery(deliveryId);
            if (this.stopped) return false;
            recovered = delivery?.state === "prepared"
              ? await dispatchPreparedDelivery(delivery, this.options).then(value => value.statusCode === 200)
              : await reconcileEndpointDelivery(deliveryId, this.options, { receiptOnly: true });
            failed = false;
          } catch (error) { failed = true; failure = error; }
          // Only external recovery events request another pass. Store failure updates
          // merely schedule prepared work and cannot create an unknown-receipt loop.
        } while (++passes < 2 && !this.stopped && this.pendingEvents.has(deliveryId));
        if (failed) throw failure;
        return recovered;
      } finally {
        // Retire synchronously with the last pass, so an event cannot attach to a
        // completed flight after its pending-event check but before cleanup.
        const pendingEvent = this.pendingEvents.delete(deliveryId);
        this.active.delete(deliveryId);
        const next = this.waiters.shift();
        if (next) next(); else this.executing--;
        this.schedule();
        // A hot target gets one coalesced pass per flight, then releases its slot.
        // Remaining real events requeue once so other targets can make progress.
        if (pendingEvent && !this.stopped) queueMicrotask(() => {
          if (!this.stopped && !this.active.has(deliveryId)) void this.recover(deliveryId).catch(() => {});
        });
      }
    });
    this.active.set(deliveryId, recovery);
    return recovery;
  }
  async onEvent(endpoint?: AgentRequestEndpoint): Promise<void> {
    if (this.stopped) return;
    await this.options.store.ready();
    if (this.stopped) return;
    const candidates = this.options.store.listEndpointDeliveryMetadata()
      .filter(delivery => (delivery.state === "dispatching" || delivery.state === "prepared" && !delivery.blockedReason
        && (endpoint || !delivery.nextAttemptAt || Date.parse(delivery.nextAttemptAt) <= Date.now())) && (!endpoint || sameAgentEndpoint(endpoint, delivery.target)))
      .map(delivery => delivery.deliveryId);
    for (let offset = 0; offset < candidates.length && !this.stopped; offset += this.maximumBatchSize) {
      await Promise.allSettled(candidates.slice(offset, offset + this.maximumBatchSize).map(deliveryId => {
        if (this.active.has(deliveryId)) this.pendingEvents.add(deliveryId);
        return this.recover(deliveryId);
      }));
    }
  }
}
