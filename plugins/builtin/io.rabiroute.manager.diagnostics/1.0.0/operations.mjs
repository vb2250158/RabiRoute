/** Plugin-owned HTTP contract and query policy; Gateway state remains with its owner. */
const text = { type: "string" };
const bool = { type: "boolean" };
const nullableText = { anyOf: [text, { type: "null" }] };
const gateways = { type: "array", items: { type: "object", required: ["id"],
  properties: { id: { type: "string", minLength: 1 }, name: text, configName: text, routeName: text, enabled: bool, running: bool, lifecycleState: text,
    pid: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, lastError: nullableText, startedAt: nullableText, stoppedAt: nullableText,
    messageAdapters: { type: "array", items: text }, roleInfo: { type: "object" }, messageFiles: { type: "object", additionalProperties: true },
    log: { type: "array", items: text } }, additionalProperties: true } };

/** Diagnostic owners retain their extensible provider/status payloads; no readiness grant is added. */
export function createDiagnosticsRoutes(context) {
  const define = (operationId, pathTemplate, schema, read) => {
    const contract = { operationId,
      contractVersion: "1.0.0", method: "GET", pathTemplate, exposure: "public", transport: "http",
      description: "Read existing Gateway diagnostics, retaining provider-specific fields and current cached status.",
      request: { path: { type: "object", properties: {}, additionalProperties: false },
        query: { type: "object", additionalProperties: true, description: "Existing diagnostic owners ignore query parameters. Use exact /meta without query for identity discovery." },
        headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema,
        headers: { type: "object", required: ["cache-control"], properties: { "cache-control": { const: "private, no-store" } }, additionalProperties: true } } },
      effects: { mode: "diagnostic-read", description: "Reads current identity/status through the existing diagnostic owners and performance instrumentation. Does not launch a Runtime, scan Agent sessions, change Route state or grant business permissions." },
      recovery: { strategy: "repeatable-read", description: "Rediscover through Host/READY on identity change. Health false, startup or unrelated dependency failure remains diagnostic data; it does not authorize a second Manager or a fallback Runtime." },
      validators: [{ id: "manager.diagnostics.owner-payload", description: "Identity strings are nonempty. Health values are validated by type, never required to be healthy/ready. Provider-specific diagnostic sections remain extensible. The same ingress connection authority applies before and after awaited reads; no separate persona, workspace or feature grant is introduced." }] };
    return { contract, handler: async () => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: await read() }) };
  };
  return { operations: [define("manager.gateways.read", "/api/gateways", gateways, context.gatewayDiagnosticsPayload)] };
}
