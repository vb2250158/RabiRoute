import type { AgentRequestStore, EndpointDeliveryMetadata } from "../agentRequests/store.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import type { AgentDeliveryRecord, AgentDeliveryRecordPage, AgentDeliveryRecordParty } from "../shared/agentDeliveryRecord.js";
import type { ApiOperationDefinition, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";

export type DeliveryRecordsContext = {
  agentRequests: AgentRequestStore;
  readNodeDeliveryRecords?: (nodeId: string, query: { action: "list" | "get"; intentId?: string; cursor?: string; limit?: number; state?: string; query?: string }) => Promise<unknown>;
};

function party(value: PreparedEndpointDelivery["target"]): AgentDeliveryRecordParty {
  return { kind: value.kind, instanceId: value.instanceId, nodeId: value.nodeId, provider: value.provider, sessionId: value.sessionId };
}

export function projectAgentDelivery(value: EndpointDeliveryMetadata): AgentDeliveryRecord {
  return {
    id: value.deliveryId, deliveryId: value.deliveryId, intentId: value.callerDeliveryId,
    state: value.state === "committed" ? "received" : value.state === "cancelled" ? "cancelled"
      : value.blockedReason ? "blocked" : value.state === "dispatching" ? "awaiting_confirmation" : "queued",
    source: party(value.source), target: party(value.target), ownerScope: "manager",
    createdAt: value.createdAt, updatedAt: value.updatedAt, lastAttemptAt: value.lastAttemptAt,
    nextAttemptAt: value.nextAttemptAt, attemptCount: value.attemptCount,
    reason: value.blockedReason ?? value.lastError?.message, errorCode: value.lastError?.code,
    receipt: value.receipt ? { deliveryId: value.receipt.deliveryId, accepted: value.receipt.accepted,
      action: value.receipt.action, transport: value.receipt.transport, endpoint: party(value.receipt.endpoint) } : undefined
  };
}

/** Pagination uses immutable delivery IDs, so insertion does not move an existing cursor. */
export function listAgentDeliveryRecords(store: AgentRequestStore, url: URL): AgentDeliveryRecordPage {
  const rawLimit = url.searchParams.get("limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 200) throw new Error("Delivery limit must be an integer from 1 to 200.");
  const limit = Number(rawLimit), cursor = url.searchParams.get("cursor"), state = url.searchParams.get("state");
  const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase();
  const unavailable: AgentDeliveryRecord[] = store.listUnavailableEndpointDeliveryIds().map(id => ({
    id, deliveryId: id, state: "blocked", source: {}, target: {}, ownerScope: "manager",
    errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE", reason: "Original delivery evidence is unavailable or invalid. Its ID remains reserved; automatic replay is forbidden."
  }));
  const sorted = [...store.listEndpointDeliveryMetadata().map(projectAgentDelivery), ...unavailable]
    .filter(value => (!state || value.state === state) && (!query || [value.id, value.intentId,
      value.source.provider, value.source.sessionId, value.source.nodeId, value.target.provider, value.target.sessionId,
      value.target.nodeId, value.reason].some(text => text?.toLocaleLowerCase().includes(query))))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id));
  const start = cursor ? sorted.findIndex(value => value.id === cursor) + 1 : 0;
  if (cursor && start === 0) throw new Error("Delivery cursor no longer matches this query; refresh the first page.");
  const records = sorted.slice(start, start + limit);
  return { records, ...(start + limit < sorted.length && records.length ? { nextCursor: records.at(-1)!.id } : {}),
    observedAt: new Date().toISOString(), coverage: { scope: "manager", includesDisconnectedNodeQueues: false } };
}

export function readAgentDeliveryRecord(store: AgentRequestStore, id: string): AgentDeliveryRecord | undefined {
  const value = store.getEndpointDelivery(id);
  return value ? projectAgentDelivery(value) : store.listUnavailableEndpointDeliveryIds().includes(id)
    ? { id, deliveryId: id, state: "blocked", source: {}, target: {}, ownerScope: "manager", errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE",
      reason: "Original delivery evidence is unavailable or invalid. Its ID remains reserved; automatic replay is forbidden." } : undefined;
}

/** Both HTTP registrations and the compatibility handler call the same read-only owner projection. */
export async function readDeliveryRecords(context: DeliveryRecordsContext, url: URL, id?: string): Promise<ApiOperationResult> {
  try {
    const nodeId = url.searchParams.get("nodeId");
    if (nodeId) {
      if (!context.readNodeDeliveryRecords) return { status: 503, body: { code: -1, errorCode: "DELIVERY_NODE_UNAVAILABLE", message: "The original computer queue cannot currently be observed; its pending records are not known to be empty." } };
      const data = await context.readNodeDeliveryRecords(nodeId, { action: id ? "get" : "list", intentId: id,
        cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
        state: url.searchParams.get("state") ?? undefined, query: url.searchParams.get("query") ?? undefined });
      return { status: 200, body: { code: 0, data } };
    }
    const evidence = context.agentRequests.getEndpointDeliveryEvidenceStatus();
    const known = id ? readAgentDeliveryRecord(context.agentRequests, id) : undefined;
    if (!evidence.available && !known) return { status: 503, body: { code: -1, errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE",
      message: evidence.reason ?? "The original delivery store cannot currently be observed." } };
    const data = id ? known : listAgentDeliveryRecords(context.agentRequests, url);
    return data ? { status: 200, body: { code: 0, data } }
      : { status: 404, body: { code: -1, message: "Delivery record not found." } };
  } catch (error) {
    const unavailable = ["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((error as { code?: unknown })?.code));
    return { status: url.searchParams.has("nodeId") || unavailable ? 503 : 400,
      body: { code: -1, message: error instanceof Error ? error.message : String(error),
        ...(url.searchParams.has("nodeId") ? { errorCode: "DELIVERY_NODE_UNAVAILABLE" } : unavailable ? { errorCode: "DELIVERY_EVIDENCE_UNAVAILABLE" } : {}) } };
  }
}

export function createAgentDeliveryRecordOperations(context: DeliveryRecordsContext): readonly ApiOperationDefinition[] {
  const text = { type: "string" } as const;
  const endpoint = { type: "object", properties: { kind: text, instanceId: text, nodeId: text, provider: text, sessionId: text }, additionalProperties: false } as const;
  const record: ApiSchema = { type: "object", required: ["id", "deliveryId", "state", "source", "target", "ownerScope"], properties: {
    id: text, deliveryId: text, intentId: text, state: { enum: ["queued", "sending", "awaiting_confirmation", "received", "blocked", "failed", "cancelled"] },
    source: endpoint, target: endpoint, ownerScope: { enum: ["manager", "node"] }, createdAt: text, updatedAt: text,
    lastAttemptAt: text, nextAttemptAt: text, attemptCount: { type: "integer", minimum: 0 }, reason: text, errorCode: text,
    receipt: { type: "object" }, targetAcceptedAt: text
  }, additionalProperties: false };
  const page: ApiSchema = { type: "object", required: ["records", "coverage", "observedAt"], properties: {
    records: { type: "array", items: record }, nextCursor: text, observedAt: text,
    coverage: { type: "object", required: ["scope", "includesDisconnectedNodeQueues"], properties: {
      scope: { enum: ["manager", "node"] }, includesDisconnectedNodeQueues: { type: "boolean" }, nodeId: text, connected: { type: "boolean" }, message: text
    }, additionalProperties: false }
  }, additionalProperties: false };
  return [false, true].map(detail => ({
    contract: {
      operationId: detail ? "agent.deliveries.read" : "agent.deliveries.list", aliases: [`agent:GET:/api/agent/deliveries${detail ? "/:deliveryId" : ""}`],
      contractVersion: "1.0.0", method: "GET", pathTemplate: `/api/agent/deliveries${detail ? "/:deliveryId" : ""}`,
      description: "Read durable delivery records and actual acceptance evidence without dispatch or reconciliation.", exposure: "public", transport: "http",
      request: { path: { type: "object", ...(detail ? { required: ["deliveryId"] } : {}), properties: detail ? { deliveryId: text } : {}, additionalProperties: false },
        query: { type: "object", properties: { nodeId: text, ...(detail ? {} : { cursor: text, limit: { type: "string", pattern: "^[1-9][0-9]*$" }, state: text, query: text }) }, additionalProperties: false },
        headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: detail ? record : page }, additionalProperties: false } },
        ...Object.fromEntries([400, 404, 503].map(status => [String(status), { mediaType: "application/json", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: text, errorCode: text }, additionalProperties: false } }])) },
      effects: { mode: "read", description: "Projects the original durable owner. Does not send messages, reconcile, mark viewed, or infer offline queues are empty." },
      recovery: { strategy: "repeatable-read", description: "Refresh the same owner and record. A missing record or disconnected computer is not proof that its original prompt was never accepted." },
      validators: [{ id: "agent.delivery-records.owner", description: "The original store validates records; this projection excludes prompts, execution credentials and authorization leases. Page limits are 1..200, cursors are immutable IDs scoped to the current filter. Optional nodeId reads the original authenticated computer only." }]
    }, handler: input => readDeliveryRecords(context, input.url, detail ? input.path.deliveryId : undefined)
  }));
}
