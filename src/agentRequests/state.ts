import { createHash, randomUUID } from "node:crypto";
import { endpointExecutionOptionsHash } from "./executionOptions.js";
import { normalizeAgentRequestEndpoint, normalizeAgentConnectionSource, normalizeAgentDeliverySource, sameAgentDeliverySource, agentDeliverySourceForParty, sameAgentEndpoint, sameAgentParty, sameAgentPartyAddress, agentDeliveryCallerSourceIdentity, sourceScopedAgentDeliveryId, type AgentRequestEndpoint, type AgentConnectionSource, type AgentDeliverySource } from "./endpoint.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { AgentReplyStateError } from "./replyError.js";
import { validateEndpointDeliveryNoFrameProof, type EndpointDeliveryNoFrameProof } from "./deliveryFailure.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import { parseAgentAdapterType, type AgentAdapterType } from "../agentAdapters/types.js";
import { normalizeRabiMessageContent } from "../shared/rabiMessage.js";
import { AgentThreadContractError, callerAgentDeliveryId } from "./requestValidation.js";
import {
  JsonFileAgentRequestPersistence,
  type AgentRequestPersistence
} from "./persistence.js";
import { recordDataMutationAudit, type MutationAuditChange } from "../observability/dataMutationAudit.js";
export type { AgentRequestPersistence } from "./persistence.js";

export type EndpointDeliveryMetadata = Pick<PreparedEndpointDelivery,
  "deliveryId" | "callerDeliveryId" | "state" | "source" | "target" | "receipt" | "createdAt" | "updatedAt"
  | "lastAttemptAt" | "nextAttemptAt" | "attemptCount" | "lastError" | "blockedReason">;

export const AGENT_REQUEST_SCHEMA_VERSION = 1;

export function agentDeliveryPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt.replace(/\r\n/g, "\n")).digest("hex");
}

export type AgentResponsePolicy = "required" | "none";
export type AgentRequestStatus = "pending_delivery" | "awaiting_response" | "responded" | "cancelled";
export type AgentRequestSnapshotMetadata = { unscoped: boolean; incompleteThreadIds: string[] };

export type AgentRequestParty = {
  endpoint?: AgentRequestEndpoint;
  connection?: AgentConnectionSource;
  agentAdapter?: AgentAdapterType;
  threadId: string;
  agentType: string;
  threadName?: string;
  workspace?: string;
};

export type AgentRequestResponse = {
  deliveryId: string;
  by: AgentRequestParty;
  result: string;
  nextAction: string;
  respondedAt: string;
};

export type AgentRequestRecord = {
  id: string;
  deliveryId: string;
  status: AgentRequestStatus;
  source: AgentRequestParty;
  sourceHistory?: AgentRequestParty[];
  target: AgentRequestParty;
  targetHistory?: AgentRequestParty[];
  responseInstruction: string;
  messageProcessingRequirementId?: string;
  planId?: string;
  createdAt: string;
  deliveredAt?: string;
  deliveryAction?: string;
  deliveryTransport?: string;
  pendingResponseDeliveryId?: string;
  pendingResponseEvidence?: { promptHash: string; preparation: AgentCommunicationPreparation };
  response?: AgentRequestResponse;
  cancelledAt?: string;
  cancelReason?: string;
  updatedAt: string;
};

export type AgentCommunicationPreparation = {
  deliveryId: string;
  requestId?: string;
  inReplyToRequestId?: string;
  responsePolicy: AgentResponsePolicy;
  responseInstruction?: string;
  result?: string;
  nextAction?: string;
  source: AgentRequestParty;
  target: AgentRequestParty;
  messageProcessingRequirementId?: string;
  planId?: string;
};

export type PrepareAgentCommunicationInput = Omit<AgentCommunicationPreparation, "deliveryId" | "requestId"> & { deliveryId?: string };

type AgentRequestStoreFile = {
  version: number;
  requests: Record<string, AgentRequestRecord>;
  deliveries?: Record<string, PreparedEndpointDelivery>;
  /** Unusable persisted delivery evidence still forbids replay of its original ID. */
  unavailableDeliveryIds?: string[];
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function cleanMessageResult(value: unknown): string {
  return normalizeRabiMessageContent(typeof value === "string" ? value : "", true).slice(0, 12_000);
}

function normalizedParty(value: AgentRequestParty, role: "source" | "target" = "target"): AgentRequestParty {
  const threadId = cleanText(value.threadId, 4096);
  if (value.threadId !== threadId) throw new Error("Agent party requires complete, unmodified threadId.");
  const endpoint = value.endpoint ? normalizeAgentRequestEndpoint(value.endpoint) : undefined;
  const connection = value.connection ? normalizeAgentConnectionSource(value.connection) : undefined;
  if (connection && (role === "target" || endpoint)) throw new Error("A connection source is not an executable task target.");
  if (endpoint && endpoint.sessionId !== threadId) throw new Error("Agent endpoint sessionId does not match party threadId.");
  const agentType = cleanText(value.agentType, 80) || (role === "source" ? "agent" : "");
  if (!threadId && !connection) throw new Error("Agent request party requires threadId.");
  if (!agentType && role === "target") throw new Error("Agent request party requires agentType.");
  const workspace = cleanText(value.workspace, 2_000);
  const agentAdapter = parseAgentAdapterType(cleanText(value.agentAdapter, 40));
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(connection ? { connection } : {}),
    ...(agentAdapter ? { agentAdapter } : {}),
    threadId,
    agentType,
    threadName: cleanText(value.threadName, 500) || undefined,
    workspace: workspace || undefined
  };
}

export function resolveAgentRequestReplyDestination(record: AgentRequestRecord | undefined,
  _respondingParty: AgentRequestParty, requestedTarget: AgentRequestParty): AgentRequestParty | undefined {
  if (!record || record.status !== "awaiting_response") return undefined;
  const target = normalizedParty(requestedTarget);
  return sameAgentPartyAddress(target, record.source) || !record.source.endpoint
    && (record.sourceHistory ?? []).some(party => sameAgentPartyAddress(target, party)) ? structuredClone(record.source) : undefined;
}

function workspaceMatches(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  return sameCodexWorkspace(left, right);
}

function parseRecord(value: unknown): AgentRequestRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<AgentRequestRecord>;
  if (!record.id || !record.deliveryId || !record.source || !record.target || !record.responseInstruction) return undefined;
  if (!new Set<AgentRequestStatus>(["pending_delivery", "awaiting_response", "responded", "cancelled"]).has(record.status as AgentRequestStatus)) return undefined;
  try {
    if (record.id !== cleanText(record.id, 100) || !record.id) return undefined;
    callerAgentDeliveryId(record.deliveryId);
    if (record.pendingResponseDeliveryId !== undefined) callerAgentDeliveryId(record.pendingResponseDeliveryId);
    if (record.response !== undefined && !callerAgentDeliveryId(record.response?.deliveryId)) return undefined;
    if (record.pendingResponseEvidence !== undefined && !callerAgentDeliveryId(record.pendingResponseEvidence?.preparation?.deliveryId)) return undefined;
    return {
      ...record,
      id: record.id,
      deliveryId: record.deliveryId,
      status: record.status as AgentRequestStatus,
      source: normalizedParty(record.source, "source"),
      sourceHistory: Array.isArray(record.sourceHistory)
        ? record.sourceHistory.flatMap((party) => {
            try { return [normalizedParty(party, "source")]; } catch { return []; }
          })
        : undefined,
      target: normalizedParty(record.target),
      targetHistory: Array.isArray(record.targetHistory)
        ? record.targetHistory.flatMap((party) => {
            try { return [normalizedParty(party)]; } catch { return []; }
          })
        : undefined,
      responseInstruction: cleanText(record.responseInstruction, 4_000),
      response: record.response && typeof record.response === "object"
        ? {
            deliveryId: record.response.deliveryId,
            by: normalizedParty(record.response.by, "source"),
            result: cleanMessageResult(record.response.result),
            nextAction: cleanText(record.response.nextAction, 4_000),
            respondedAt: cleanText(record.response.respondedAt, 100) || new Date(0).toISOString()
          }
        : undefined,
      messageProcessingRequirementId: cleanText(record.messageProcessingRequirementId, 300) || undefined,
      planId: cleanText(record.planId, 300) || undefined,
      createdAt: cleanText(record.createdAt, 100) || new Date(0).toISOString(),
      updatedAt: cleanText(record.updatedAt, 100) || cleanText(record.createdAt, 100) || new Date(0).toISOString()
    } as AgentRequestRecord;
  } catch {
    return undefined;
  }
}

/** Worker-local business state. Production callers use the asynchronous Store facade. */
export class AgentRequestState {
  private readonly deliveryListeners = new Set<() => void>();
  private deliveryNotificationQueued = false;
  private requests = new Map<string, AgentRequestRecord>();
  private deliveries = new Map<string, PreparedEndpointDelivery>();
  private readonly unavailableDeliveryIds = new Set<string>();
  /** Rejected entries retain all original JSON fields on unrelated owner writes. */
  private readonly quarantinedDeliveries = new Map<string, unknown>();
  private readonly quarantinedRequests = new Map<string, unknown>();
  private readonly persistence: AgentRequestPersistence;
  private deliveryEvidenceUnavailableReason?: string;

  constructor(
    persistence: AgentRequestPersistence | string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.persistence = typeof persistence === "string" ? new JsonFileAgentRequestPersistence(persistence) : persistence;
    let raw: unknown;
    try { raw = this.persistence.read(); }
    catch { this.deliveryEvidenceUnavailableReason = "Original delivery evidence could not be read."; return; }
    // Only an absent persistence file is an authoritative empty owner.
    if (raw === undefined) return;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.deliveryEvidenceUnavailableReason = "Original delivery evidence has an invalid root."; return;
    }
    const file = raw as Partial<AgentRequestStoreFile>;
    if (file.version !== AGENT_REQUEST_SCHEMA_VERSION) {
      this.deliveryEvidenceUnavailableReason = "Original delivery evidence uses an unsupported schema version."; return;
    }
    const unavailable = (reason: string) => { this.deliveryEvidenceUnavailableReason ??= reason; };
    const reserve = (id: unknown): boolean => {
      try {
        const value = callerAgentDeliveryId(id);
        if (!value) return false;
        if (!this.deliveries.has(value)) this.unavailableDeliveryIds.add(value);
        return true;
      } catch { return false; }
    };
    if (file.unavailableDeliveryIds !== undefined && !Array.isArray(file.unavailableDeliveryIds)) unavailable("Original delivery reservations are invalid.");
    for (const id of Array.isArray(file.unavailableDeliveryIds) ? file.unavailableDeliveryIds : []) {
      if (!reserve(id)) unavailable("Original delivery reservations are invalid.");
    }
    const deliveries = file.deliveries && typeof file.deliveries === "object" && !Array.isArray(file.deliveries) ? file.deliveries : {};
    if (file.deliveries !== undefined && deliveries !== file.deliveries) unavailable("Original delivery records are invalid.");
    for (const [persistedId, value] of Object.entries(deliveries)) {
      if (!reserve(persistedId)) unavailable("An original delivery reservation ID is incomplete.");
      if (value?.deliveryId !== undefined && !reserve(value.deliveryId)) unavailable("An original delivery reservation ID is incomplete.");
      try {
        if (!value?.deliveryId || value.preparation?.deliveryId !== value.deliveryId
          || !value.source || !value.target || typeof value.prompt !== "string"
          || value.promptHash !== agentDeliveryPromptHash(value.prompt)) throw new Error("Invalid delivery identity or prompt evidence.");
        normalizeAgentDeliverySource(value.source);
        if (value.source.kind === "connection" && !sameAgentDeliverySource(value.source, value.preparation?.source && agentDeliverySourceForParty(value.preparation.source))) throw new Error("Connection source evidence mismatch.");
        normalizeAgentRequestEndpoint(value.target);
        if (persistedId !== value.deliveryId || !value.generation || value.executionOptionsHash !== endpointExecutionOptionsHash(value.executionOptions)
          || !["prepared", "dispatching", "committed", "cancelled"].includes(value.state)
          || !sameAgentEndpoint(value.target, value.preparation.target?.endpoint)
          || value.preparation.target.threadId !== value.target.sessionId) throw new Error("Invalid delivery evidence.");
        if (value.callerDeliveryId !== undefined && (!callerAgentDeliveryId(value.callerDeliveryId) || !/^[a-f0-9]{64}$/.test(value.requestHash || ""))) throw new Error("Invalid caller delivery evidence.");
        if (value.state === "committed" && !value.receipt) throw new Error("Committed delivery receipt is missing.");
        if (value.receipt && (value.receipt.accepted !== true || value.receipt.deliveryId !== value.deliveryId
          || value.receipt.generation !== value.generation || value.receipt.promptHash !== value.promptHash
          || value.receipt.executionOptionsHash !== value.executionOptionsHash
          || !sameAgentEndpoint(value.receipt.endpoint, value.target))) throw new Error("Invalid delivery receipt.");
        this.deliveries.set(value.deliveryId, structuredClone(value));
        this.unavailableDeliveryIds.delete(value.deliveryId);
      } catch { this.quarantinedDeliveries.set(persistedId, structuredClone(value)); }
    }
    const requests = file.requests && typeof file.requests === "object" && !Array.isArray(file.requests) ? file.requests : {};
    if (requests !== file.requests) unavailable("Original Agent request records are unavailable or invalid.");
    for (const [persistedId, value] of Object.entries(requests)) {
      const record = persistedId === value?.id ? parseRecord(value) : undefined;
      if (record) this.requests.set(record.id, record);
      else {
        this.quarantinedRequests.set(persistedId, structuredClone(value));
        // A damaged request can be isolated only when every declared reservation remains identifiable.
        if (!reserve(value?.deliveryId)
          || (value?.pendingResponseDeliveryId !== undefined && !reserve(value.pendingResponseDeliveryId))
          || (value?.response !== undefined && !reserve(value.response?.deliveryId))
          || (value?.pendingResponseEvidence !== undefined && !reserve(value.pendingResponseEvidence?.preparation?.deliveryId))) {
          unavailable("Some original Agent request reservation IDs are unavailable or invalid.");
        }
      }
    }
  }

  /** Unreadable owners cannot prove absence or overwrite their original evidence. */
  getEndpointDeliveryEvidenceStatus(): { available: boolean; reason?: string } {
    return this.deliveryEvidenceUnavailableReason
      ? { available: false, reason: this.deliveryEvidenceUnavailableReason } : { available: true };
  }

  readModel() {
    const incompleteThreadIds = new Set<string>();
    let unscoped = false;
    for (const value of this.quarantinedRequests.values()) {
      try { incompleteThreadIds.add(normalizedParty((value as AgentRequestRecord).target).threadId); }
      catch { unscoped = true; }
    }
    return {
      requests: [...this.requests.values()],
      deliveries: [...this.deliveries.values()].map(({ prompt: _prompt, ...metadata }) => metadata),
      unavailableDeliveryIds: [...this.unavailableDeliveryIds],
      evidence: this.getEndpointDeliveryEvidenceStatus(),
      requestSnapshot: { unscoped, incompleteThreadIds: [...incompleteThreadIds] } satisfies AgentRequestSnapshotMetadata
    };
  }

  /** A failed write cannot expose tentative fields, including cancellation fields. */
  transaction<T>(operation: () => T) {
    const requests = this.requests, deliveries = this.deliveries;
    const draftRequests = new AgentRequestDraftMap(requests);
    const draftDeliveries = new AgentRequestDraftMap(deliveries);
    this.requests = draftRequests;
    this.deliveries = draftDeliveries;
    try {
      const value = operation();
      const requestChanges = draftRequests.changes();
      const deliveryChanges = draftDeliveries.changes();
      this.requests = draftRequests.committed();
      this.deliveries = draftDeliveries.committed();
      return { value, delta: {
        requests: requestChanges.values,
        removedRequests: requestChanges.removed,
        deliveries: deliveryChanges.values.map(({ prompt: _prompt, ...metadata }) => metadata),
        removedDeliveries: deliveryChanges.removed
      } };
    } catch (error) {
      this.requests = requests;
      this.deliveries = deliveries;
      throw error;
    }
  }

  private persist(): void {
    if (this.deliveryEvidenceUnavailableReason) throw new Error(this.deliveryEvidenceUnavailableReason);
    // Serialization is a read of the draft, not a new write access to every record.
    const requests = Map.prototype.entries.call(this.requests) as MapIterator<[string, AgentRequestRecord]>;
    const deliveries = Map.prototype.entries.call(this.deliveries) as MapIterator<[string, PreparedEndpointDelivery]>;
    this.persistence.write({
      version: AGENT_REQUEST_SCHEMA_VERSION,
      requests: Object.fromEntries([...requests, ...this.quarantinedRequests].sort(([left], [right]) => left.localeCompare(right))) as Record<string, AgentRequestRecord>,
      deliveries: Object.fromEntries([...deliveries, ...this.quarantinedDeliveries]) as Record<string, PreparedEndpointDelivery>,
      ...(this.unavailableDeliveryIds.size ? { unavailableDeliveryIds: [...this.unavailableDeliveryIds].sort() } : {})
    } satisfies AgentRequestStoreFile);
    if (!this.deliveryNotificationQueued && this.deliveryListeners.size) {
      this.deliveryNotificationQueued = true;
      queueMicrotask(() => {
        this.deliveryNotificationQueued = false;
        for (const listener of this.deliveryListeners) {
          try { listener(); }
          catch { console.error(JSON.stringify({ event: "endpoint_delivery_listener_failed", result: "observer_failed" })); }
        }
      });
    }
  }

  onEndpointDeliveryChange(listener: () => void): () => void {
    this.deliveryListeners.add(listener);
    return () => { this.deliveryListeners.delete(listener); };
  }

  private persistMutations(records: Array<{
    action: string;
    requestId: string;
    beforeStatus?: AgentRequestStatus;
    afterStatus?: AgentRequestStatus;
    changes?: MutationAuditChange[];
    result?: string;
  }>): void {
    try {
      this.persist();
      for (const record of records) {
        recordDataMutationAudit({
          group: "agent.request",
          event: `agent_request_${record.action}`,
          owner: "AgentRequestStore",
          action: record.action,
          target: { type: "agent_request", id: record.requestId },
          dataSource: { kind: "file", id: "data/.runtime/agent-requests.json" },
          outcome: "committed",
          changes: record.changes ?? (record.beforeStatus !== record.afterStatus
            ? [{ field: "status", from: record.beforeStatus, to: record.afterStatus }]
            : undefined),
          result: record.result
        });
      }
    } catch (error) {
      for (const record of records) {
        recordDataMutationAudit({
          level: "error",
          group: "agent.request",
          event: `agent_request_${record.action}_failed`,
          owner: "AgentRequestStore",
          action: record.action,
          target: { type: "agent_request", id: record.requestId },
          dataSource: { kind: "file", id: "data/.runtime/agent-requests.json" },
          outcome: "failed",
          error
        });
      }
      throw error;
    }
  }

  getEndpointDelivery(deliveryId: string): PreparedEndpointDelivery | undefined {
    const delivery = this.deliveries.get(deliveryId);
    return delivery ? structuredClone(delivery) : undefined;
  }

  /** The durable owner also checks quarantined evidence; a new alias cannot bypass an old reservation. */
  readCallerEndpointDelivery(source: AgentDeliverySource, callerDeliveryId: string): PreparedEndpointDelivery | undefined {
    const identity = agentDeliveryCallerSourceIdentity(source);
    const conflict = (reserved = false) => new AgentThreadContractError("Original caller delivery evidence is ambiguous or damaged; automatic replay is forbidden.",
      "deliveryId", "validation", "Inspect the original delivery reservations and receipts; do not create another operation.",
      reserved ? "AGENT_DELIVERY_RESERVATION_EXISTS" : "AGENT_DELIVERY_ID_CONFLICT");
    // A crash between prepare and bind has a request reservation but no delivery body yet.
    for (const value of [...this.requests.values(), ...this.quarantinedRequests.values()]) {
      const request = value as Partial<AgentRequestRecord> | null, endpoint = request?.source && agentDeliverySourceForParty(request.source);
      if (!endpoint || !request?.deliveryId || this.deliveries.has(request.deliveryId)) continue;
      let matches = false;
      try { matches = agentDeliveryCallerSourceIdentity(endpoint) === identity
        && [sourceScopedAgentDeliveryId(endpoint, callerDeliveryId), sourceScopedAgentDeliveryId(endpoint, callerDeliveryId, true)].includes(request.deliveryId); }
      catch { /* Do not infer caller ownership from an incomplete source; its original reservation remains retained. */ }
      if (matches) throw conflict(true);
    }
    for (const value of this.quarantinedDeliveries.values()) {
      const candidate = value as Partial<PreparedEndpointDelivery> | null;
      if (candidate?.callerDeliveryId !== callerDeliveryId) continue;
      try { if (agentDeliveryCallerSourceIdentity(candidate.source!) !== identity) continue; }
      catch { throw conflict(true); }
      throw conflict(true);
    }
    let found: PreparedEndpointDelivery | undefined;
    for (const delivery of this.deliveries.values()) {
      if (delivery.callerDeliveryId !== callerDeliveryId || agentDeliveryCallerSourceIdentity(delivery.source) !== identity) continue;
      if (found) throw conflict();
      found = delivery;
    }
    return found ? structuredClone(found) : undefined;
  }

  listEndpointDeliveries(): PreparedEndpointDelivery[] {
    return [...this.deliveries.values()].map(value => structuredClone(value));
  }

  /** Status reads and recovery selection never copy or scan the stored prompt bodies. */
  listEndpointDeliveryMetadata(): EndpointDeliveryMetadata[] {
    return [...this.deliveries.values()].map(value => structuredClone({
      deliveryId: value.deliveryId, callerDeliveryId: value.callerDeliveryId, state: value.state,
      source: value.source, target: value.target, receipt: value.receipt,
      createdAt: value.createdAt, updatedAt: value.updatedAt, lastAttemptAt: value.lastAttemptAt,
      nextAttemptAt: value.nextAttemptAt, attemptCount: value.attemptCount, lastError: value.lastError, blockedReason: value.blockedReason
    }));
  }

  listUnavailableEndpointDeliveryIds(): string[] {
    return [...this.unavailableDeliveryIds];
  }

  hasEndpointDeliveryReservation(deliveryId: string): boolean {
    if (this.deliveries.has(deliveryId) || this.unavailableDeliveryIds.has(deliveryId)) return true;
    for (const record of this.requests.values()) {
      if (record.deliveryId === deliveryId || record.pendingResponseDeliveryId === deliveryId || record.response?.deliveryId === deliveryId) return true;
    }
    return false;
  }

  assertEndpointDeliveryActive(deliveryId: string): void {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.state === "cancelled") throw new Error("Endpoint delivery is missing or cancelled.");
    const preparation = delivery.preparation;
    const request = preparation.requestId ? this.requests.get(preparation.requestId) : undefined;
    const original = preparation.inReplyToRequestId ? this.requests.get(preparation.inReplyToRequestId) : undefined;
    if ((preparation.requestId && (!request || request.status === "cancelled" || request.deliveryId !== deliveryId
        || !sameAgentParty(request.target, preparation.target)))
      || (preparation.inReplyToRequestId && (!original || original.status === "cancelled"
        || !sameAgentPartyAddress(original.source, preparation.target)
        || (original.pendingResponseDeliveryId !== deliveryId && original.response?.deliveryId !== deliveryId)))) {
      throw new Error("Endpoint request was cancelled or its exact reservation changed; execution and reconciliation are forbidden.");
    }
  }

  bindEndpointDelivery(delivery: PreparedEndpointDelivery): void {
    normalizeAgentDeliverySource(delivery.source);
    if (delivery.source.kind === "connection" && !sameAgentDeliverySource(delivery.source, agentDeliverySourceForParty(delivery.preparation.source))) throw new Error("Connection source evidence mismatch.");
    if (this.deliveries.has(delivery.deliveryId) || delivery.state !== "prepared"
      || delivery.promptHash !== agentDeliveryPromptHash(delivery.prompt)
      || delivery.executionOptionsHash !== endpointExecutionOptionsHash(delivery.executionOptions)
      || delivery.preparation.deliveryId !== delivery.deliveryId
      || !sameAgentEndpoint(delivery.target, delivery.preparation.target.endpoint)
      || delivery.target.sessionId !== delivery.preparation.target.threadId) throw new Error("Invalid prepared endpoint delivery.");
    const timestamp = this.now().toISOString();
    this.deliveries.set(delivery.deliveryId, { ...structuredClone(delivery), createdAt: timestamp, updatedAt: timestamp, attemptCount: 0 });
    try { this.persist(); } catch (error) { this.deliveries.delete(delivery.deliveryId); throw error; }
  }

  markEndpointDispatching(deliveryId: string): string {
    this.assertEndpointDeliveryActive(deliveryId);
    const delivery = this.deliveries.get(deliveryId)!;
    if (delivery.state !== "prepared") throw new Error("Endpoint delivery cannot be redispatched.");
    const before = structuredClone(delivery);
    delivery.state = "dispatching";
    delivery.dispatchAttemptId = randomUUID();
    delivery.updatedAt = delivery.lastAttemptAt = this.now().toISOString();
    delivery.attemptCount = (delivery.attemptCount ?? 0) + 1;
    delete delivery.blockedReason;
    delete delivery.lastError;
    try { this.persist(); } catch (error) { this.deliveries.set(deliveryId, before); throw error; }
    return delivery.dispatchAttemptId;
  }

  noteEndpointDeliveryFailure(deliveryId: string, error: unknown, options: { blocked?: boolean } = {}): void {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.state === "committed" || delivery.state === "cancelled") return;
    const before = structuredClone(delivery);
    const message = cleanText(error instanceof Error ? error.message : String(error), 1_024);
    const code = error && typeof error === "object" && "code" in error ? cleanText(String(error.code), 100) : undefined;
    delivery.updatedAt = this.now().toISOString();
    delivery.lastError = { message, ...(code ? { code } : {}) };
    if (delivery.state === "prepared") {
      delivery.retryCount = (delivery.retryCount ?? 0) + 1;
      const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(delivery.retryCount - 1, 6));
      delivery.nextAttemptAt = new Date(this.now().getTime() + retryDelayMs + Math.floor(Math.random() * Math.min(1_000, retryDelayMs))).toISOString();
    } else delete delivery.nextAttemptAt;
    if (options.blocked) delivery.blockedReason = message;
    try { this.persist(); } catch (failure) { this.deliveries.set(deliveryId, before); throw failure; }
  }

  /** Called only with positive no-frame-sent proof from the trusted transport owner. */
  markEndpointNotSent(deliveryId: string, proof?: EndpointDeliveryNoFrameProof): void {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery?.state === "prepared" && proof && delivery.lastNoFrameProof?.attemptId === proof.attemptId) {
      validateEndpointDeliveryNoFrameProof(delivery, proof);
      return;
    }
    if (!delivery || delivery.state !== "dispatching" || delivery.receipt) throw new Error("Only a proven unsent dispatch can return to its prepared reservation.");
    const before = structuredClone(delivery);
    if (proof) { validateEndpointDeliveryNoFrameProof(delivery, proof); delivery.lastNoFrameProof = structuredClone(proof); }
    delivery.state = "prepared";
    delivery.updatedAt = this.now().toISOString();
    try { this.persist(); } catch (error) { this.deliveries.set(deliveryId, before); throw error; }
  }

  commitEndpointReceipt(deliveryId: string, receipt: EndpointDeliveryReceipt): void {
    this.assertEndpointDeliveryActive(deliveryId);
    const delivery = this.deliveries.get(deliveryId)!;
    if (receipt.accepted !== true || receipt.deliveryId !== delivery.deliveryId || receipt.generation !== delivery.generation
      || receipt.promptHash !== delivery.promptHash || receipt.executionOptionsHash !== delivery.executionOptionsHash
      || !sameAgentEndpoint(receipt.endpoint, delivery.target)
      || !receipt.action || !receipt.transport) throw new Error("Endpoint receipt identity mismatch.");
    if (delivery.state === "committed") return;
    if (delivery.state !== "dispatching") throw new Error("Endpoint delivery was not dispatched.");
    const before = structuredClone(delivery);
    delivery.state = "committed";
    delivery.receipt = structuredClone(receipt);
    delivery.updatedAt = this.now().toISOString();
    delete delivery.nextAttemptAt;
    delete delivery.retryCount;
    delete delivery.lastError;
    delete delivery.blockedReason;
    try {
      const tracked = delivery.preparation.requestId || delivery.preparation.inReplyToRequestId;
      this.commit(delivery.preparation, receipt);
      if (!tracked) this.persist();
    } catch (error) { this.deliveries.set(deliveryId, before); throw error; }
  }

  get(requestId: string): AgentRequestRecord | undefined {
    const record = this.requests.get(cleanText(requestId, 100));
    return record ? structuredClone(record) : undefined;
  }

  list(): AgentRequestRecord[] {
    return [...this.requests.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map((record) => structuredClone(record));
  }

  hasManagedSession(threadId: string, workspace?: string): boolean {
    const id = cleanText(threadId, 4096);
    return [...this.requests.values()].some((record) => (
      (record.source.threadId === id && workspaceMatches(record.source.workspace, workspace))
      || (record.target.threadId === id && workspaceMatches(record.target.workspace, workspace))
    ));
  }

  reconcileOpenParties(
    resolve: (
      party: AgentRequestParty,
      record: AgentRequestRecord,
      role: "source" | "target"
    ) => AgentRequestParty | null | undefined
  ): { reassigned: AgentRequestRecord[]; cancelled: AgentRequestRecord[] } {
    const reassigned: AgentRequestRecord[] = [];
    const cancelled: AgentRequestRecord[] = [];
    const timestamp = nowIso(this.now);
    for (const record of this.requests.values()) {
      if (record.status !== "pending_delivery" && record.status !== "awaiting_response") continue;
      // Endpoint-bound requests never follow pool/session replacements, including remote ABA.
      if (record.source.endpoint || record.source.connection || record.target.endpoint) continue;
      const source = resolve(structuredClone(record.source), structuredClone(record), "source");
      const target = resolve(structuredClone(record.target), structuredClone(record), "target");
      if (source === undefined && target === undefined) continue;
      if (record.status === "pending_delivery" || source === null || target === null) {
        record.status = "cancelled";
        record.cancelledAt = timestamp;
        record.cancelReason = "Message Agent pool changed before this tracked delivery completed; the stale task binding was cancelled.";
        record.pendingResponseDeliveryId = undefined;
        record.pendingResponseEvidence = undefined;
        record.updatedAt = timestamp;
        cancelled.push(structuredClone(record));
        continue;
      }
      let changed = false;
      if (source && source.threadId !== record.source.threadId) {
        record.sourceHistory = appendPartyHistory(record.sourceHistory, record.source, "source");
        record.source = normalizedParty(source, "source");
        changed = true;
      }
      if (target && target.threadId !== record.target.threadId) {
        record.targetHistory = appendPartyHistory(record.targetHistory, record.target);
        record.target = normalizedParty(target);
        changed = true;
      }
      if (!changed) continue;
      record.pendingResponseDeliveryId = undefined;
      record.pendingResponseEvidence = undefined;
      record.updatedAt = timestamp;
      reassigned.push(structuredClone(record));
    }
    if (reassigned.length || cancelled.length) {
      this.persistMutations([
        ...reassigned.map(record => ({
          action: "reassigned",
          requestId: record.id,
          afterStatus: record.status,
          changes: [{ field: "party_binding" }]
        })),
        ...cancelled.map(record => ({
          action: "cancelled",
          requestId: record.id,
          afterStatus: record.status,
          changes: [{ field: "status", to: record.status }]
        }))
      ]);
    }
    return { reassigned, cancelled };
  }

  resolveReplyDestination(
    requestId: string,
    respondingParty: AgentRequestParty,
    requestedTarget: AgentRequestParty
  ): AgentRequestParty | undefined {
    return resolveAgentRequestReplyDestination(this.requests.get(cleanText(requestId, 100)), respondingParty, requestedTarget);
  }

  prepare(input: PrepareAgentCommunicationInput): AgentCommunicationPreparation {
    const source = normalizedParty(input.source, "source");
    const target = normalizedParty(input.target);
    const responsePolicy = input.responsePolicy;
    if (responsePolicy !== "required" && responsePolicy !== "none") {
      throw new Error("responsePolicy must be required or none.");
    }
    const responseInstruction = cleanText(input.responseInstruction, 4_000);
    if (responsePolicy === "required" && !responseInstruction) {
      throw new Error("responseInstruction is required when responsePolicy is required.");
    }
    const inReplyToRequestId = cleanText(input.inReplyToRequestId, 100) || undefined;
    const result = cleanMessageResult(input.result) || undefined;
    const nextAction = cleanText(input.nextAction, 4_000) || undefined;
    const deliveryId = callerAgentDeliveryId(input.deliveryId) ?? randomUUID();
    if (input.deliveryId !== undefined && this.hasEndpointDeliveryReservation(deliveryId)) {
      throw new AgentThreadContractError("Original delivery reservation already exists; automatic replay is forbidden.", "deliveryId", "validation",
        "Reconcile the original delivery; do not create another request when its endpoint evidence is unavailable.", "AGENT_DELIVERY_RESERVATION_EXISTS");
    }
    let repliedRequest: AgentRequestRecord | undefined;
    let repliedBefore: AgentRequestRecord | undefined;
    if (inReplyToRequestId) {
      repliedRequest = this.requests.get(inReplyToRequestId);
      if (!repliedRequest) throw new Error(`Agent request not found: ${inReplyToRequestId}`);
      if (repliedRequest.status !== "awaiting_response") {
        throw new AgentReplyStateError(repliedRequest, "request_state_does_not_accept_reply");
      }
      if (repliedRequest.pendingResponseDeliveryId) {
        throw new Error(`Agent request already has a response delivery in progress: ${inReplyToRequestId}`);
      }
      if (!sameAgentPartyAddress(target, repliedRequest.source)) {
        throw new Error("Agent response must be sent back to the original source task.");
      }
      if (!result) throw new Error("result is required when replying to an Agent request.");
      if (!nextAction) throw new Error("nextAction is required when replying to an Agent request.");
      repliedBefore = structuredClone(repliedRequest);
      repliedRequest.pendingResponseDeliveryId = deliveryId;
      repliedRequest.updatedAt = nowIso(this.now);
    } else if (result || nextAction) {
      throw new Error("result and nextAction require inReplyToRequestId.");
    }

    const requestId = responsePolicy === "required" ? randomUUID() : undefined;
    const messageProcessingRequirementId = cleanText(input.messageProcessingRequirementId, 300) || undefined;
    const planId = cleanText(input.planId, 300) || undefined;
    if (requestId) {
      const timestamp = nowIso(this.now);
      this.requests.set(requestId, {
        id: requestId,
        deliveryId,
        status: "pending_delivery",
        source,
        target,
        responseInstruction,
        messageProcessingRequirementId,
        planId,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
    if (repliedRequest || requestId) {
      try { this.persistMutations([
        ...(repliedRequest ? [{
          action: "response_reserved",
          requestId: repliedRequest.id,
          afterStatus: repliedRequest.status,
          changes: [{ field: "pendingResponseDeliveryId" }]
        }] : []),
        ...(requestId ? [{
          action: "prepared",
          requestId,
          afterStatus: "pending_delivery" as AgentRequestStatus,
          changes: [{ field: "created" }]
        }] : [])
      ]); } catch (error) {
        if (requestId) this.requests.delete(requestId);
        if (repliedBefore) this.requests.set(repliedBefore.id, repliedBefore);
        throw error;
      }
    }
    return {
      deliveryId,
      requestId,
      inReplyToRequestId,
      responsePolicy,
      responseInstruction: responseInstruction || undefined,
      result,
      nextAction,
      source,
      target,
      messageProcessingRequirementId,
      planId
    };
  }

  /** A source connection has no native reply target: retain the response on its original Manager request. */
  recordConnectionResponse(requestId: string, actualSource: AgentRequestParty, responseDeliveryId: string, result: string, nextAction: string): AgentRequestRecord {
    const record = this.requests.get(cleanText(requestId, 100));
    if (!record) throw new Error(`Agent request not found: ${requestId}`);
    if (!record.source.connection || record.source.endpoint) throw new Error("This request has a native task reply destination.");
    const source = normalizedParty(actualSource, "source"), deliveryId = callerAgentDeliveryId(responseDeliveryId);
    const responseResult = cleanMessageResult(result), responseNext = cleanText(nextAction, 4_000);
    if (!deliveryId) throw new Error("A stable response delivery ID is required.");
    if (!responseResult) throw new Error("result is required when replying to an Agent request.");
    if (!responseNext) throw new Error("nextAction is required when replying to an Agent request.");
    if (record.status === "responded") {
      if (record.response?.deliveryId === deliveryId && record.response.result === responseResult && record.response.nextAction === responseNext) return structuredClone(record);
      throw new AgentThreadContractError("Response conflicts with the original recorded result.", "deliveryId", "validation",
        "Read the original request and retain the original result and response delivery ID.", "AGENT_DELIVERY_ID_CONFLICT");
    }
    if (record.status !== "awaiting_response" || record.pendingResponseDeliveryId) throw new AgentReplyStateError(record,
      record.pendingResponseDeliveryId ? "response_delivery_in_progress" : "request_state_does_not_accept_reply");
    if (this.hasEndpointDeliveryReservation(deliveryId)) throw new AgentThreadContractError("Response delivery ID is already reserved by another operation.",
      "deliveryId", "validation", "Retain the original operation ID and use a distinct caller ID for a different response.", "AGENT_DELIVERY_ID_CONFLICT");
    const before = structuredClone(record), timestamp = nowIso(this.now);
    record.status = "responded";
    record.response = { deliveryId, by: source, result: responseResult, nextAction: responseNext, respondedAt: timestamp };
    record.updatedAt = timestamp;
    try { this.persistMutations([{ action: "responded", requestId: record.id, beforeStatus: "awaiting_response", afterStatus: "responded" }]); }
    catch (error) { this.requests.set(record.id, before); throw error; }
    return structuredClone(record);
  }

  bindResponseEvidence(preparation: AgentCommunicationPreparation, prompt: string): void {
    if (!preparation.inReplyToRequestId) return;
    const record = this.requests.get(preparation.inReplyToRequestId);
    if (!record || record.pendingResponseDeliveryId !== preparation.deliveryId) {
      throw new Error("Response evidence requires the current delivery reservation.");
    }
    const previous = record.pendingResponseEvidence;
    record.pendingResponseEvidence = { promptHash: agentDeliveryPromptHash(prompt), preparation: structuredClone(preparation) };
    try {
      this.persistMutations([{ action: "response_evidence_bound", requestId: record.id,
        changes: [{ field: "pendingResponseEvidence" }] }]);
    } catch (error) {
      record.pendingResponseEvidence = previous;
      throw error;
    }
  }

  commit(
    preparation: AgentCommunicationPreparation,
    receipt: { action?: string; transport?: string } = {}
  ): { request?: AgentRequestRecord; repliedRequest?: AgentRequestRecord } {
    const timestamp = nowIso(this.now);
    const before = [preparation.requestId, preparation.inReplyToRequestId]
      .flatMap(id => id && this.requests.has(id) ? [[id, structuredClone(this.requests.get(id)!)] as const] : []);
    let request: AgentRequestRecord | undefined;
    let repliedRequest: AgentRequestRecord | undefined;
    if (preparation.requestId) {
      const reserved = this.requests.get(preparation.requestId);
      if (!reserved || reserved.deliveryId !== preparation.deliveryId || reserved.status === "cancelled") {
        throw new Error(`Agent request delivery reservation is missing or cancelled: ${preparation.requestId}`);
      }
    }
    if (preparation.inReplyToRequestId) {
      const current = this.requests.get(preparation.inReplyToRequestId);
      if (current?.status === "responded" && current.response?.deliveryId === preparation.deliveryId) {
        return {
          repliedRequest: structuredClone(current),
          request: preparation.requestId ? this.get(preparation.requestId) : undefined
        };
      }
      if (!current || current.pendingResponseDeliveryId !== preparation.deliveryId) {
        throw new Error(`Agent response delivery reservation is missing: ${preparation.inReplyToRequestId}`);
      }
      current.pendingResponseDeliveryId = undefined;
      current.pendingResponseEvidence = undefined;
      current.status = "responded";
      current.response = {
        deliveryId: preparation.deliveryId,
        by: preparation.source,
        result: preparation.result || "",
        nextAction: preparation.nextAction || "",
        respondedAt: timestamp
      };
      current.updatedAt = timestamp;
      repliedRequest = current;
    }
    if (preparation.requestId) {
      const current = this.requests.get(preparation.requestId);
      if (!current || current.deliveryId !== preparation.deliveryId) {
        throw new Error(`Agent request delivery reservation is missing: ${preparation.requestId}`);
      }
      if (current.status === "cancelled") {
        throw new Error(`Agent request delivery was cancelled: ${preparation.requestId}`);
      }
      if (current.status === "pending_delivery") {
        current.status = "awaiting_response";
        current.deliveredAt = timestamp;
        current.deliveryAction = cleanText(receipt.action, 80) || undefined;
        current.deliveryTransport = cleanText(receipt.transport, 80) || undefined;
        current.updatedAt = timestamp;
      }
      request = current;
    }
    if (repliedRequest || request) {
      try {
        this.persistMutations([
        ...(repliedRequest ? [{
          action: "responded",
          requestId: repliedRequest.id,
          beforeStatus: "awaiting_response" as AgentRequestStatus,
          afterStatus: repliedRequest.status
        }] : []),
        ...(request ? [{
          action: "delivered",
          requestId: request.id,
          beforeStatus: "pending_delivery" as AgentRequestStatus,
          afterStatus: request.status
        }] : [])
        ]);
      } catch (error) {
        for (const [id, record] of before) this.requests.set(id, record);
        throw error;
      }
    }
    return {
      request: request ? structuredClone(request) : undefined,
      repliedRequest: repliedRequest ? structuredClone(repliedRequest) : undefined
    };
  }

  abort(preparation: AgentCommunicationPreparation): void {
    const endpointDelivery = this.deliveries.get(preparation.deliveryId);
    if (endpointDelivery && endpointDelivery.state !== "prepared") throw new Error("Dispatched endpoint delivery cannot release its durable reservation.");
    const before = [preparation.requestId, preparation.inReplyToRequestId]
      .flatMap(id => id && this.requests.has(id) ? [[id, structuredClone(this.requests.get(id)!)] as const] : []);
    let changed = !!endpointDelivery;
    if (endpointDelivery) this.deliveries.delete(preparation.deliveryId);
    if (preparation.inReplyToRequestId) {
      const current = this.requests.get(preparation.inReplyToRequestId);
      if (current?.pendingResponseDeliveryId === preparation.deliveryId) {
        current.pendingResponseDeliveryId = undefined;
        current.pendingResponseEvidence = undefined;
        current.updatedAt = nowIso(this.now);
        changed = true;
      }
    }
    if (preparation.requestId) {
      const current = this.requests.get(preparation.requestId);
      if (current?.status === "pending_delivery" && current.deliveryId === preparation.deliveryId) {
        this.requests.delete(preparation.requestId);
        changed = true;
      }
    }
    if (changed) {
      try {
        this.persistMutations([{
          action: "preparation_aborted",
          requestId: preparation.inReplyToRequestId ?? preparation.requestId ?? preparation.deliveryId,
          changes: [{ field: "delivery_reservation" }]
        }]);
      } catch (error) {
        for (const [id, record] of before) this.requests.set(id, record);
        if (endpointDelivery) this.deliveries.set(endpointDelivery.deliveryId, endpointDelivery);
        throw error;
      }
    }
  }

  /** Stop this reservation without asserting that its target never received the prompt. */
  cancelEndpointDelivery(deliveryId: string): PreparedEndpointDelivery {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw Object.assign(new Error("Original delivery evidence is unavailable."), { code: "DELIVERY_EVIDENCE_UNAVAILABLE" });
    if (delivery.state === "committed" || delivery.receipt) throw Object.assign(new Error("An accepted delivery cannot be cancelled."), { code: "DELIVERY_ALREADY_RECEIVED" });
    if (delivery.state === "cancelled") return structuredClone(delivery);
    const preparation = delivery.preparation;
    const request = preparation.requestId ? this.requests.get(preparation.requestId) : undefined;
    const original = preparation.inReplyToRequestId ? this.requests.get(preparation.inReplyToRequestId) : undefined;
    const linked = request?.deliveryId === deliveryId && sameAgentParty(request.source, preparation.source)
      && sameAgentParty(request.target, preparation.target) ? request
      : original?.pendingResponseDeliveryId === deliveryId
        && sameAgentPartyAddress(original.source, preparation.target) ? original : undefined;
    const reason = "Delivery tracking was cancelled. This does not prove that the target never accepted the original prompt.";
    if (linked && linked.status !== "responded" && linked.status !== "cancelled") {
      this.cancel(linked.id, reason);
    } else {
      const before = structuredClone(delivery);
      delivery.state = "cancelled";
      delivery.updatedAt = nowIso(this.now);
      delivery.lastError = { code: "DELIVERY_CANCELLED", message: reason };
      delete delivery.nextAttemptAt;
      delete delivery.blockedReason;
      try { this.persist(); } catch (error) { this.deliveries.set(deliveryId, before); throw error; }
    }
    return structuredClone(this.deliveries.get(deliveryId)!);
  }

  cancel(requestId: string, reason?: string): AgentRequestRecord {
    const record = this.requests.get(cleanText(requestId, 100));
    if (!record) throw new Error(`Agent request not found: ${requestId}`);
    if (record.status === "responded" || record.status === "cancelled") return structuredClone(record);
    const beforeStatus = record.status;
    const before = structuredClone(record);
    const affected = [...this.deliveries.values()].filter(delivery => delivery.state !== "committed" && !delivery.receipt
      && delivery.state !== "cancelled" && (delivery.preparation.requestId === record.id || delivery.preparation.inReplyToRequestId === record.id));
    const deliveryBefore = affected.map(delivery => structuredClone(delivery));
    const timestamp = nowIso(this.now);
    for (const delivery of affected) {
      delivery.state = "cancelled";
      delivery.updatedAt = timestamp;
      delivery.lastError = { code: "DELIVERY_CANCELLED", message: cleanText(reason, 1_024)
        || "Delivery tracking was cancelled. This does not prove that the target never accepted the original prompt." };
      delete delivery.nextAttemptAt;
      delete delivery.blockedReason;
    }
    record.status = "cancelled";
    record.cancelledAt = timestamp;
    record.cancelReason = cleanText(reason, 2_000) || undefined;
    record.pendingResponseDeliveryId = undefined;
    record.pendingResponseEvidence = undefined;
    record.updatedAt = timestamp;
    try {
      this.persistMutations([{
        action: "cancelled",
        requestId: record.id,
        beforeStatus,
        afterStatus: record.status
      }]);
    } catch (error) {
      this.requests.set(record.id, before);
      for (const delivery of deliveryBefore) this.deliveries.set(delivery.deliveryId, delivery);
      throw error;
    }
    return structuredClone(record);
  }
}

/** Existing mutations replace nested values; only each record's own fields are writable. */
class AgentRequestDraftMap<T extends object> extends Map<string, T> {
  readonly touched = new Set<string>();
  constructor(private readonly previous: Map<string, T>) { super(previous); }
  override get(key: string): T | undefined {
    const value = super.get(key);
    if (value === undefined || this.touched.has(key)) return value;
    const draft = { ...value };
    this.touched.add(key);
    super.set(key, draft);
    return draft;
  }
  override set(key: string, value: T): this {
    // Map's constructor calls set before instance fields have initialized.
    this.touched?.add(key);
    return super.set(key, value);
  }
  override delete(key: string): boolean { this.touched.add(key); return super.delete(key); }
  override *values(): MapIterator<T> { for (const key of super.keys()) yield this.get(key)!; }
  override *entries(): MapIterator<[string, T]> { for (const key of super.keys()) yield [key, this.get(key)!]; }
  override [Symbol.iterator](): MapIterator<[string, T]> { return this.entries(); }
  committed(): Map<string, T> { return new Map(Map.prototype.entries.call(this) as MapIterator<[string, T]>); }
  changes(): { values: T[]; removed: string[] } {
    const values: T[] = [], removed: string[] = [];
    for (const key of this.touched) {
      const before = this.previous.get(key), after = super.get(key);
      if (after === undefined) { if (before !== undefined) removed.push(key); continue; }
      if (!before || Reflect.ownKeys(before).length !== Reflect.ownKeys(after).length
        || Reflect.ownKeys(after).some(field => Reflect.get(before, field) !== Reflect.get(after, field))) values.push(after);
    }
    return { values, removed };
  }
}

function appendPartyHistory(
  history: AgentRequestParty[] | undefined,
  party: AgentRequestParty,
  role: "source" | "target" = "target"
): AgentRequestParty[] {
  const rows = [...(history ?? []), normalizedParty(party, role)];
  const unique = new Map<string, AgentRequestParty>();
  for (const row of rows) unique.set(`${row.threadId}\n${row.workspace || ""}`, row);
  return [...unique.values()].slice(-20);
}
