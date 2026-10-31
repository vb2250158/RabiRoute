import type { AgentUploadDto } from "./agentUploadStore.js";
import type { ApiOperationContract } from "./apiOperationContract.js";

// Descriptive Help data only: never used to authorize or validate an upload.
// Keep wire shape in step with publicDto in agentUploadRoutes and the store DTO.
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
export const agentUploadIdPattern = new RegExp(uuid.pattern);
const dtoProperties = {
  id: uuid,
  fileName: { type: "string" },
  size: { type: "integer", minimum: 0 },
  sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  expiresAt: { type: "string", format: "date-time" }
} as const satisfies Record<keyof AgentUploadDto, unknown>;

const successResponse = {
  mediaType: "application/json",
  scope: "success-body-shape",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["code", "data"],
    properties: {
      code: { const: 0 },
      data: {
        type: "object",
        additionalProperties: false,
        required: ["id", "fileName", "size", "sha256", "expiresAt"],
        properties: dtoProperties
      }
    }
  }
} as const;

const path = { uploadId: { required: true, schema: uuid } } as const;
const commonMissing = [
  "authentication-and-authorization-boundaries",
  "error-response-schemas",
  "response-header-contract",
  "storage-dto-semantic-constraints"
] as const;

const contracts = freezeTree({
  PUT: {
    version: 1,
    kind: "partial-upload-contract",
    request: {
      path,
      query: { allowed: [] },
      // Header names are case-insensitive. These are business headers, not an auth contract.
      headers: {
        "idempotency-key": { required: true, singleValue: true, equalsPathParameter: "uploadId" },
        "content-type": { required: true, singleValue: true, value: "application/octet-stream", caseInsensitiveValue: true, parametersAllowed: false },
        "x-rabiroute-content-sha256": { required: true, singleValue: true, schema: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
        "x-rabiroute-file-name": { required: true, singleValue: true, encoding: "encodeURIComponent", decodedValue: "basename", validation: "route-and-store" },
        "content-length": { required: false, singleValue: true, interpretation: "Number(header); nonnegative safe integer checked by store; must equal received byte count" },
        "content-encoding": { forbidden: true }
      },
      // Raw bytes are not a JSON instance: intentionally no JSON Schema for body.
      body: { kind: "binary", mediaType: "application/octet-stream", encoding: "raw", emptyAllowed: true }
    },
    responses: { "200": successResponse },
    missing: [...commonMissing, "decoded-filename-validation", "stream-integrity-and-length-validation", "runtime-size-capacity-concurrency-and-timeout-limits"]
  },
  GET: {
    version: 1,
    kind: "partial-upload-contract",
    request: {
      path,
      query: { allowed: [] },
      headers: {},
      body: { kind: "none", enforcement: "handler-does-not-read-body" }
    },
    responses: { "200": successResponse },
    missing: [...commonMissing, "ownership-expiry-and-integrity-checks"]
  }
} as const);

export type AgentUploadMachineContract = (typeof contracts)[keyof typeof contracts];

/** No fallback schemas for other routes or methods. Absence means not described. */
export function getAgentUploadContract(method: string, pathTemplate: string): AgentUploadMachineContract | undefined {
  if (pathTemplate !== "/api/agent/uploads/:uploadId" || (method !== "PUT" && method !== "GET")) return undefined;
  return contracts[method];
}

/** Executable structural contracts; the upload owner retains authorization, lease and byte-integrity validation. */
export function agentUploadOperationContract(method: "GET" | "PUT", maxBytes: number): ApiOperationContract {
  const error = { type: "object", required: ["code", "errorCode", "help", "repair", "retryable"], properties: {
    code: { type: "string" }, errorCode: { type: "string" }, help: { type: "object" }, repair: { type: "string" },
    retryable: { const: false }, uncertain: { type: "boolean" }
  }, additionalProperties: false } as const;
  const response = { mediaType: "application/json", schema: error } as const;
  return {
    operationId: `agent.upload.${method === "PUT" ? "write" : "read"}`, contractVersion: "1.0.0", method,
    aliases: [`agent:${method}:/api/agent/uploads/:uploadId`],
    pathTemplate: "/api/agent/uploads/:uploadId", description: method === "PUT" ? "Stream a file to managed storage without sending it." : "Read the original upload receipt.",
    exposure: "public", transport: "http",
    request: {
      path: { type: "object", required: ["uploadId"], properties: { uploadId: uuid }, additionalProperties: false },
      query: { type: "object", properties: {}, additionalProperties: false },
      headers: method === "PUT" ? { type: "object", required: ["idempotency-key", "content-type", "x-rabiroute-file-name", "x-rabiroute-content-sha256"],
        properties: { "idempotency-key": uuid, "content-type": { type: "string" },
          "x-rabiroute-file-name": { type: "string", minLength: 1 }, "x-rabiroute-content-sha256": { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
          "content-encoding": false }, additionalProperties: true } : { type: "object", additionalProperties: true },
      body: method === "GET" ? { kind: "none" } : { kind: "binary", mediaType: "application/octet-stream", maxBytes,
        rules: ["agent.upload.integrity", "agent.upload.capacity", "agent.upload.authorization-lease"] }
    },
    responses: { "200": { mediaType: "application/json", schema: successResponse.schema },
      "400": response, "403": response, "404": response, "408": response, "409": response, "413": response,
      "415": response, "422": response, "429": response, "500": response, "503": response, "507": response },
    effects: { mode: method === "PUT" ? "mutating" : "read", description: method === "PUT" ? "Stores uploaded bytes and an owned receipt; never sends a chat message." : "Reads upload metadata under the current admitted-connection and storage-owner lookup policy." },
    recovery: { strategy: "receipt-first", description: "Keep the same upload ID and bytes; query the original receipt before any upload retry.",
      receiptPath: "/api/agent/uploads/:uploadId", ...(method === "PUT" ? { idempotencyHeader: "Idempotency-Key" } : {}) },
    validators: [
      { id: "agent.upload.authorization-lease", description: "The business owner validates the admitted connection/source, configured storage lookup scope and revocation before commit and response." },
      { id: "agent.upload.integrity", description: "The idempotency header equals uploadId; the decoded filename is a basename; received length and SHA-256 must match." },
      { id: "agent.upload.capacity", description: "The storage owner enforces expiry, total bytes, file count, concurrency and read deadlines without buffering the whole upload." }
    ]
  };
}
