import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AgentThreadRequest, AgentThreadRequestOptions, AgentThreadRequestResult, AgentThreadSummary } from "../agentThreads.js";
import type { AgentInstance, AgentInstanceBinding } from "../shared/agentInstance.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import { agentIdentityForMessageSource } from "../shared/rabiMessage.js";
import type { AgentRequestStore, AgentRequestParty } from "../agentRequests/store.js";
import { sameAgentEndpoint, type AgentRequestEndpoint } from "../agentRequests/endpoint.js";
import { executePreparedEndpointDelivery } from "../agentRequests/endpointExecution.js";
import { EndpointTransportReceipts } from "../agentRequests/endpointTransportReceipts.js";
import { executeEndpointOnOwner, recoverEndpointOwnerReceipt } from "../agentRequests/ownerExecution.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "../agentRequests/endpointDelivery.js";
import type { RabiLinkAgentPrincipal } from "./rabiLinkAgentDevices.js";
import { EndpointDeliveryNotSentError, validateEndpointDeliveryNoFrameProof } from "../agentRequests/deliveryFailure.js";

export type PeerAgentRequest = (deviceId: string, method: "GET" | "POST", pathname: string, body?: unknown) => Promise<unknown>;
export type PeerCallerSource = Pick<AgentThreadRequest, "sourceThreadId" | "sourceAgentType" | "messageSource" | "ledgerOwnerDeviceId" | "inReplyToRequestId">;
export type PeerAgentEndpointOptions = {
  managerInstanceId: string;
  localDeviceId(): string;
  scope(): string;
  request: PeerAgentRequest;
  /** Preserve authoritative status/body for caller receipt diagnostics, including 404 and 409. */
  requestResult?: (deviceId: string, method: "GET" | "POST", pathname: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  store: AgentRequestStore;
  receiptDirectory: string;
  readLocal(provider: AgentAdapterType, sessionId: string): Promise<AgentThreadSummary>;
  localOptions(request: AgentThreadRequest): AgentThreadRequestOptions;
  /** Original Manager ingress principal, never a source assertion from JSON. */
  principal(request: IncomingMessage): RabiLinkAgentPrincipal | undefined;
  assertCurrent?(): void;
  executeOwner?: typeof executeEndpointOnOwner;
  recoverOwner?: typeof recoverEndpointOwnerReceipt;
};

type PeerAgentResponse = Record<string, unknown> & { instances?: AgentInstance[]; thread?: AgentThreadSummary;
  receipt?: EndpointDeliveryReceipt; notSent?: unknown; error?: { message?: string } };
const unwrap = (value: unknown): PeerAgentResponse => {
  if (!value || typeof value !== "object") throw new Error("Peer Manager returned no operation result.");
  const result = value as PeerAgentResponse;
  if (result.code === -1 || result.ok === false) throw new Error(String(result.message || result.error?.message || "Peer Manager operation failed."));
  return result;
};

/** Existing application transport supplies trust; this bridge only locates exact execution owners. */
export function createPeerAgentEndpointBridge(options: PeerAgentEndpointOptions) {
  const receipts = new EndpointTransportReceipts(options.receiptDirectory);
  function fence() {
    const scope = options.scope(), device = options.localDeviceId();
    if (!scope || !device) throw new Error("RabiLink connection is unavailable.");
    return () => {
      options.assertCurrent?.();
      if (options.scope() !== scope || options.localDeviceId() !== device) throw new Error("Original RabiLink connection changed.");
    };
  }
  function owns(endpoint: AgentRequestEndpoint): boolean {
    return Boolean(endpoint.ownerDeviceId && endpoint.ownerDeviceId !== options.localDeviceId());
  }
  function endpoint(binding: AgentInstanceBinding, provider: string, sessionId: string): AgentRequestEndpoint {
    return { kind: "instance", managerInstanceId: options.managerInstanceId, instanceId: binding.instanceId, nodeId: binding.instanceId,
      ownerDeviceId: binding.ownerDeviceId, agentId: binding.agentId, provider, sessionId,
      authorizationIncarnation: createHash("sha256").update(JSON.stringify([options.scope(), options.managerInstanceId,
        binding.ownerDeviceId, binding.instanceId, provider, sessionId])).digest("hex") };
  }
  function localEndpoint(ownerDeviceId: string, provider: string, sessionId: string): AgentRequestEndpoint {
    return { kind: 'local', managerInstanceId: options.managerInstanceId, ownerDeviceId,
      agentId: 'local:' + provider, provider, sessionId,
      authorizationIncarnation: createHash('sha256').update(JSON.stringify([options.scope(), options.managerInstanceId,
        ownerDeviceId, provider, sessionId])).digest('hex') };
  }
  function authorize(value: AgentRequestEndpoint) {
    if (!owns(value) || !options.scope() || !sameAgentEndpoint(value, value.kind === "local" ? localEndpoint(value.ownerDeviceId!, value.provider, value.sessionId)
      : endpoint({ ownerDeviceId: value.ownerDeviceId, instanceId: value.instanceId!, agentId: value.agentId }, value.provider, value.sessionId))) throw new Error("Original peer execution owner changed.");
  }
  async function readRemote(value: AgentRequestEndpoint, verifyInstance = false): Promise<AgentThreadSummary> {
    const guard = fence(); authorize(value);
    if (verifyInstance) {
      const catalog = unwrap(await options.request(value.ownerDeviceId!, "GET", "/api/lan-agent/instances")); guard();
      if (!catalog.instances?.some(row => row.local && row.instanceId === value.instanceId)) throw new Error("Peer target does not match the connected Manager's local instance.");
    }
    const response = unwrap(await options.request(value.ownerDeviceId!, "POST", "/api/agent/threads", {
      action: "read", agentAdapter: value.provider, agentTargetId: `local:${value.provider}`, threadId: value.sessionId })); guard();
    if (!response.thread || response.thread.id !== value.sessionId || response.thread.archived) throw new Error("Exact peer task owner is unavailable.");
    authorize(value); return response.thread;
  }
  async function resolveTarget(request: AgentThreadRequest): Promise<AgentRequestParty | undefined> {
    const binding = request.instanceBinding;
    if (!binding?.ownerDeviceId || binding.ownerDeviceId === options.localDeviceId()) return undefined;
    if (!request.agentAdapter || !request.threadId) throw new Error("Peer delivery requires an explicit provider and complete session ID.");
    const value = endpoint(binding, request.agentAdapter, request.threadId), summary = await readRemote(value, true);
    return { endpoint: value, agentAdapter: request.agentAdapter, agentType: request.messageProcessing?.targetAgentType || "agent",
      threadId: summary.id, threadName: summary.title, workspace: summary.cwd };
  }
  /** The stored return address becomes an execution target only when a reply is sent. */
  async function resolveStoredTarget(party: AgentRequestParty): Promise<AgentRequestParty> {
    if (!party.endpoint || !owns(party.endpoint)) throw new Error("An explicit peer target address is required.");
    const address = party.endpoint;
    const target = address.kind === "local" ? localEndpoint(address.ownerDeviceId!, address.provider, address.sessionId)
      : endpoint({ ownerDeviceId: address.ownerDeviceId, instanceId: address.instanceId!, agentId: address.agentId }, address.provider, address.sessionId);
    const summary = await readRemote(target);
    return { ...party, endpoint: target, threadName: summary.title, workspace: summary.cwd };
  }
  async function routeThread(binding: AgentInstanceBinding, request: AgentThreadRequest): Promise<AgentThreadRequestResult> {
    if (!binding.ownerDeviceId) throw new Error("An explicit peer Manager address is required.");
    if (request.action === "send" || request.action === "reconcile_delivery") throw new Error("Peer sends must use the original Manager endpoint ledger.");
    const current = fence();
    const catalog = unwrap(await options.request(binding.ownerDeviceId, "GET", "/api/lan-agent/instances")); current();
    if (!catalog.instances?.some(row => row.local && row.instanceId === binding.instanceId)) throw new Error("Peer instance belongs to another Manager.");
    const { instanceBinding: _outer, ...body } = request;
    const data = unwrap(await options.request(binding.ownerDeviceId, "POST", "/api/agent/threads", {
      ...body, agentTargetId: `local:${request.agentAdapter}` })); current();
    return { statusCode: 200, data };
  }
  async function resolveSource(request: AgentThreadRequest, principal?: RabiLinkAgentPrincipal): Promise<AgentRequestParty | undefined> {
    const identity = request.messageSource && agentIdentityForMessageSource(request.messageSource);
    if (!principal || !identity || identity.agentAdapter === "deviceAgent") return undefined;
    const sessionId = request.sourceThreadId || identity.sessionId;
    return { endpoint: localEndpoint(principal.sourceDeviceId, identity.agentAdapter, sessionId),
      agentAdapter: identity.agentAdapter, agentType: request.sourceAgentType || 'agent',
      threadId: sessionId, threadName: identity.sessionName, ...(identity.workspace ? { workspace: identity.workspace } : {}) };
  }
  async function transport(delivery: PreparedEndpointDelivery, guard: () => void, reconcile: boolean): Promise<EndpointDeliveryReceipt | undefined> {
    const current = fence(); guard(); authorize(delivery.target);
    const result = unwrap(await options.request(delivery.target.ownerDeviceId!, "POST", "/api/agent/prepared-deliveries" + (reconcile ? "/reconcile" : ""),
      { ledgerOwnerDeviceId: options.localDeviceId(), delivery })); current(); guard();
    if (result.notSent) {
      validateEndpointDeliveryNoFrameProof(delivery, result.notSent);
      throw new EndpointDeliveryNotSentError("Peer execution owner proved no prompt frame was sent.", result.notSent);
    }
    return result.receipt;
  }
  async function forwardReply(request: AgentThreadRequest, guard: () => void): Promise<AgentThreadRequestResult | undefined> {
    if (!request.ledgerOwnerDeviceId || request.ledgerOwnerDeviceId === options.localDeviceId()) return undefined;
    const current = fence(); guard();
    const response = await options.request(request.ledgerOwnerDeviceId, "POST", "/api/agent/threads", request); current(); guard();
    const data = response as Record<string, unknown>;
    if (!data || typeof data !== "object") throw new Error("Ledger owner returned no formal reply result.");
    return { statusCode: data.code === -1 ? 400 : data.status === "delivery_unconfirmed" ? 202 : 200, data };
  }
  async function forwardCallerLookup(callerId: string, source: PeerCallerSource, guard: () => void) {
    if (!source.ledgerOwnerDeviceId || source.ledgerOwnerDeviceId === options.localDeviceId()) return undefined;
    const current = fence(); guard();
    const identity = source.messageSource && agentIdentityForMessageSource(source.messageSource);
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries({ sourceThreadId: source.sourceThreadId, sourceAgentType: source.sourceAgentType,
      agentAdapter: identity?.agentAdapter, inReplyToRequestId: source.inReplyToRequestId, ledgerOwnerDeviceId: source.ledgerOwnerDeviceId })) {
      if (value !== undefined) query.set(name, value);
    }
    const pathname = "/api/agent/deliveries/caller/" + encodeURIComponent(callerId) + "?" + query;
    if (options.requestResult) {
      const result = await options.requestResult(source.ledgerOwnerDeviceId, "GET", pathname); current(); guard();
      return result;
    }
    const result = await options.request(source.ledgerOwnerDeviceId, "GET", pathname); current(); guard();
    const body = result as Record<string, unknown>;
    return { status: body.code === -1 ? body.errorCode === "DELIVERY_NOT_RESERVED" ? 404 : 409 : 200, body };
  }
  function prepareExecution(request: IncomingMessage, signal?: AbortSignal) {
    const current = fence(), principal = options.principal(request);
    if (!principal?.deviceOwner || principal.scope !== options.scope()) throw new Error("An authenticated peer Manager connection is required.");
    const guard = () => {
      current(); signal?.throwIfAborted();
      const now = options.principal(request);
      if (!now?.deviceOwner || now.scope !== principal.scope || now.sourceDeviceId !== principal.sourceDeviceId) throw new Error("Original peer caller changed.");
    };
    guard();
    return async (input: { ledgerOwnerDeviceId: string; delivery: PreparedEndpointDelivery }, reconcile: boolean) => {
      guard(); const delivery = input.delivery;
      if (!delivery?.target || delivery.target.ownerDeviceId !== options.localDeviceId()
        || !(delivery.target.kind === 'local' || delivery.target.kind === 'instance'
          && delivery.target.instanceId === options.managerInstanceId && delivery.target.nodeId === options.managerInstanceId))
        throw new Error("Prepared delivery does not target this Manager's exact execution instance.");
      const result = await executePreparedEndpointDelivery(delivery, { endpoint: delivery.target, assertAuthorized: guard,
        readReceipt: value => receipts.readReceipt(value), writeReceipt: (value, receipt) => receipts.writeReceipt(value, receipt),
        readNotSent: value => receipts.readNotSentProof(value), writeNotSent: (value, error) => receipts.writeNotSent(value, error),
        beginAttempt: value => receipts.beginAttempt(value), recoverReceipt: options.recoverOwner ?? recoverEndpointOwnerReceipt,
        send: (value, authorized) => (options.executeOwner ?? executeEndpointOnOwner)(value,
          options.localOptions({ agentAdapter: value.target.provider as AgentAdapterType, threadId: value.target.sessionId }), authorized) }, reconcile);
      guard(); return result;
    };
  }
  return { owns, authorize, resolveTarget, resolveSource, transport, forwardReply, forwardCallerLookup, prepareExecution, routeThread,
    localDeviceId: options.localDeviceId, resolveStoredTarget, refresh: async (value: AgentRequestEndpoint) => { await readRemote(value); } };
}
export type PeerAgentEndpointBridge = ReturnType<typeof createPeerAgentEndpointBridge>;
