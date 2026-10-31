import { ReadSettingsError } from "../shared/readSettingsError.js";
import { AGENT_SEND_BUSINESS_VALIDATORS, AGENT_SEND_CHANNEL_HELP, AGENT_SEND_REQUEST_CONTRACT, AGENT_SEND_WIRE_SCHEMA } from "../agentSendContracts.js";
import type { AgentSendRequest } from "../agentSend.js";
import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import { getTrustedLanAgentSource, hasLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { apiDigest, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationResult } from "./apiOperationContract.js";
import type { IncomingMessage } from "node:http";

type SendContext = Pick<AgentCommunicationRoutesContext, "send" | "receiptResponse">;

const empty = { type: "object", properties: {}, additionalProperties: false } as const;
const deliveryId = { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" } as const;
const json = (schema: Readonly<Record<string, unknown>>) => ({ mediaType: "application/json", schema });
const sendResult = json({ type: "object", required: ["code", "ok", "status"], properties: {
  code: { enum: [0, -1] }, ok: { type: "boolean" }, status: { enum: ["sent", "draft", "blocked", "failed",
    "conversation_context_confirmation_required", "message_length_confirmation_required", "style_confirmation_required"] },
  reason: { type: "string" }, deliveryId, sender: { type: "object", required: ["agentType", "sessionId"], additionalProperties: false,
    properties: { agentType: { type: "string" }, sessionId: { type: "string" } } },
  routeId: { type: "string" }, channel: { enum: AGENT_SEND_CHANNEL_HELP.map(value => value.channel) }, target: { type: "object" },
  idempotency: { type: "object", required: ["deliveryId", "state", "duplicate"], additionalProperties: false,
    properties: { deliveryId, state: { enum: ["completed", "missing", "in_progress", "uncertain", "conflict"] }, duplicate: { type: "boolean" } } }
}, additionalProperties: true });
const blocked = json({ type: "object", required: ["code", "ok", "status", "message", "contract"], properties: {
  code: { const: -1 }, ok: { const: false }, status: { const: "blocked" }, message: { type: "string" },
  errorCode: { type: "string" }, supportedChannels: { type: "array", items: { type: "string" } },
  help: { type: "array", items: { type: "object" } }, repair: { type: "string" }, contract: { type: "object" }
}, additionalProperties: false });

export const agentSendOperationContract: ApiOperationContract = {
  operationId: "agent.send", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/agent/send",
  aliases: ["agent:POST:/api/agent/send"],
  description: "Send through an explicitly selected channel, using a durable delivery ID and the existing provider rules.",
  exposure: "public", transport: "http",
  request: { path: empty, query: empty, headers: { type: "object" },
    // The existing shared JSON reader has no route-specific byte ceiling. Do not
    // invent a smaller remote-only limit while migrating its executable contract.
    body: { kind: "json", schema: AGENT_SEND_WIRE_SCHEMA, maxBytes: Number.MAX_SAFE_INTEGER } },
  responses: { "200": sendResult, "202": sendResult, "400": blocked, "403": sendResult,
    "409": sendResult, "502": sendResult, "503": sendResult },
  effects: { mode: "external-send", description: "May deliver to an external provider, create a draft, or retain a blocked/failed/uncertain durable receipt. A response alone does not prove platform delivery." },
  recovery: { strategy: "receipt-first", receiptPath: "/api/agent/send/receipts/:deliveryId",
    description: "Keep the same deliveryId (body.deliveryId) and original request. On timeout, generation/contract mismatch or uncertainty query the original receipt; never automatically replay or change the target/channel." },
  validators: AGENT_SEND_BUSINESS_VALIDATORS
};

/** Shared by the executable route and the temporary raw-dispatch adapter. */
export async function runAgentSend(request: IncomingMessage, body: AgentSendRequest, context: SendContext): Promise<ApiOperationResult> {
  try {
    const remoteSource = getTrustedLanAgentSource(request);
    if (hasLanAgentBodyGuard(request) && !remoteSource) throw new Error("Remote Agent trusted source session is unavailable.");
    const requestAuthority = () => { assertTrustedLanAgentPrincipal(request); hasAuthenticatedConnectionRequest(request); };
    requestAuthority();
    const result = await context.send(body, { remoteSource, requestAuthority });
    requestAuthority();
    return { status: result.statusCode, body: { code: result.body.ok ? 0 : -1, ...result.body } };
  } catch (error) {
    return agentSendError(error);
  }
}

export function agentSendError(error: unknown): ApiOperationResult {
  if (error instanceof ReadSettingsError) return { status: 503, body: { code: -1, ok: false, status: "failed", message: error.message, errorCode: error.code, reason: "dependency_unavailable" } };
  if (error instanceof Error && error.name === "ManagerReadWorkerError") {
    const readError = error as Error & { code?: string };
    return { status: 503, body: { code: -1, ok: false, status: "failed", message: error.message,
      errorCode: `MANAGER_READ_${String(readError.code || "failed").toUpperCase()}`, reason: "dependency_unavailable",
      repair: "A Manager read dependency did not complete. Inspect the named read task and the original delivery receipt; do not upload again merely because the request timed out." } };
  }
  const detail = error && typeof error === "object" ? error as { code?: unknown; supportedChannels?: unknown; help?: unknown; repair?: unknown } : {};
  return { status: 400, body: { code: -1, ok: false, status: "blocked", message: error instanceof Error ? error.message : String(error),
    errorCode: typeof detail.code === "string" ? detail.code : "AGENT_SEND_CONTRACT_ERROR",
    ...(Array.isArray(detail.supportedChannels) ? { supportedChannels: detail.supportedChannels } : {}),
    ...(Array.isArray(detail.help) ? { help: detail.help } : {}), ...(typeof detail.repair === "string" ? { repair: detail.repair } : {}),
    contract: { method: agentSendOperationContract.method, path: agentSendOperationContract.pathTemplate,
      requiredFields: AGENT_SEND_WIRE_SCHEMA.required, senderFields: AGENT_SEND_WIRE_SCHEMA.properties.sender.required,
      retryRule: agentSendOperationContract.recovery.description } } };
}

export function agentSendCapabilities(): ApiOperationResult {
  return { status: 200, headers: { "cache-control": "no-store" }, body: { code: 0, data: {
    schemaVersion: "2", contractRevision: agentSendOperationContract.contractVersion,
    channelsDigest: apiDigest(AGENT_SEND_CHANNEL_HELP), requestContractDigest: apiDigest(AGENT_SEND_REQUEST_CONTRACT),
    requestContract: AGENT_SEND_REQUEST_CONTRACT,
    generatedAt: new Date().toISOString(), channels: AGENT_SEND_CHANNEL_HELP,
    contract: { deliveryId: "stable caller-generated ID", retryRule: agentSendOperationContract.recovery.description,
      qq: "QQ/NapCat uses channel=napcat, params.target=group|private. Managed fileId supports group files only; private managed-file upload is not implemented." }
  } } };
}

export function createAgentSendOperations(context: SendContext): readonly ApiOperationDefinition[] {
  return [
    { contract: agentSendOperationContract, handler: input => runAgentSend(input.request, input.body as AgentSendRequest, context) },
    { contract: {
      operationId: "agent.send.capabilities", contractVersion: "2.0.0", method: "GET", pathTemplate: "/api/agent/send/capabilities",
      aliases: ["agent:GET:/api/agent/send/capabilities"],
      description: "Read the same channel definitions, wire schema and named business validators used by the send operation.",
      exposure: "public", transport: "http", request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": json({ type: "object", required: ["code", "data"], additionalProperties: false, properties: {
        code: { const: 0 }, data: { type: "object", required: ["schemaVersion", "contractRevision", "channelsDigest", "requestContractDigest", "requestContract", "generatedAt", "channels", "contract"],
          additionalProperties: false, properties: { schemaVersion: { const: "2" }, contractRevision: { type: "string" }, channelsDigest: { type: "string" }, requestContractDigest: { type: "string" },
            requestContract: { type: "object", required: ["version", "kind", "schema", "validators"], additionalProperties: false,
              properties: { version: { const: 2 }, kind: { const: "runtime-json-schema" }, schema: { type: "object" }, validators: { type: "array", items: { type: "object" } } } },
            generatedAt: { type: "string", format: "date-time" }, channels: { type: "array", items: { type: "object" } }, contract: { type: "object" } } }
      } }) }, effects: { mode: "read", description: "Reads immutable send definitions; does not send or reserve a delivery." },
      recovery: { strategy: "repeatable-read", description: "Refresh after the API catalog identity changes; discovery does not grant additional permissions." }, validators: []
    }, handler: () => agentSendCapabilities() },
    { contract: {
      operationId: "agent.send.receipt.read", contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/agent/send/receipts/:deliveryId",
      aliases: ["agent:GET:/api/agent/send/receipts/:deliveryId"],
      description: "Read the original durable send receipt without creating or retrying a delivery.", exposure: "public", transport: "http",
      request: { path: { type: "object", required: ["deliveryId"], properties: { deliveryId }, additionalProperties: false },
        query: empty, headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": sendResult, "202": sendResult, "403": sendResult, "404": sendResult, "409": sendResult, "502": sendResult },
      effects: { mode: "read", description: "Reads the stored receipt and checks whether the original execution is active. Does not send or settle." },
      recovery: { strategy: "repeatable-read", receiptPath: "/api/agent/send/receipts/:deliveryId", description: "Keep the same deliveryId. Missing, in_progress and uncertain states do not authorize another send." }, validators: []
    }, handler: input => { const result = context.receiptResponse(input.path.deliveryId!);
      return { status: result.statusCode, body: { code: result.statusCode < 400 ? 0 : -1, ...result.body } }; } }
  ];
}
