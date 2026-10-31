import type { IncomingMessage } from "node:http";
import { AGENT_SEND_FIELD_NAMES } from "../agentSendContracts.js";
import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

type ReceiptContext = Pick<AgentCommunicationRoutesContext, "maintenance">;

const deliveryId = { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" } as const;
const fields = AGENT_SEND_FIELD_NAMES.request.filter(value => value !== "conversationContext");
const original = { type: "object", required: ["deliveryId", "sender", "routeId", "channel", "params", "payload"],
  properties: { ...Object.fromEntries(fields.map(value => [value, true])), deliveryId,
    sender: { type: "object", required: ["agentType", "sessionId"], additionalProperties: false,
      properties: { agentType: { type: "string", pattern: "\\S" }, sessionId: { type: "string", pattern: "\\S" } } },
    routeId: { type: "string", pattern: "\\S" }, channel: { type: "string", pattern: "\\S" }, params: { type: "object" }, payload: { type: "object" } }, additionalProperties: false };
const failure = { mediaType: "application/json", schema: { type: "object", required: ["code", "ok", "status", "errorCode", "message"],
  properties: { code: { const: -1 }, ok: { const: false }, status: { const: "blocked" }, errorCode: { type: "string" }, message: { type: "string" } }, additionalProperties: false } };
const result = { mediaType: "application/json", schema: { type: "object", required: ["code", "deliveryId", "platformVerification", "settlement", "retryAllowed", "deliveredNow", "state"],
  properties: { code: { anyOf: [{ type: "integer" }, { type: "string" }] }, deliveryId, platformVerification: { enum: ["present", "unknown"] },
    settlement: { enum: ["committed", "not_attempted", "failed"] }, retryAllowed: { const: false }, deliveredNow: { const: false },
    state: { enum: ["verified", "completed", "missing", "conflict", "in_progress", "uncertain"] }, evidence: true, originalResult: { type: "object" } }, additionalProperties: false } };

export function agentReceiptMaintenanceFailure(status: number, errorCode: string, message: string): ApiOperationResult {
  return { status, body: { code: -1, ok: false, status: "blocked", errorCode, message } };
}

/** Both dispatch adapters call this owner; no HTTP path can create a verifier or send capability. */
export async function runAgentReceiptMaintenance(request: IncomingMessage, url: URL, id: string, action: "verify" | "settle", body: unknown,
  context: ReceiptContext): Promise<ApiOperationResult> {
  if (!context.maintenance || typeof context.maintenance[action] !== "function") {
    return agentReceiptMaintenanceFailure(503, "AGENT_SEND_MAINTENANCE_UNAVAILABLE", "Receipt maintenance is unavailable.");
  }
  try {
    const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const originalRequest = isObject(body) ? body.originalRequest : undefined;
    if (url.search || id.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(id)
      || !isObject(body) || Object.keys(body).length !== 1 || !isObject(originalRequest)
      || Object.keys(originalRequest).some(key => !fields.includes(key)) || originalRequest.deliveryId !== id
      || !isObject(originalRequest.sender) || Object.keys(originalRequest.sender).some(key => !AGENT_SEND_FIELD_NAMES.sender.includes(key))
      || typeof originalRequest.sender.agentType !== "string" || !originalRequest.sender.agentType.trim()
      || typeof originalRequest.sender.sessionId !== "string" || !originalRequest.sender.sessionId.trim()
      || typeof originalRequest.routeId !== "string" || !originalRequest.routeId.trim()
      || typeof originalRequest.channel !== "string" || !originalRequest.channel.trim()
      || !isObject(originalRequest.params) || !isObject(originalRequest.payload)) {
      return agentReceiptMaintenanceFailure(400, "AGENT_SEND_MAINTENANCE_INVALID_REQUEST", "Invalid receipt maintenance request.");
    }
    const remoteSource = getTrustedLanAgentSource(request);
    if (hasLanAgentBodyGuard(request) && !remoteSource) return agentReceiptMaintenanceFailure(403, "AGENT_SEND_MAINTENANCE_SOURCE_UNAVAILABLE", "Trusted source session is unavailable.");
    const requestAuthority = () => { assertTrustedLanAgentPrincipal(request); hasAuthenticatedConnectionRequest(request); };
    requestAuthority();
    const response = await context.maintenance[action](id, originalRequest, { remoteSource, requestAuthority });
    requestAuthority();
    return { status: response.statusCode, body: { code: response.statusCode < 400 ? 0 : -1, ...response.body } };
  } catch {
    return agentReceiptMaintenanceFailure(400, "AGENT_SEND_MAINTENANCE_FAILED", "Receipt maintenance failed; read the original receipt before further action.");
  }
}

export function createAgentReceiptMaintenanceOperations(context: ReceiptContext): ApiOperationDefinition[] {
  return (["verify", "settle"] as const).map(action => ({ contract: {
    operationId: `agent.send.receipt.${action}`, contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/agent/send/receipts/:deliveryId/${action}`,
    aliases: [`agent:POST:/api/agent/send/receipts/:deliveryId/${action}`],
    description: action === "verify" ? "Read trusted evidence for the original delivery without sending or settling." : "Settle the original receipt only when trusted evidence proves its complete terminal result; never send again.",
    exposure: "public", transport: "http",
    request: { path: { type: "object", required: ["deliveryId"], properties: { deliveryId }, additionalProperties: false },
      query: { type: "object", properties: {}, additionalProperties: false }, headers: { type: "object" }, body: { kind: "json", maxBytes: Number.MAX_SAFE_INTEGER,
        schema: { type: "object", required: ["originalRequest"], properties: { originalRequest: original }, additionalProperties: false } } },
    responses: { "200": result, "400": failure, "403": failure, "404": result,
      "409": result, "503": { ...result, alternatives: [failure] } },
    effects: { mode: action === "verify" ? "read" : "mutating", description: action === "verify" ? "Reads original receipt and provider evidence; does not deliver or alter the receipt." : "May commit the original durable receipt after trusted verification; does not deliver or create another request." },
    recovery: { strategy: "receipt-first", receiptPath: "/api/agent/send/receipts/:deliveryId", description: "Keep the same deliveryId and complete original request. Unknown verification or a missing receipt does not authorize a retry." },
    validators: [{ id: "agent.send.receipt.original-binding", description: "originalRequest.deliveryId must equal the path; the existing owner verifies its complete digest, sender, Route, current source, original receipt and trusted provider evidence. Client evidence/verifier/result/currentAccount fields are forbidden. The current maintenance adapter does not accept conversationContext; it is excluded from durable identity." }]
  }, handler: input => runAgentReceiptMaintenance(input.request, input.url, input.path.deliveryId!, action, input.body, context) }));
}
