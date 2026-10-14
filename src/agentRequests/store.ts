import { createHash, randomUUID } from "node:crypto";
import { endpointExecutionOptionsHash } from "./executionOptions.js";
import { normalizeAgentRequestEndpoint, sameAgentEndpoint, sameAgentParty, type AgentRequestEndpoint } from "./endpoint.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { AgentReplyStateError } from "./replyError.js";
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

export const AGENT_REQUEST_SCHEMA_VERSION = 1;
export const AGENT_REQUEST_REMINDER_MS = 5 * 60 * 1_000;

export function agentDeliveryPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt.replace(/\r\n/g, "\n")).digest("hex");
}

export type AgentResponsePolicy = "required" | "none";
export type AgentRequestStatus = "pending_delivery" | "awaiting_response" | "responded" | "cancelled";

export type AgentRequestParty = {
  endpoint?: AgentRequestEndpoint;
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
  lastTargetTurnId?: string;
  lastTargetTurnEndedAt?: string;
  nextReminderAt?: string;
  reminderCount: number;
  lastReminderAt?: string;
  lastReminderError?: string;
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

function normalizedParty(value: AgentRequestParty): AgentRequestParty {
  const threadId = cleanText(value.threadId, 4096);
  if (value.threadId !== threadId) throw new Error("Agent party requires complete, unmodified threadId.");
  const endpoint = value.endpoint ? normalizeAgentRequestEndpoint(value.endpoint) : undefined;
  if (endpoint && endpoint.sessionId !== threadId) throw new Error("Agent endpoint sessionId does not match party threadId.");
  const agentType = cleanText(value.agentType, 80);
  if (!threadId) throw new Error("Agent request party requires threadId.");
  if (!agentType) throw new Error("Agent request party requires agentType.");
  const workspace = cleanText(value.workspace, 2_000);
  const agentAdapter = parseAgentAdapterType(cleanText(value.agentAdapter, 40));
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(agentAdapter ? { agentAdapter } : {}),
    threadId,
    agentType,
    threadName: cleanText(value.threadName, 500) || undefined,
    workspace: workspace || undefined
  };
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
    return {
      ...record,
      id: cleanText(record.id, 100),
      deliveryId: cleanText(record.deliveryId, 100),
      status: record.status as AgentRequestStatus,
      source: normalizedParty(record.source),
      sourceHistory: Array.isArray(record.sourceHistory)
        ? record.sourceHistory.flatMap((party) => {
            try { return [normalizedParty(party)]; } catch { return []; }
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
            deliveryId: cleanText(record.response.deliveryId, 100),
            by: normalizedParty(record.response.by),
            result: cleanMessageResult(record.response.result),
            nextAction: cleanText(record.response.nextAction, 4_000),
            respondedAt: cleanText(record.response.respondedAt, 100) || new Date(0).toISOString()
          }
        : undefined,
      messageProcessingRequirementId: cleanText(record.messageProcessingRequirementId, 300) || undefined,
      planId: cleanText(record.planId, 300) || undefined,
      createdAt: cleanText(record.createdAt, 100) || new Date(0).toISOString(),
      reminderCount: Math.max(0, Math.floor(Number(record.reminderCount) || 0)),
      updatedAt: cleanText(record.updatedAt, 100) || cleanText(record.createdAt, 100) || new Date(0).toISOString()
    } as AgentRequestRecord;
  } catch {
    return undefined;
  }
}

export class AgentRequestStore {
  private readonly requests = new Map<string, AgentRequestRecord>();
  private readonly deliveries = new Map<string, PreparedEndpointDelivery>();
  private readonly unavailableDeliveryIds = new Set<string>();
  private readonly persistence: AgentRequestPersistence;

  constructor(
    persistence: AgentRequestPersistence | string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.persistence = typeof persistence === "string" ? new JsonFileAgentRequestPersistence(persistence) : persistence;
    const raw = this.persistence.read();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const file = raw as Partial<AgentRequestStoreFile>;
    if (!file.requests || typeof file.requests !== "object" || Array.isArray(file.requests)) return;
    for (const id of file.unavailableDeliveryIds ?? []) {
      if (typeof id === "string" && id && id === id.trim() && id.length <= 100) this.unavailableDeliveryIds.add(id);
    }
    for (const [persistedId, value] of Object.entries(file.deliveries ?? {})) {
      this.unavailableDeliveryIds.add(persistedId);
      if (typeof value?.deliveryId === "string") this.unavailableDeliveryIds.add(value.deliveryId);
      if (value?.deliveryId && value.preparation?.deliveryId === value.deliveryId
        && value.source && value.target && value.promptHash === agentDeliveryPromptHash(value.prompt)) {
        try {
          normalizeAgentRequestEndpoint(value.source);
          normalizeAgentRequestEndpoint(value.target);
          if (persistedId !== value.deliveryId || !value.generation || value.executionOptionsHash !== endpointExecutionOptionsHash(value.executionOptions)
            || !["prepared", "dispatching", "committed", "cancelled"].includes(value.state)
            || !sameAgentEndpoint(value.source, value.preparation.source?.endpoint)
            || !sameAgentEndpoint(value.target, value.preparation.target?.endpoint)
            || value.preparation.source.threadId !== value.source.sessionId || value.preparation.target.threadId !== value.target.sessionId) continue;
          if (value.callerDeliveryId !== undefined && (!callerAgentDeliveryId(value.callerDeliveryId) || !/^[a-f0-9]{64}$/.test(value.requestHash || ""))) continue;
          if (value.state === "committed" && !value.receipt) continue;
          if (value.receipt && (value.receipt.accepted !== true || value.receipt.deliveryId !== value.deliveryId
            || value.receipt.generation !== value.generation || value.receipt.promptHash !== value.promptHash
            || value.receipt.executionOptionsHash !== value.executionOptionsHash
            || !sameAgentEndpoint(value.receipt.endpoint, value.target))) continue;
          this.deliveries.set(value.deliveryId, structuredClone(value));
          this.unavailableDeliveryIds.delete(value.deliveryId);
        } catch { /* Malformed evidence cannot be used for recovery. */ }
      }
    }
    for (const value of Object.values(file.requests)) {
      const record = parseRecord(value);
      if (record) this.requests.set(record.id, record);
    }
  }

  private persist(): void {
    this.persistence.write({
      version: AGENT_REQUEST_SCHEMA_VERSION,
      requests: Object.fromEntries([...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))),
      deliveries: Object.fromEntries(this.deliveries),
      ...(this.unavailableDeliveryIds.size ? { unavailableDeliveryIds: [...this.unavailableDeliveryIds].sort() } : {})
    } satisfies AgentRequestStoreFile);
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

  listEndpointDeliveries(): PreparedEndpointDelivery[] {
    return [...this.deliveries.values()].map(value => structuredClone(value));
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
        || !sameAgentParty(request.source, preparation.source) || !sameAgentParty(request.target, preparation.target)))
      || (preparation.inReplyToRequestId && (!original || original.status === "cancelled"
        || !sameAgentParty(original.target, preparation.source) || !sameAgentParty(original.source, preparation.target)
        || (original.pendingResponseDeliveryId !== deliveryId && original.response?.deliveryId !== deliveryId)))) {
      throw new Error("Endpoint request was cancelled or its exact reservation changed; execution and reconciliation are forbidden.");
    }
  }

  bindEndpointDelivery(delivery: PreparedEndpointDelivery): void {
    if (this.deliveries.has(delivery.deliveryId) || delivery.state !== "prepared"
      || delivery.promptHash !== agentDeliveryPromptHash(delivery.prompt)
      || delivery.executionOptionsHash !== endpointExecutionOptionsHash(delivery.executionOptions)
      || delivery.preparation.deliveryId !== delivery.deliveryId
      || !sameAgentEndpoint(delivery.source, delivery.preparation.source.endpoint)
      || !sameAgentEndpoint(delivery.target, delivery.preparation.target.endpoint)
      || delivery.source.sessionId !== delivery.preparation.source.threadId
      || delivery.target.sessionId !== delivery.preparation.target.threadId) throw new Error("Invalid prepared endpoint delivery.");
    this.deliveries.set(delivery.deliveryId, structuredClone(delivery));
    try { this.persist(); } catch (error) { this.deliveries.delete(delivery.deliveryId); throw error; }
  }

  markEndpointDispatching(deliveryId: string): void {
    this.assertEndpointDeliveryActive(deliveryId);
    const delivery = this.deliveries.get(deliveryId)!;
    if (delivery.state !== "prepared") throw new Error("Endpoint delivery cannot be redispatched.");
    delivery.state = "dispatching";
    try { this.persist(); } catch (error) { delivery.state = "prepared"; throw error; }
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
      if (record.source.endpoint || record.target.endpoint) continue;
      const source = resolve(structuredClone(record.source), structuredClone(record), "source");
      const target = resolve(structuredClone(record.target), structuredClone(record), "target");
      if (source === undefined && target === undefined) continue;
      if (record.status === "pending_delivery" || source === null || target === null) {
        record.status = "cancelled";
        record.cancelledAt = timestamp;
        record.cancelReason = "Message Agent pool changed before this tracked delivery completed; the stale task binding was cancelled.";
        record.nextReminderAt = undefined;
        record.pendingResponseDeliveryId = undefined;
        record.pendingResponseEvidence = undefined;
        record.updatedAt = timestamp;
        cancelled.push(structuredClone(record));
        continue;
      }
      let changed = false;
      if (source && source.threadId !== record.source.threadId) {
        record.sourceHistory = appendPartyHistory(record.sourceHistory, record.source);
        record.source = normalizedParty(source);
        changed = true;
      }
      if (target && target.threadId !== record.target.threadId) {
        record.targetHistory = appendPartyHistory(record.targetHistory, record.target);
        record.target = normalizedParty(target);
        record.nextReminderAt = timestamp;
        record.lastReminderError = undefined;
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
    const record = this.requests.get(cleanText(requestId, 100));
    if (!record || record.status !== "awaiting_response") return undefined;
    const source = normalizedParty(respondingParty);
    const target = normalizedParty(requestedTarget);
    if (!sameAgentParty(source, record.target)) {
      return undefined;
    }
    const requestedMatchesCurrent = sameAgentParty(target, record.source);
    const requestedMatchesHistory = !record.source.endpoint && (record.sourceHistory ?? []).some((party) =>
      sameAgentParty(target, party)
    );
    return requestedMatchesCurrent || requestedMatchesHistory
      ? structuredClone(record.source)
      : undefined;
  }

  prepare(input: PrepareAgentCommunicationInput): AgentCommunicationPreparation {
    const source = normalizedParty(input.source);
    const target = normalizedParty(input.target);
    if (source.endpoint && target.endpoint ? sameAgentEndpoint(source.endpoint, target.endpoint) : sameAgentParty(source, target)) {
      throw new AgentThreadContractError("Agent request source and target task must be different.", "threadId", "validation",
        "Select a different complete target owner; changing the Agent role does not create a different session.");
    }
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
      if (!sameAgentParty(source, repliedRequest.target) || !sameAgentParty(target, repliedRequest.source)) {
        throw new Error("Agent response must be sent from the original target task back to the original source task.");
      }
      if ((!source.endpoint || !target.endpoint || !repliedRequest.source.endpoint || !repliedRequest.target.endpoint)
        && (!workspaceMatches(source.workspace, repliedRequest.target.workspace)
          || !workspaceMatches(target.workspace, repliedRequest.source.workspace))) {
        throw new Error("Agent response workspace does not match the original request.");
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
        reminderCount: 0,
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
      current.nextReminderAt = undefined;
      current.lastReminderError = undefined;
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

  recordTargetTurnEnded(threadId: string, workspace: string | undefined, turnId: string, endedAt = this.now()): AgentRequestRecord[] {
    const id = cleanText(threadId, 4096);
    const normalizedTurnId = cleanText(turnId, 200);
    if (!id || !normalizedTurnId) return [];
    const timestamp = endedAt.toISOString();
    const nextReminderAt = new Date(endedAt.getTime() + AGENT_REQUEST_REMINDER_MS).toISOString();
    const changed: AgentRequestRecord[] = [];
    for (const record of this.requests.values()) {
      if (record.status !== "awaiting_response" || record.target.threadId !== id) continue;
      if (!workspaceMatches(record.target.workspace, workspace)) continue;
      if (record.lastTargetTurnId === normalizedTurnId) continue;
      record.lastTargetTurnId = normalizedTurnId;
      record.lastTargetTurnEndedAt = timestamp;
      record.nextReminderAt = nextReminderAt;
      record.updatedAt = timestamp;
      changed.push(structuredClone(record));
    }
    if (changed.length) {
      this.persistMutations(changed.map(record => ({
        action: "target_turn_ended",
        requestId: record.id,
        afterStatus: record.status,
        changes: [
          { field: "lastTargetTurnId" },
          { field: "nextReminderAt" }
        ]
      })));
    }
    return changed;
  }

  dueReminders(at = this.now()): AgentRequestRecord[] {
    const nowMs = at.getTime();
    return [...this.requests.values()]
      .filter((record) => record.status === "awaiting_response"
        && Boolean(record.nextReminderAt)
        && (Date.parse(record.nextReminderAt || "") || Number.POSITIVE_INFINITY) <= nowMs)
      .sort((left, right) => Date.parse(left.nextReminderAt || "") - Date.parse(right.nextReminderAt || ""))
      .map((record) => structuredClone(record));
  }

  recordPendingResponseCheck(requestId: string, deliveryId: string, status: string): void {
    const record = this.requests.get(requestId);
    if (record?.status !== "awaiting_response" || record.pendingResponseDeliveryId !== deliveryId) return;
    record.nextReminderAt = undefined;
    record.lastReminderError = `Response receipt needs reconciliation: ${cleanText(status, 100)}`;
    record.updatedAt = nowIso(this.now);
    this.persistMutations([{
      action: "response_receipt_pending", requestId, afterStatus: record.status,
      changes: [{ field: "nextReminderAt" }, { field: "lastReminderError" }]
    }]);
  }

  recordReminderResult(requestId: string, delivered: boolean, error?: unknown): AgentRequestRecord {
    const record = this.requests.get(cleanText(requestId, 100));
    if (!record) throw new Error(`Agent request not found: ${requestId}`);
    if (record.status !== "awaiting_response") return structuredClone(record);
    const timestamp = nowIso(this.now);
    record.reminderCount += 1;
    record.lastReminderAt = timestamp;
    record.lastReminderError = delivered
      ? undefined
      : cleanText(error instanceof Error ? error.message : error, 4_000) || "Agent request reminder delivery failed.";
    record.nextReminderAt = delivered
      ? undefined
      : new Date(this.now().getTime() + AGENT_REQUEST_REMINDER_MS).toISOString();
    record.updatedAt = timestamp;
    this.persistMutations([{
      action: delivered ? "reminder_delivered" : "reminder_failed",
      requestId: record.id,
      afterStatus: record.status,
      changes: [
        { field: "reminderCount", to: record.reminderCount },
        { field: "nextReminderAt" }
      ]
    }]);
    return structuredClone(record);
  }

  cancel(requestId: string, reason?: string): AgentRequestRecord {
    const record = this.requests.get(cleanText(requestId, 100));
    if (!record) throw new Error(`Agent request not found: ${requestId}`);
    if (record.status === "responded" || record.status === "cancelled") return structuredClone(record);
    const beforeStatus = record.status;
    const before = structuredClone(record);
    const affected = [...this.deliveries.values()].filter(delivery => delivery.preparation.requestId === record.id || delivery.preparation.inReplyToRequestId === record.id);
    const deliveryBefore = affected.map(delivery => structuredClone(delivery));
    for (const delivery of affected) delivery.state = "cancelled";
    const timestamp = nowIso(this.now);
    record.status = "cancelled";
    record.cancelledAt = timestamp;
    record.cancelReason = cleanText(reason, 2_000) || undefined;
    record.nextReminderAt = undefined;
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

function appendPartyHistory(
  history: AgentRequestParty[] | undefined,
  party: AgentRequestParty
): AgentRequestParty[] {
  const rows = [...(history ?? []), normalizedParty(party)];
  const unique = new Map<string, AgentRequestParty>();
  for (const row of rows) unique.set(`${row.threadId}\n${row.workspace || ""}`, row);
  return [...unique.values()].slice(-20);
}
