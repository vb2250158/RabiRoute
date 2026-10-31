import type { ApiOperationContract, ApiSchema, ApiResponseContract } from "./apiOperationContract.js";

/** Describes only visible schema structure. It never certifies DTO completeness or native business validation. */
export function apiSchemaPrecision(schema: ApiSchema): string {
  if (schema === true) return "unconstrained";
  if (schema === false) return "reject-all";
  const structural = ["type", "enum", "const", "$ref", "allOf", "anyOf", "oneOf", "not", "if", "properties", "patternProperties", "additionalProperties", "required", "items", "prefixItems", "contains", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems"];
  if (!structural.some(key => Object.hasOwn(schema, key))) return "unconstrained";
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || schema.patternProperties !== undefined) return "open-structure";
    const properties = schema.properties as Record<string, ApiSchema> | undefined;
    const partial = Object.values(properties ?? {}).some(value => !["constrained", "closed-structure", "reject-all"].includes(apiSchemaPrecision(value)));
    return partial ? "partially-constrained-structure" : "closed-structure";
  }
  if (schema.type === "array") {
    if (schema.items === undefined) return "partially-constrained-structure";
    return ["constrained", "closed-structure", "reject-all"].includes(apiSchemaPrecision(schema.items as ApiSchema)) ? "constrained" : "partially-constrained-structure";
  }
  return "constrained";
}

function responsePrecision(descriptor: ApiResponseContract): unknown {
  if (descriptor.passthrough) return { mode: "opaque-native" };
  if (descriptor.binary) return { mode: "native-bytes", byteLimits: descriptor.binary };
  if (descriptor.stream) return { mode: "stream", framing: descriptor.stream.framing,
    frameSchema: descriptor.stream.frameSchema === undefined ? "native-bytes" : apiSchemaPrecision(descriptor.stream.frameSchema) };
  return { mode: "schema", precision: descriptor.schema === undefined ? "undeclared" : apiSchemaPrecision(descriptor.schema) };
}

export function apiContractPrecision(contract: ApiOperationContract) {
  const body = contract.request.body;
  const bodyPrecision = body.kind === "passthrough" ? "opaque-native" : body.kind === "none"
    ? body.allowIgnoredBody ? "ignored-native-bytes" : "absent"
    : body.kind === "json" || body.kind === "text" ? apiSchemaPrecision(body.schema) : "native-bytes";
  return {
    // Compatibility fields stay conservative: schema presence does not prove that a DTO
    // exhaustively describes every accepted native input or every provider response.
    exactRequestSchema: false, exactResponseSchema: false,
    completeness: "not-proven", businessValidation: "server-owned",
    request: { path: apiSchemaPrecision(contract.request.path), query: apiSchemaPrecision(contract.request.query),
      headers: apiSchemaPrecision(contract.request.headers), body: { mode: body.kind, precision: bodyPrecision } },
    responses: Object.fromEntries(Object.entries(contract.responses).map(([status, descriptor]) => [status,
      [descriptor, ...(descriptor.alternatives ?? [])].map(responsePrecision)])),
    ...(contract.websocket ? { websocket: { framing: contract.websocket.framing,
      incoming: contract.websocket.incomingSchema === undefined ? "native-bytes" : apiSchemaPrecision(contract.websocket.incomingSchema),
      outgoing: contract.websocket.outgoingSchema === undefined ? "native-bytes" : apiSchemaPrecision(contract.websocket.outgoingSchema) } } : {}),
    unproven: ["complete-native-request-dto", "complete-native-response-dto"]
  };
}
