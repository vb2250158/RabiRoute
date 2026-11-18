import { compileApiContract, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import { executeDurableDelivery } from "@rabiroute/host-api/manager/durableDeliveryIdempotency";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";
import { prepareNapcatApiAttachmentParams, type NapcatApiAttachmentInput } from "./napcatApiAttachments.js";
import { callNapcatApi, NapcatApiError, napcatApiFailure, selectNapcatApiInstance,
  type NapcatApiTransportContext } from "./napcatApiTransport.js";

/** Static, version-pinned protocol declarations. This is never constructed from an HTTP request. */
export type NapcatApiDescriptor = Readonly<{
  action: string;
  aliases: readonly string[];
  title: string;
  description: string;
  version: string;
  parameters: ApiSchema;
  response: ApiSchema;
  nativeResponse?: ApiSchema;
  mode: "read" | "mutation" | "managed";
  relatedOperations?: readonly string[];
  /** Existing public operation referenced by discovery; this operation does not invoke it with incompatible input. */
  managedOwner?: string;
  unavailableReason?: string;
  attachmentInput?: NapcatApiAttachmentInput;
}>;

export type NapcatApiOperationsContext = NapcatApiTransportContext & {
  rootDir: string;
  readOnly(): boolean;
};

const empty = { type: "object", additionalProperties: false } as const;
const selector = { type: "string", minLength: 1, maxLength: 256 } as const;
const failure = { type: "object", required: ["code", "errorCode"], additionalProperties: false,
  properties: { code: { const: -1 }, errorCode: { type: "string" } } } as const;

const responseValidators = new WeakMap<object, (value: unknown) => boolean>();

/** Reuse the validator for each immutable static schema, including nested array/union branches. */
export function napcatApiResponseValidator(schema: ApiSchema): (value: unknown) => boolean {
  if (!schema || typeof schema !== "object") throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
  const existing = responseValidators.get(schema);
  if (existing) return existing;
  const compiled = compileApiContract({ contract: {
    operationId: "napcat.internal.response-shape", contractVersion: "1.0.0", method: "GET", pathTemplate: "/_napcat-response-shape",
    description: "Internal response-schema validation", exposure: "internal", transport: "http",
    request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema } }, effects: { mode: "read", description: "No platform operation" },
    recovery: { strategy: "none", description: "Validation only" }, validators: []
  } });
  const validate = compiled.responseValidators.get("200")?.[0]?.body;
  if (!validate) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
  const matches = (value: unknown) => validate(value) === true;
  responseValidators.set(schema, matches);
  return matches;
}

function responseMatches(schema: ApiSchema, value: unknown): boolean { return napcatApiResponseValidator(schema)(value); }

export function projectNapcatApiResponse(schema: ApiSchema, value: unknown, nativeSchema: ApiSchema = schema): unknown {
  if (!schema || typeof schema !== "object") throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
  if (schema.type === "null") return null;
  const native = nativeSchema && typeof nativeSchema === "object" ? nativeSchema : schema;
  for (const key of ["anyOf", "oneOf"] as const) {
    const choices = native[key];
    if (!Array.isArray(choices)) continue;
    const matches = choices.map((child, index) => ({ child, index })).filter(({ child }) => responseMatches(child as ApiSchema, value));
    if (!matches.length || key === "oneOf" && matches.length !== 1) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
    const chosen = matches[0]!;
    const publicChoices = schema[key] as ApiSchema[] | undefined;
    if (!publicChoices?.[chosen.index]) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
    return projectNapcatApiResponse(publicChoices[chosen.index]!, value, chosen.child as ApiSchema);
  }
  const variants = [schema, ...(Array.isArray(schema.allOf) ? schema.allOf as Record<string, unknown>[] : [])];
  if (value === null) return null;
  if (Array.isArray(value)) {
    const items = variants.find(item => item.items && typeof item.items === "object")?.items as ApiSchema | undefined;
    if (!items) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
    return value.map(item => projectNapcatApiResponse(items, item, native.items as ApiSchema | undefined));
  }
  if (typeof value === "object") {
    const properties = Object.assign(Object.create(null), ...variants.map(item => item.properties ?? {})) as Record<string, ApiSchema>;
    const patterns = Object.assign(Object.create(null), ...variants.map(item => item.patternProperties ?? {})) as Record<string, ApiSchema>;
    const additional = variants.find(item => item.additionalProperties && typeof item.additionalProperties === "object")?.additionalProperties as ApiSchema | undefined;
    if (!Object.keys(properties).length && !Object.keys(patterns).length && !additional
      && !variants.some(item => item.type === "object")) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
    const projected: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key] ?? Object.entries(patterns).find(([pattern]) => new RegExp(pattern).test(key))?.[1] ?? additional;
      if (childSchema && typeof childSchema === "object" && Object.keys(childSchema).length) {
        const nativeProperties = native.properties as Record<string, ApiSchema> | undefined;
        projected[key] = projectNapcatApiResponse(childSchema, child, nativeProperties?.[key] ?? childSchema);
      }
    }
    return { ...projected };
  }
  if (!variants.some(item => typeof item.type === "string" || Array.isArray(item.type) || Array.isArray(item.enum) || Object.hasOwn(item, "const"))) {
    throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_UNRESOLVED");
  }
  return value;
}

function contractFor(descriptor: NapcatApiDescriptor): ApiOperationContract {
  return {
    operationId: `agent.qq.onebot.${descriptor.action}`, aliases: descriptor.aliases.map(alias => `agent.qq.onebot.${alias}`),
    contractVersion: "1.0.0", method: "POST", pathTemplate: `/api/agent/qq/onebot/${descriptor.action}`,
    description: `${descriptor.description} NapCat ${descriptor.version}.`, exposure: "public", transport: "http",
    request: { path: empty, query: empty, headers: { type: "object" },
      body: { kind: "json", maxBytes: qqReadSettings.jsonBytes, schema: {
        type: "object", additionalProperties: false, required: ["routeId", "instanceId", "params", ...(descriptor.mode === "mutation" ? ["deliveryId"] : [])],
        properties: { routeId: selector, instanceId: selector, params: descriptor.parameters,
          ...(descriptor.mode === "mutation" ? { deliveryId: { type: "string", minLength: 1, maxLength: 200 } } : {}) }
      } }, deadlineMs: qqReadSettings.readTimeoutMs },
    responses: {
      "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
        properties: { code: { const: 0 }, data: descriptor.response, delivery: { type: "object" } } } },
      "202": { mediaType: "application/json", schema: { type: "object", required: ["code", "delivery"], additionalProperties: false,
        properties: { code: { const: 0 }, delivery: { type: "object" } } } },
      default: { mediaType: "application/json", schema: failure }
    },
    effects: { mode: descriptor.mode === "read" ? "read" : descriptor.mode === "mutation" ? "external-mutation" : "native-owner",
      description: descriptor.mode === "managed" ? `Original owner ${descriptor.managedOwner ?? "unresolved"} retains platform effects and safe response handling.`
        : "The exact configured QQ account is verified before the fixed, schema-validated provider operation." },
    recovery: { strategy: descriptor.mode === "mutation" ? "original-durable-receipt-no-automatic-replay" : "read-or-native-owner",
      description: "Retain original deliveryId and binding. An uncertain provider operation is not automatically repeated. Standard async/rate-limit names identify the canonical operation; their native acceptance does not establish completion." },
    validators: [{ id: "napcat.static-contract", description: "Static versioned action and parameter contract; caller-supplied action, URL, credential, or additional parameters are rejected before upstream." },
      { id: "napcat.account-binding", description: "Existing connection authorization, exact Route/instance, configured QQ and actual get_login_info match are rechecked across awaits." }]
  };
}

function ensureDescriptor(descriptor: NapcatApiDescriptor): void {
  if (!/^\.?[a-zA-Z_][a-zA-Z0-9_]*$/.test(descriptor.action)
    || descriptor.aliases.some(alias => !/^\.?[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))) throw new Error("Invalid static NapCat action declaration.");
  const closedObject = (schema: ApiSchema): boolean => {
    if (!schema || typeof schema !== "object") return false;
    if (schema.type === "object") return schema.additionalProperties === false;
    const choices = schema.anyOf ?? schema.oneOf;
    return Array.isArray(choices) && choices.length > 0 && choices.every(closedObject);
  };
  if (!closedObject(descriptor.parameters)) {
    throw new Error(`NapCat ${descriptor.action} requires an explicit closed parameter object.`);
  }
}

function bodyOf(input: ApiOperationInput) {
  return input.body as { routeId: string; instanceId: string; params: unknown; deliveryId?: string };
}

/** Fixed operation registration retains the original HTTP/parser and owner lifetimes. */
export function createNapcatApiOperations(context: NapcatApiOperationsContext,
  descriptors: readonly NapcatApiDescriptor[]): readonly ApiOperationDefinition[] {
  const known = new Set(descriptors.map(item => item.action));
  if (known.size !== descriptors.length) throw new Error("Duplicate static NapCat action.");
  return descriptors.map(descriptor => {
    ensureDescriptor(descriptor);
    const contract = contractFor(descriptor);
    const compiled = compileApiContract({ contract });
    const nativeSchema = descriptor.nativeResponse ?? descriptor.response;
    const execute = async (input: ApiOperationInput): Promise<ApiOperationResult> => {
      try {
        if (!compiled.bodyValidator?.(input.body)) throw new NapcatApiError(400, "QQ_API_PARAMETERS_INVALID");
        const body = bodyOf(input);
        if (descriptor.mode !== "read" && context.readOnly()) throw new NapcatApiError(403, "QQ_API_READ_ONLY");
        if (descriptor.mode === "managed") {
          // Preserve existing message/file/credential/process owners and their different request contracts.
          // The versioned coverage matrix records the exact operation or missing dependency.
          const compatibleOwner = descriptor.managedOwner && !descriptor.unavailableReason;
          throw new NapcatApiError(compatibleOwner ? 409 : 503,
            compatibleOwner ? "QQ_API_USE_EXISTING_OWNER" : "QQ_API_OWNER_DEPENDENCY_UNAVAILABLE");
        }
        const selection = selectNapcatApiInstance(context, input.request, body.routeId, body.instanceId, input.signal);
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        input.signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => controller.abort(), qqReadSettings.readTimeoutMs);
        let nativeParameters = body.params;
        let attachmentDigest: unknown;
        const invoke = async () => {
          selection.assertCurrent();
          const data = await callNapcatApi(context, selection, descriptor.action, nativeParameters, known, controller.signal);
          if (!responseMatches(nativeSchema, data ?? null)) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
          const projected = projectNapcatApiResponse(descriptor.response, data ?? null, nativeSchema);
          const result = { status: 200, body: { code: 0, data: projected } };
          const validator = compiled.responseValidators.get("200")?.[0]?.body;
          if (!validator?.(result.body)) throw new NapcatApiError(503, "QQ_API_RESPONSE_CONTRACT_MISMATCH");
          return projected;
        };
        try {
          if (descriptor.attachmentInput) {
            const prepared = await prepareNapcatApiAttachmentParams(context, selection, body.params as Record<string, unknown>, descriptor.attachmentInput, controller.signal);
            nativeParameters = prepared.parameters;
            attachmentDigest = prepared.digest;
          }
          if (descriptor.mode === "read") return { status: 200, body: { code: 0, data: await invoke() }, headers: { "cache-control": "private, no-store" } };
          const outcome = await executeDurableDelivery({ rootDir: context.rootDir, namespace: "napcat-onebot-actions", deliveryId: body.deliveryId,
            payload: { action: descriptor.action, routeId: selection.routeId, instanceId: selection.instanceId, botUserId: selection.botUserId, params: body.params,
              ...(attachmentDigest ? { attachmentDigest } : {}) },
            audit: { routeId: selection.routeId, instanceId: selection.instanceId, botUserId: selection.botUserId, action: descriptor.action },
            requestAuthority: selection.assertCurrent, deliver: invoke });
          selection.assertCurrent();
          if (outcome.state === "conflict") throw new NapcatApiError(409, "QQ_API_DELIVERY_CONFLICT");
          return outcome.state === "completed" ? { status: 200, body: { code: 0, data: outcome.result,
            delivery: { deliveryId: outcome.deliveryId, state: outcome.state, duplicate: outcome.duplicate } } }
            : { status: 202, body: { code: 0, delivery: { deliveryId: outcome.deliveryId, state: outcome.state, retryable: false } } };
        } finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
      } catch (error) { return napcatApiFailure(error); }
    };
    return { contract, discovery: { title: descriptor.title, summary: descriptor.description,
      keywords: ["NapCat", "OneBot", descriptor.action, descriptor.mode], category: { id: "qq-onebot", title: "QQ / NapCat" },
      relatedOperations: descriptor.relatedOperations }, handler: execute };
  });
}
