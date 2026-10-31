import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";
import { prepareApiJsonBody } from "./apiPreparedJson.js";

type Context = Pick<AgentCommunicationRoutesContext, "agentRequests" | "refreshAgentRequestReminderTimers" | "publishManagerEvent" | "findSendTraces">;
const empty = { type: "object", properties: {}, additionalProperties: false } as const;
const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"], additionalProperties: false,
  properties: { code: { const: -1 }, message: { type: "string" }, errorCode: { type: "string" },
    commitState: { enum: ["not_started", "unknown"] }, uncertain: { type: "boolean" }, retryable: { type: "boolean" } } } };
const text = { type: "string" };
const party = { type: "object", required: ["threadId", "agentType"], properties: { threadId: text, agentType: text,
  threadName: text, workspace: text, agentAdapter: text, endpoint: { type: "object" } }, additionalProperties: true };
const record: ApiSchema = { type: "object", required: ["id", "deliveryId", "status", "source", "target", "responseInstruction", "createdAt", "reminderCount", "updatedAt"],
  properties: { id: text, deliveryId: text, status: { enum: ["pending_delivery", "awaiting_response", "responded", "cancelled"] },
    source: party, target: party, responseInstruction: text, createdAt: text, updatedAt: text, reminderCount: { type: "integer", minimum: 0 } }, additionalProperties: true };
const success = (data: ApiSchema) => ({ mediaType: "application/json", schema: { type: "object", required: ["code", "data"],
  properties: { code: { const: 0 }, data }, additionalProperties: false } });
function failure(value: unknown, mutating = false): ApiOperationResult {
  const unavailable = value && typeof value === "object"
    && ["AGENT_REQUEST_STORE_UNAVAILABLE", "AGENT_REQUEST_COMMIT_UNKNOWN"].includes(String((value as { code?: unknown }).code));
  const unknown = mutating && unavailable && (value as { commitState?: unknown }).commitState === "unknown";
  return { status: unavailable ? 503 : 400, ...(unknown ? { mutationOutcome: "unknown" as const } : {}),
    body: { code: -1, message: value instanceof Error ? value.message : String(value),
      ...(unavailable ? { errorCode: String((value as { code: unknown }).code),
        ...(mutating ? { commitState: unknown ? "unknown" : "not_started", uncertain: Boolean(unknown), retryable: false } : {}) } : {}) } };
}

export async function readAgentRequests(url: URL, context: Context, signal?: AbortSignal): Promise<ApiOperationResult> {
  try {
    const status = url.searchParams.get("status")?.trim();
    const requests = await context.agentRequests.readRequests();
    signal?.throwIfAborted();
    const filtered = requests.filter(item => !status || item.status === status);
    return { status: 200, body: await prepareApiJsonBody({ code: 0, data: { requests: filtered } }, filtered, signal) };
  } catch (value) { return failure(value); }
}
export function readAgentRequest(id: string, context: Context): ApiOperationResult {
  try {
    const item = context.agentRequests.get(id);
    return item ? { status: 200, body: { code: 0, data: item } }
      : { status: 404, body: { code: -1, message: `Agent request not found: ${id}` } };
  } catch (value) { return failure(value); }
}
export async function cancelAgentRequest(id: string, body: unknown, context: Context): Promise<ApiOperationResult> {
  let data: Awaited<ReturnType<Context["agentRequests"]["cancel"]>>;
  try {
    data = await context.agentRequests.cancel(id, (body as { reason?: string }).reason);
  } catch (value) { return failure(value, true); }
  for (const [stage, observer] of [
    ["reminder_refresh", () => context.refreshAgentRequestReminderTimers()],
    ["change_event", () => context.publishManagerEvent("agent_requests_changed", { requestId: data.id, status: data.status })]
  ] as const) {
    const report = () => { console.error(JSON.stringify({ event: "agent_request_cancel_bookkeeping_failed", stage, requestId: data.id, result: "observer_failed" })); };
    try { void Promise.resolve(observer()).catch(report); }
    catch { report(); }
  }
  return { status: 200, body: { code: 0, data } };
}
export function readAgentSendTraces(url: URL, context: Context): ApiOperationResult {
  try {
    const matches = context.findSendTraces({ channel: url.searchParams.get("channel"), sentMessageId: url.searchParams.get("sentMessageId"), routeId: url.searchParams.get("routeId") });
    return { status: 200, body: { code: 0, data: { matches } } };
  } catch (value) { return failure(value); }
}

export function createAgentCommunicationRecordOperations(context: Context): readonly ApiOperationDefinition[] {
  const define = (operationId: string, method: ApiOperationContract["method"], pathTemplate: string, description: string,
    request: ApiOperationContract["request"], response: ApiSchema, handler: ApiOperationDefinition["handler"]): ApiOperationDefinition => ({
    contract: { operationId, aliases: [`agent:${method}:${pathTemplate}`], contractVersion: "1.0.0", method, pathTemplate, description, exposure: "public", transport: "http", request,
      responses: { "200": success(response), "400": error, "404": error, "503": error },
      effects: { mode: method === "GET" ? "read" : "mutating", description: method === "GET" ? "Reads existing records without sending or updating viewed state." : "Marks the existing request and its prepared deliveries cancelled, refreshes reminder scheduling, and publishes the existing change event; does not send a message." },
      recovery: { strategy: method === "GET" ? "repeatable-read" : "read-original-resource", description: method === "GET" ? "Repeat under the same identity if the contract permits; reads do not create or resend deliveries." : "Read the same requestId after uncertainty. Existing terminal responded/cancelled records are returned unchanged; do not create a replacement request." },
      validators: [{ id: operationId === "agent.send.traces" ? "agent.send.traces.filters" : "agent.requests.record-owner", description: operationId === "agent.send.traces"
        ? "The receipt owner normalizes channel/sentMessageId/routeId, requires nonempty channel and sentMessageId with at most 500 characters and no controls, reads only completed receipts, and returns at most 100 newest matches."
        : "The existing request store owns ID normalization, persistence, terminal-state behavior and related prepared deliveries. Optional record/endpoint/history fields remain owned by the store. Cancellation reason uses existing string-only trim/truncate normalization; other values mean absent." }]
    }, handler
  });
  const resourcePath = { type: "object", required: ["requestId"], properties: { requestId: { type: "string", minLength: 1 } }, additionalProperties: false } as const;
  return [
    define("agent.requests.list", "GET", "/api/agent/requests", "List existing Agent requests, optionally filtering by status.",
      { path: empty, query: { type: "object", properties: { status: { type: "string" } }, additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
      { type: "object", required: ["requests"], properties: { requests: { type: "array", items: record } }, additionalProperties: false }, input => readAgentRequests(input.url, context, input.signal)),
    define("agent.requests.read", "GET", "/api/agent/requests/:requestId", "Read one Agent request by its original ID.",
      { path: resourcePath, query: empty, headers: { type: "object" }, body: { kind: "none" } }, record, input => readAgentRequest(input.path.requestId!, context)),
    define("agent.requests.cancel", "POST", "/api/agent/requests/:requestId/cancel", "Cancel an existing Agent request and its prepared deliveries without another send.",
      { path: resourcePath, query: empty, headers: { type: "object" }, body: { kind: "json", maxBytes: Number.MAX_SAFE_INTEGER,
        schema: { anyOf: [{ type: "object", properties: { reason: true }, additionalProperties: true }, { type: "array" }, { type: "string" }, { type: "number" }, { type: "boolean" }] } } },
      record, input => cancelAgentRequest(input.path.requestId!, input.body, context)),
    define("agent.send.traces", "GET", "/api/agent/send/traces", "Find up to 100 completed send receipts by original channel and platform message ID.",
      { path: empty, query: { type: "object", required: ["channel", "sentMessageId"], properties: { channel: text, sentMessageId: text, routeId: text }, additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
      { type: "object", required: ["matches"], additionalProperties: false, properties: { matches: { type: "array", maxItems: 100, items: {
        type: "object", required: ["deliveryId", "createdAt", "updatedAt", "result"], properties: { deliveryId: text, createdAt: text, updatedAt: text, result: { type: "object" } }, additionalProperties: false
      } } } }, input => readAgentSendTraces(input.url, context))
  ];
}
