import type { AgentUploadDto } from "./agentUploadStore.js";

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
