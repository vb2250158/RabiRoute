import type { ApiOperationContract } from "./apiOperationContract.js";

export function fixtureApiContract(overrides: Partial<ApiOperationContract> = {}): ApiOperationContract {
  return {
    operationId: "example.record.write", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/example/records/:recordId",
    description: "Write one example record.", exposure: "public", transport: "http",
    request: {
      path: { type: "object", additionalProperties: false, required: ["recordId"], properties: { recordId: { type: "string", pattern: "^[a-z]+$" } } },
      query: { type: "object", additionalProperties: false, properties: {} }, headers: { type: "object" },
      body: { kind: "json", maxBytes: 1024, schema: { type: "object", additionalProperties: false,
        required: ["value"], properties: { value: { type: "integer", minimum: 0 } } } }
    },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false,
      required: ["ok", "value"], properties: { ok: { const: true }, value: { type: "integer" } } } } },
    effects: { mode: "mutating", description: "Changes one record." },
    recovery: { strategy: "receipt-first", description: "Inspect the original receipt before replaying writes." }, validators: [], ...overrides
  };
}
