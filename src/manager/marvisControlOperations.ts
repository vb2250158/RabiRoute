import type { MarvisOpenRequest } from "../agentAdapters/managerApi.js";
import type { ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";

/** The existing host opener owns platform selection and launching; this contract never executes a prompt. */
export function createMarvisControlOperations(open: (request: MarvisOpenRequest) => Record<string, unknown>): readonly ApiOperationDefinition[] {
  const handler = (input: ApiOperationInput) => {
    try { input.signal?.throwIfAborted(); return { status: 200, body: open(input.body as MarvisOpenRequest) }; }
    catch (error) { return { status: 400, body: { ok: false, message: error instanceof Error ? error.message : String(error) } }; }
  };
  return [{ contract: {
    operationId: "manager.agent.marvis.open", aliases: ["agent:POST:/api/agent/marvis-open"], contractVersion: "1.0.0",
    method: "POST", pathTemplate: "/api/agent/marvis-open", exposure: "public", transport: "http",
    description: "Ask the original host to open Marvis. Windows opens its installed app ID; other platforms open its configured URL. Success means a launch attempt, not app readiness, login or Agent message delivery.",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" },
      body: { kind: "json", maxBytes: 0, allowAnyContentType: true, schema: { type: "object", additionalProperties: true, properties: {
        appId: { type: ["string", "null"], description: "Trimmed Windows app ID; empty/null/absent uses the existing MARVIS_APP_ID environment value or native default." },
        url: { type: ["string", "null"], description: "Trimmed destination for non-Windows platforms; empty/null/absent uses existing MARVIS_URL environment value or native default. This value is not a new Manager service address." }
      } } } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["ok", "mode", "target", "message"],
      properties: { ok: { const: true }, mode: { enum: ["desktop", "url"] }, target: { type: "string" }, message: { type: "string" } } } },
      "400": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, required: ["ok", "message"], properties: { ok: { const: false }, message: { type: "string" } } } } },
    effects: { mode: "host-application-open", description: "Invoke the existing host opener once. The native owner decides desktop app versus default URL application and keeps its original detached-process lifecycle. It does not create or execute an Agent task." },
    recovery: { strategy: "inspect-host-before-repeat", description: "No idempotency key or delivery receipt exists. After timeout, disconnect or another uncertain result, inspect the host application before another explicit request; never automatically replay a launch." },
    validators: [{ id: "native-marvis-open", description: "Preserve the native optional string trimming, environment defaults and platform decision. Additional payload/query fields are ignored. An authenticated enabled remote connection needs no second feature grant. HTTP acknowledgement cannot establish desktop visibility or login." }]
  }, handler }];
}
