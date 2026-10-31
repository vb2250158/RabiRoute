import { createHash } from "node:crypto";
import { parseApiPathTemplate, validApiTail, type ApiPathSegment } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateHeaderValue } from "node:http";
import { MIMEType } from "node:util";
import type { Duplex } from "node:stream";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { ApiExternalListenerDefinition, ApiExternalListenerRegistration } from "./apiExternalListenerBinding.js";

export type ApiMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
export type ApiSchema = boolean | Readonly<Record<string, unknown>>;
export type ApiBodyContract = Readonly<
  | { kind: "none"; /** Native owner ignores any body; bytes are discarded without decoding or buffering. */ allowIgnoredBody?: boolean }
  | { kind: "passthrough" }
  | { kind: "json"; schema: ApiSchema; /** Zero preserves an owner's existing absence of an application byte limit. */ maxBytes: number;
      /** Explicit decoding defaults for APIs that accept a completely empty request body. */
      emptyValue?: unknown; allowAnyContentType?: boolean }
  | { kind: "text"; mediaType: string; maxBytes: number; schema: ApiSchema }
  | { kind: "binary" | "multipart" | "stream"; mediaType: string; maxBytes: number; rules: readonly string[]; allowAnyContentType?: boolean; optional?: boolean }
>;
export type ApiResponseContract = Readonly<{
  mediaType: string;
  /** The native HTTP owner forwards status, repeated headers and opaque bytes without buffering. */
  passthrough?: true;
  schema?: ApiSchema;
  headers?: ApiSchema;
  /** A finite raw byte body; limits describe bytes, never a JSON/base64 representation. */
  binary?: Readonly<{ minBytes?: number; maxBytes: number }>;
  stream?: Readonly<{ framing: "sse-json" | "bytes"; maxFrameBytes: number; maxBytes?: number;
    frameSchema?: ApiSchema; completion: string; cancellation: string }>;
  alternatives?: readonly ApiResponseContract[];
}>;
export type ApiOperationContract = Readonly<{
  operationId: string;
  /** Previous discovery IDs resolve to this operation; they never install another handler. */
  aliases?: readonly string[];
  contractVersion: string;
  method: ApiMethod;
  pathTemplate: string;
  description: string;
  exposure: "public" | "internal";
  transport: "http" | "sse" | "websocket";
  httpProxy?: Readonly<{ wire: Readonly<{ dataFrameBytes: number; streamWindowBytes: number; maxConcurrentStreams: number }>;
    /** Explicit final native HTTP owner, after ordinary HTTP/upgrade/method handling. */
    dispatch?: "final-fallback";
    completion: string; cancellation: string }>;
  websocket?: Readonly<{ protocol: string;
    authenticationMs?: number; handshakeMs?: number; closeGraceMs?: number;
    authentication: string; completion: string; cancellation: string } & (
      { framing: "json" | "bytes"; maxMessageBytes: number; maxBufferedBytes: number; incomingSchema?: ApiSchema; outgoingSchema?: ApiSchema; wire?: never }
      | { framing: "passthrough"; wire: Readonly<{ dataFrameBytes: number; streamWindowBytes: number; maxConcurrentStreams: number }>;
          maxMessageBytes?: never; maxBufferedBytes?: never; incomingSchema?: never; outgoingSchema?: never }
    )>;
  request: Readonly<{ path: ApiSchema; query: ApiSchema; headers: ApiSchema; body: ApiBodyContract;
    /** Final parameter names that capture one or more segments; older clients can encode the whole value. */
    pathTails?: readonly string[];
    /** Final raw URI suffix, including an empty suffix; never percent-decoded or re-encoded.
     * A literal may precede :name in the last segment to retain native startsWith matching. */
    pathRemainder?: string;
    /** Explicit legacy literal matching only; path parameter values retain their original case. */
    pathCaseInsensitiveLiterals?: readonly string[];
    /** An outer proxy consumes its own precondition without overwriting a target operation's header. */
    contractHeader?: string;
    /** Total parser/owner budget. Owners observe input.signal; leases still wait for actual cleanup. */
    deadlineMs?: number }>;
  responses: Readonly<Record<string, ApiResponseContract>>;
  effects: Readonly<{ mode: string; description: string }>;
  recovery: Readonly<{ strategy: string; description: string; receiptPath?: string; idempotencyHeader?: string }>;
  validators: readonly Readonly<{ id: string; description: string }>[];
}>;
export type ApiOperationInput = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  path: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | string[]>>;
  body: unknown;
  /** Original HTTP response lifetime and total request deadline; accepted owner cleanup must still be joined. */
  signal?: AbortSignal;
}>;
export type ApiOperationResult = Readonly<{
  status: number;
  /** Trusted owner evidence about its native mutation dispatch, never copied from request data.
   * Used only to preserve failure metadata across an authority fence; it cannot disclose business data. */
  mutationOutcome?: "not_started" | "unknown";
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  stream?: ApiOperationStream;
}>;
export type ApiOperationStream = Readonly<{
  frames: AsyncIterable<unknown>;
  /** An owner may abort a failed/overloaded stream; ordinary EOF does not require this signal. */
  signal?: AbortSignal;
  /** Must unblock next(), stop subscriptions and let frames reach EOF after cleanup. Never retries a write. */
  cancel(reason: unknown): void | Promise<void>;
}>;
export type ApiOperationDefinition = Readonly<{
  contract: ApiOperationContract;
  handler(input: ApiOperationInput): ApiOperationResult | Promise<ApiOperationResult>;
  /** Capture the original owner admission before body consumption. Preparation performs no business action.
   * Return an early rejection or a request-bound handler retaining that original admission. */
  prepare?(input: Omit<ApiOperationInput, "body">): ApiOperationDefinition["handler"] | ApiOperationResult
    | Promise<ApiOperationDefinition["handler"] | ApiOperationResult>;
}>;
export type ApiOperationRegistration = Readonly<{
  dispose(): Promise<void>;
  activeOperationCount(): number;
}>;
export type ApiUpgradeSession = Readonly<{ closed: Promise<void>; close(reason: string): void | Promise<void> }>;
export type ApiUpgradeInput = Readonly<{
  request: IncomingMessage; url: URL; socket: Duplex; head: Uint8Array;
  path: Readonly<Record<string, string>>; query: Readonly<Record<string, string | string[]>>; signal: AbortSignal;
  accept(session: ApiUpgradeSession): void;
  prepareHandshake(headers: Readonly<Record<string, string | readonly string[]>>): void;
  reject(status: number, body: unknown, headers?: Readonly<Record<string, string>>): void;
  assertCurrent(): void;
  validateIncoming(value: unknown, sizeBytes: number): void;
  validateOutgoing(value: unknown, sizeBytes: number): void;
}>;
export type ApiUpgradeDefinition = Readonly<{ contract: ApiOperationContract; handler(input: ApiUpgradeInput): void | Promise<void> }>;
export type ApiUpgradeRegistration = ApiOperationRegistration & Readonly<{ stopAccepting(): void }>;
export type ApiHttpProxyInput = Readonly<{
  request: IncomingMessage; response: ServerResponse; url: URL;
  path: Readonly<Record<string, string>>; query: Readonly<Record<string, string | string[]>>; signal: AbortSignal;
  assertCurrent(): void;
  prepareResponse(status: number, headers: Readonly<Record<string, string | readonly string[]>>): void;
}>;
export type ApiHttpProxyDefinition = Readonly<{ contract: ApiOperationContract; handler(input: ApiHttpProxyInput): Promise<void> }>;
export type ManagerApiOperationsService = Readonly<{
  registerExternalListener(definition: ApiExternalListenerDefinition): ApiExternalListenerRegistration;
  registerOperations(definitions: readonly ApiOperationDefinition[]): ApiOperationRegistration;
  registerOperationsAsync(definitions: readonly ApiOperationDefinition[], signal: AbortSignal): Promise<ApiOperationRegistration>;
  registerUpgrades(definitions: readonly ApiUpgradeDefinition[]): ApiUpgradeRegistration;
  registerHttpProxies(definitions: readonly ApiHttpProxyDefinition[]): ApiOperationRegistration;
}>;

export class ApiContractError extends Error {
  constructor(readonly status: number, readonly code: string, readonly field: string, readonly operationId: string, readonly uncertain = false,
    readonly mutationOutcome?: "not_started" | "unknown") {
    super(`${code}: ${field}`);
  }
}

const frameworkErrorStatuses = [400, 403, 404, 408, 409, 413, 415, 500] as const;
const frameworkErrorSchema = {
  type: "object", additionalProperties: false,
  required: ["code", "errorCode", "field", "operationId", "contractDigest", "repair", "retryable"],
  properties: { code: { const: -1 }, errorCode: { type: "string" }, field: { type: "string" }, operationId: { type: "string" },
    contractDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, repair: { type: "string" }, retryable: { const: false }, uncertain: { type: "boolean" },
    mutationOutcome: { enum: ["not_started", "unknown"] } }
} as const;

export function apiContractFailure(operation: CompiledApiContract, error: unknown): ApiOperationResult {
  const failure = error instanceof ApiContractError ? error : new ApiContractError(500, "API_OPERATION_FAILED", "operation", operation.contract.operationId);
  const uncertain = failure.uncertain || failure.status >= 500;
  return { status: failure.status, body: { code: -1, errorCode: failure.code, field: failure.field,
    operationId: operation.contract.operationId, contractDigest: operation.digest,
    repair: uncertain ? "Inspect the original operation receipt before retrying any write."
      : "Read the current operation contract and correct the indicated field.", retryable: false,
    ...(failure.mutationOutcome ? { mutationOutcome: failure.mutationOutcome, uncertain } : uncertain ? { uncertain: true } : {}) } };
}

export function canonicalApiJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalApiJson).join(",")}]`;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalApiJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("API contracts must contain only finite JSON data.");
}

export function apiDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalApiJson(value)).digest("hex")}`;
}

export function freezeApiData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeApiData(child);
    Object.freeze(value);
  }
  return value;
}

const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
addFormats(ajv);

// Contracts are cloned before compilation, so Ajv's object-identity cache alone
// recompiles the same JSON schema for each operation and response alternative.
const schemaValidators = new Map<string, Readonly<{ schema: ApiSchema; validate: ValidateFunction }>>();
const maxCachedSchemas = 256;
const maxCachedSchemaBytes = 512 * 1024;
let cachedSchemaBytes = 0;

function schemaHasExternalContext(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasExternalContext);
  return Object.entries(value).some(([key, child]) => key === "$id"
    || ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) && (typeof child !== "string" || !child.startsWith("#"))
    || schemaHasExternalContext(child));
}

function compileApiSchema(schema: ApiSchema): ValidateFunction {
  // IDs and external references depend on Ajv's schema registry. Preserve its
  // normal compilation/duplicate-ID checks instead of treating JSON as context.
  if (schemaHasExternalContext(schema)) return ajv.compile(schema);
  const key = canonicalApiJson(schema);
  const bytes = Buffer.byteLength(key, "utf8");
  if (bytes > maxCachedSchemaBytes) {
    const validate = ajv.compile(schema);
    if (typeof schema === "object") ajv.removeSchema(schema);
    return validate;
  }
  const existing = schemaValidators.get(key);
  if (existing) {
    schemaValidators.delete(key);
    schemaValidators.set(key, existing);
    return existing.validate;
  }
  const validate = ajv.compile(schema);
  while (schemaValidators.size >= maxCachedSchemas || cachedSchemaBytes + bytes > maxCachedSchemaBytes) {
    const oldest = schemaValidators.entries().next().value!;
    schemaValidators.delete(oldest[0]);
    cachedSchemaBytes -= Buffer.byteLength(oldest[0], "utf8");
    // These schemas have no IDs/external references. Existing holders keep the
    // compiled function, while eviction also releases Ajv's object cache entry.
    // Ajv does not accept booleans in removeSchema; its two boolean entries are
    // already bounded independently of the number of contracts.
    if (typeof oldest[1].schema === "object") ajv.removeSchema(oldest[1].schema);
  }
  schemaValidators.set(key, { schema, validate });
  cachedSchemaBytes += bytes;
  return validate;
}

export type CompiledApiContract = Readonly<{
  contract: ApiOperationContract;
  digest: string;
  pathPattern: RegExp;
  pathNames: readonly string[];
  pathTailNames: readonly string[];
  pathRemainder?: string;
  pathSegments: readonly ApiPathSegment[];
  pathEquivalenceSegments: readonly ApiPathSegment[];
  pathValidator: ValidateFunction;
  queryValidator: ValidateFunction;
  headersValidator: ValidateFunction;
  bodyValidator?: ValidateFunction;
  responseValidators: ReadonlyMap<string, readonly Readonly<{ descriptor: ApiResponseContract; body?: ValidateFunction; headers?: ValidateFunction }>[] >;
  streamValidators: ReadonlyMap<ApiResponseContract, ValidateFunction>;
  upgradeIncomingValidator?: ValidateFunction;
  upgradeOutgoingValidator?: ValidateFunction;
}>;
export type CompiledApiOperation = CompiledApiContract & Pick<ApiOperationDefinition, "handler" | "prepare">;

/** Registration already owns validated, immutable metadata; route pairs need no parsing or cache keys. */
export function compiledApiPathsEquivalent(left: CompiledApiContract, right: CompiledApiContract): boolean {
  const a = left.pathEquivalenceSegments, b = right.pathEquivalenceSegments;
  return a.length === b.length && a.every((x, index) => {
    const y = b[index]!;
    if (x.name || y.name) return Boolean(x.name && y.name);
    return x.caseInsensitive || y.caseInsensitive ? x.literal!.toLowerCase() === y.literal!.toLowerCase() : x.literal === y.literal;
  });
}

export function compiledApiTailPathsOverlap(left: CompiledApiContract, right: CompiledApiContract): boolean {
  if (!left.pathTailNames.length && !right.pathTailNames.length && !left.pathRemainder && !right.pathRemainder) return false;
  const a = left.pathSegments, b = right.pathSegments;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index], y = b[index];
    if (!x || !y) return false;
    if (x.remainder && x.prefix || y.remainder && y.prefix) {
      const prefix = (x.prefix ?? y.prefix)!, other = x.prefix ? y : x;
      return other.literal !== undefined ? (other.caseInsensitive ? other.literal.toLowerCase().startsWith(prefix.toLowerCase()) : other.literal.startsWith(prefix))
        : other.prefix ? other.prefix.startsWith(prefix) || prefix.startsWith(other.prefix) : true;
    }
    if (x.tail || y.tail || x.remainder || y.remainder) return true;
    if (x.literal !== undefined && y.literal !== undefined && (x.caseInsensitive || y.caseInsensitive ? x.literal.toLowerCase() !== y.literal.toLowerCase() : x.literal !== y.literal)) return false;
  }
  return true;
}

function captureApiContract(input: ApiOperationContract): ApiOperationContract {
  const normalized = JSON.parse(canonicalApiJson(input)) as { responses: Record<string, ApiResponseContract>; transport?: unknown };
  if (!normalized.responses || Object.keys(normalized.responses).length === 0) throw new Error("API response contracts are required.");
  for (const status of [...frameworkErrorStatuses, ...(normalized.transport === "websocket" ? [426] : [])]) {
    const prior = normalized.responses[String(status)] ?? normalized.responses.default;
    const framework = { mediaType: "application/json", schema: frameworkErrorSchema };
    const variants = prior ? [prior, ...(prior.alternatives ?? [])] : [];
    const alreadyPresent = variants.some(value => value.mediaType === framework.mediaType && canonicalApiJson(value.schema ?? null) === canonicalApiJson(framework.schema));
    normalized.responses[String(status)] = !prior ? framework : alreadyPresent ? prior
      : { ...prior, alternatives: [...(prior.alternatives ?? []), framework] };
  }
  return freezeApiData(normalized) as ApiOperationContract;
}

export function compileApiContract(definition: Pick<ApiOperationDefinition, "contract">): CompiledApiContract {
  return compileCapturedApiContract(captureApiContract(definition.contract));
}

function compileCapturedApiContract(contract: ApiOperationContract): CompiledApiContract {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,191}$/.test(contract.operationId)) throw new Error("Invalid API operationId.");
  if (contract.aliases !== undefined && (!Array.isArray(contract.aliases) || contract.aliases.length > 100
    || contract.aliases.some(alias => typeof alias !== "string" || !/^[A-Za-z][A-Za-z0-9._:/-]{0,4095}$/.test(alias)))) throw new Error("Invalid API operation aliases.");
  const namesAndAliases = [contract.operationId, ...(contract.aliases ?? [])];
  if (new Set(namesAndAliases).size !== namesAndAliases.length) throw new Error("Duplicate API operation alias.");
  if (!/^\d+\.\d+\.\d+$/.test(contract.contractVersion)) throw new Error(`Invalid API contractVersion: ${contract.operationId}`);
  if (!["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "*"].includes(contract.method)
    || contract.method === "*" && !contract.httpProxy) throw new Error("Invalid API method; wildcard dispatch requires a native HTTP proxy.");
  if (!["public", "internal"].includes(contract.exposure) || !["http", "sse", "websocket"].includes(contract.transport)) throw new Error("Invalid API exposure or transport.");
  if (!contract.pathTemplate.startsWith("/") || /[?#\\\s]/.test(contract.pathTemplate) || contract.pathTemplate.startsWith("//")) throw new Error("Invalid API path template.");
  if (!contract.description?.trim() || !contract.effects?.mode || !contract.effects.description?.trim()
    || !contract.recovery?.strategy || !contract.recovery.description?.trim()) throw new Error(`Incomplete API behavior contract: ${contract.operationId}`);
  if (!Array.isArray(contract.validators) || contract.validators.some(rule => !rule.id || !rule.description)) throw new Error("Invalid API business validators.");
  const template = parseApiPathTemplate(contract.pathTemplate, contract.request.pathTails, contract.request.pathRemainder, contract.request.pathCaseInsensitiveLiterals);
  // Equivalence historically parses without tail/raw bindings. In particular,
  // a raw prefix such as /native:rest remains a literal for this comparison.
  const equivalence = parseApiPathTemplate(contract.pathTemplate, [], "", contract.request.pathCaseInsensitiveLiterals);
  if (contract.request.contractHeader !== undefined && !/^x-rabiroute-[a-z0-9-]+-contract$/.test(contract.request.contractHeader)) throw new Error("Invalid API contract precondition header.");
  const websocket = contract.websocket;
  if (contract.transport === "websocket") {
    const handshake = contract.responses["101"];
    if (contract.method !== "GET" || contract.request.body.kind !== "none" || contract.request.deadlineMs !== undefined || !handshake
      || handshake.schema !== false || handshake.stream || handshake.binary || handshake.alternatives?.length || !websocket
      || !websocket.protocol?.trim() || !["json", "bytes", "passthrough"].includes(websocket.framing)
      || !websocket.authentication?.trim() || !websocket.completion?.trim() || !websocket.cancellation?.trim()
      || (websocket.framing === "passthrough"
        ? !websocket.wire || [websocket.wire.dataFrameBytes, websocket.wire.streamWindowBytes, websocket.wire.maxConcurrentStreams].some(value => !Number.isSafeInteger(value) || value < 1)
          || websocket.wire.dataFrameBytes > websocket.wire.streamWindowBytes
          || websocket.maxMessageBytes !== undefined || websocket.maxBufferedBytes !== undefined || websocket.incomingSchema !== undefined || websocket.outgoingSchema !== undefined
        : !Number.isSafeInteger(websocket.maxMessageBytes) || websocket.maxMessageBytes < 1
          || !Number.isSafeInteger(websocket.maxBufferedBytes) || websocket.maxBufferedBytes < websocket.maxMessageBytes || websocket.wire !== undefined)
      || [websocket.authenticationMs, websocket.handshakeMs, websocket.closeGraceMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647))
      || websocket.framing === "json" && (websocket.incomingSchema === undefined || websocket.outgoingSchema === undefined)
      || websocket.framing === "bytes" && (websocket.incomingSchema !== undefined || websocket.outgoingSchema !== undefined)) throw new Error("Invalid WebSocket upgrade contract.");
  } else if (websocket !== undefined) throw new Error("WebSocket metadata requires an upgrade binding.");
  const body = contract.request.body;
  if (body.kind === "none" && body.allowIgnoredBody !== undefined && typeof body.allowIgnoredBody !== "boolean") throw new Error("Invalid ignored-body policy.");
  if (contract.transport === "websocket" && body.kind === "none" && body.allowIgnoredBody) throw new Error("WebSocket upgrades cannot ignore a request body.");
  if (!["none", "passthrough", "json", "text", "binary", "multipart", "stream"].includes(body.kind)) throw new Error("Invalid API body contract.");
  if (body.kind !== "none" && body.kind !== "passthrough" && (!Number.isSafeInteger(body.maxBytes) || body.maxBytes < (body.kind === "json" ? 0 : 1))) throw new Error("API body limit must be a safe integer; only JSON may preserve an unlimited zero limit.");
  const proxy = contract.httpProxy;
  if (proxy !== undefined) {
    if (contract.transport !== "http" || body.kind !== "passthrough" || Object.keys(body).some(key => key !== "kind") || contract.request.deadlineMs !== undefined
      || !proxy.completion?.trim() || !proxy.cancellation?.trim() || !proxy.wire
      || [proxy.wire.dataFrameBytes, proxy.wire.streamWindowBytes, proxy.wire.maxConcurrentStreams].some(value => !Number.isSafeInteger(value) || value < 1)
      || proxy.wire.dataFrameBytes > proxy.wire.streamWindowBytes || !contract.responses.default?.passthrough) throw new Error("Invalid HTTP proxy contract.");
    if (proxy.dispatch !== undefined && (proxy.dispatch !== "final-fallback" || contract.method !== "*"
      || !contract.request.pathRemainder || contract.pathTemplate !== `/:${contract.request.pathRemainder}`)) throw new Error("A final HTTP fallback requires an explicit root raw remainder and wildcard native method.");
  } else if (body.kind === "passthrough") throw new Error("Passthrough bodies require an HTTP proxy binding.");
  if ((body.kind === "binary" || body.kind === "multipart" || body.kind === "stream") && body.optional !== undefined && typeof body.optional !== "boolean") throw new Error("Invalid API body presence policy.");
  if (contract.request.deadlineMs !== undefined && (!Number.isSafeInteger(contract.request.deadlineMs) || contract.request.deadlineMs < 1
    || contract.request.deadlineMs > 2_147_483_647)) throw new Error("API request deadline must fit a positive Node timer interval.");
  const responseValidators = new Map<string, readonly Readonly<{ descriptor: ApiResponseContract; body?: ValidateFunction; headers?: ValidateFunction }>[] >();
  const streamValidators = new Map<ApiResponseContract, ValidateFunction>();
  if (!Object.keys(contract.responses).length) throw new Error("API response contracts are required.");
  for (const [status, response] of Object.entries(contract.responses)) {
    if (!/^(?:[1-5][0-9]{2}|default)$/.test(status)) throw new Error("Invalid API response contract.");
    responseValidators.set(status, [response, ...(response.alternatives ?? [])].map((descriptor, index) => {
      if (!descriptor.mediaType?.trim() || index > 0 && descriptor.alternatives) throw new Error("Invalid or nested API response variant.");
      if (descriptor.passthrough !== undefined && (descriptor.passthrough !== true || !proxy || descriptor.mediaType !== "*/*" || descriptor.schema !== undefined || descriptor.binary || descriptor.stream || descriptor.headers)) throw new Error("Invalid passthrough response contract.");
      if (descriptor.mediaType === "*/*" && !descriptor.passthrough && !descriptor.binary) throw new Error("Wildcard responses require an HTTP proxy binding or finite binary contract.");
      if (descriptor.mediaType.includes("json") && descriptor.schema === undefined && !descriptor.stream && !descriptor.binary) throw new Error("JSON responses require a schema.");
      if (descriptor.binary && (descriptor.schema !== undefined || descriptor.stream !== undefined
        || !Number.isSafeInteger(descriptor.binary.maxBytes) || descriptor.binary.maxBytes < 1
        || descriptor.binary.minBytes !== undefined && (!Number.isSafeInteger(descriptor.binary.minBytes)
          || descriptor.binary.minBytes < 0 || descriptor.binary.minBytes > descriptor.binary.maxBytes))) throw new Error("Invalid finite binary response contract.");
      if (descriptor.stream) {
        if (contract.method === "HEAD") throw new Error("HEAD operations must declare metadata without a response stream.");
        if (["204", "304"].includes(status)) throw new Error("Bodyless HTTP statuses cannot declare response streams.");
        const stream = descriptor.stream;
        if (!["sse-json", "bytes"].includes(stream.framing) || !stream.completion?.trim() || !stream.cancellation?.trim()
          || !Number.isSafeInteger(stream.maxFrameBytes) || stream.maxFrameBytes < 1
          || stream.maxBytes !== undefined && (!Number.isSafeInteger(stream.maxBytes) || stream.maxBytes < 1)
          || descriptor.schema !== undefined) throw new Error("Invalid API stream response contract.");
        if (stream.framing === "sse-json" && (stream.frameSchema === undefined || descriptor.mediaType.split(";")[0]!.trim() !== "text/event-stream")) throw new Error("SSE streams require event framing and a frame schema.");
        if (stream.framing === "sse-json" && contract.transport !== "sse") throw new Error("SSE response framing requires the SSE transport.");
        if (stream.framing === "bytes" && stream.frameSchema !== undefined) throw new Error("Byte streams cannot declare a JSON frame schema.");
        if (contract.transport === "sse" && stream.framing === "bytes" && descriptor.mediaType.split(";")[0]!.trim() !== "text/event-stream") throw new Error("Raw SSE byte streams require the text/event-stream media type.");
        if (stream.frameSchema !== undefined) streamValidators.set(descriptor, compileApiSchema(stream.frameSchema));
      }
      return { descriptor, body: descriptor.schema !== undefined ? compileApiSchema(descriptor.schema) : undefined,
        headers: descriptor.headers !== undefined ? compileApiSchema(descriptor.headers) : undefined };
    }));
  }
  if (contract.transport === "sse" && ![...responseValidators.values()].flat().some(value => value.descriptor.stream && value.descriptor.mediaType.split(";")[0]!.trim() === "text/event-stream")) throw new Error("SSE transport requires an executable event stream response.");
  const bodyValidator = body.kind === "json" || body.kind === "text" ? compileApiSchema(body.schema) : undefined;
  if (body.kind !== "none" && body.kind !== "passthrough" && body.kind !== "text" && body.allowAnyContentType !== undefined && typeof body.allowAnyContentType !== "boolean") throw new Error("Invalid API media-type policy.");
  if (body.kind === "json") {
    if (Object.hasOwn(body, "emptyValue") && !bodyValidator!(body.emptyValue)) throw new Error("API empty-body value does not satisfy its request schema.");
  }
  return Object.freeze({ contract, digest: apiDigest(contract), pathPattern: template.pattern, pathNames: template.names, pathTailNames: template.tails, pathRemainder: template.remainder,
    pathSegments: template.segments, pathEquivalenceSegments: equivalence.segments,
    pathValidator: compileApiSchema(contract.request.path), queryValidator: compileApiSchema(contract.request.query),
    headersValidator: compileApiSchema(contract.request.headers),
    bodyValidator, responseValidators, streamValidators,
    ...(websocket?.incomingSchema === undefined ? {} : { upgradeIncomingValidator: compileApiSchema(websocket.incomingSchema) }),
    ...(websocket?.outgoingSchema === undefined ? {} : { upgradeOutgoingValidator: compileApiSchema(websocket.outgoingSchema) }) });
}
export function prepareApiOperation(definition: ApiOperationDefinition): () => CompiledApiOperation {
  const { handler, prepare } = definition;
  if (prepare !== undefined && typeof prepare !== "function") throw new Error("Invalid API request preparation.");
  const contract = captureApiContract(definition.contract);
  return () => Object.freeze({ ...compileCapturedApiContract(contract), handler, ...(prepare ? { prepare } : {}) });
}

export function compileApiOperation(definition: ApiOperationDefinition): CompiledApiOperation {
  return prepareApiOperation(definition)();
}

function assertValid(operation: CompiledApiContract, validator: ValidateFunction, value: unknown, field: string): void {
  if (!validator(value)) throw new ApiContractError(400, "API_REQUEST_SCHEMA_INVALID", field, operation.contract.operationId);
}

export function apiPathParameters(operation: CompiledApiContract, pathname: string): Readonly<Record<string, string>> | undefined {
  const match = operation.pathPattern.exec(pathname);
  if (!match) return;
  const path: Record<string, string> = Object.create(null);
  try { operation.pathNames.forEach((name, index) => { path[name] = name === operation.pathRemainder ? match[index + 1]! : decodeURIComponent(match[index + 1]!); }); }
  catch { throw new ApiContractError(400, "API_PATH_ENCODING_INVALID", "path", operation.contract.operationId); }
  if (operation.pathTailNames.some(name => !validApiTail(path[name]))) throw new ApiContractError(400, "API_PATH_PARAMETER_INVALID", "path", operation.contract.operationId);
  return path;
}

export function readApiRequestEnvelope(operation: CompiledApiContract, request: IncomingMessage, url: URL) {
  const id = operation.contract.operationId;
  const path = apiPathParameters(operation, url.pathname);
  if (!path) throw new ApiContractError(404, "API_OPERATION_NOT_FOUND", "path", id);
  const query: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0]! : values;
  }
  assertValid(operation, operation.pathValidator, path, "path");
  assertValid(operation, operation.queryValidator, query, "query");
  assertValid(operation, operation.headersValidator, request.headers, "headers");
  return { path: Object.freeze(path), query: Object.freeze(query) };
}

export async function readApiOperationInput(operation: CompiledApiContract, request: IncomingMessage, url: URL, response: ServerResponse, signal?: AbortSignal): Promise<ApiOperationInput> {
  signal?.throwIfAborted();
  const id = operation.contract.operationId;
  const { path, query } = readApiRequestEnvelope(operation, request, url);
  const bodyContract = operation.contract.request.body;
  if (bodyContract.kind === "passthrough") throw new Error("HTTP proxy bodies must be consumed by their native transport binding.");
  let body: unknown;
  if (bodyContract.kind === "json" || bodyContract.kind === "text") {
    const mediaType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const expected = bodyContract.kind === "json" ? "application/json" : bodyContract.mediaType.toLowerCase();
    if (mediaType !== expected && !(bodyContract.kind === "json" && bodyContract.allowAnyContentType)) {
      throw new ApiContractError(415, "API_MEDIA_TYPE_UNSUPPORTED", "content-type", id);
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const timedOut = () => request.destroy(signal!.reason);
    signal?.addEventListener("abort", timedOut, { once: true });
    try {
      signal?.throwIfAborted();
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (bodyContract.maxBytes > 0 && received > bodyContract.maxBytes) throw new ApiContractError(413, "API_REQUEST_TOO_LARGE", "body", id);
        chunks.push(bytes);
      }
    } finally { signal?.removeEventListener("abort", timedOut); }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new ApiContractError(400, "API_BODY_ENCODING_INVALID", "body", id); }
    if (bodyContract.kind === "json") {
      try { body = text === "" && Object.hasOwn(bodyContract, "emptyValue")
        ? JSON.parse(canonicalApiJson(bodyContract.emptyValue)) : JSON.parse(text); }
      catch { throw new ApiContractError(400, "API_JSON_INVALID", "body", id); }
    } else body = text;
    assertValid(operation, operation.bodyValidator!, body, "body");
  } else if (bodyContract.kind === "none") {
    if (bodyContract.allowIgnoredBody) request.resume();
    else if (Number(request.headers["content-length"] ?? 0) !== 0) {
      throw new ApiContractError(400, "API_BODY_UNEXPECTED", "body", id);
    } else if (request.headers["transfer-encoding"] !== undefined) {
      // Empty chunked framing is a zero-byte body, including Manager requests
      // carried by an established Peer stream. Reject actual bytes, not framing.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (Buffer.byteLength(chunk) !== 0) throw new ApiContractError(400, "API_BODY_UNEXPECTED", "body", id);
      }
    }
  } else {
    const mediaType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType !== bodyContract.mediaType.toLowerCase() && !bodyContract.allowAnyContentType) throw new ApiContractError(415, "API_MEDIA_TYPE_UNSUPPORTED", "content-type", id);
    const size = request.headers["content-length"];
    if (size !== undefined && (!/^\d+$/.test(String(size)) || !Number.isSafeInteger(Number(size)) || Number(size) > bodyContract.maxBytes)) {
      throw new ApiContractError(413, "API_REQUEST_TOO_LARGE", "content-length", id);
    }
    // Streaming owners consume raw bytes with their declared limits and integrity rules.
    body = request;
  }
  return Object.freeze({ request, response, url, path: Object.freeze(path), query: Object.freeze(query), body, ...(signal ? { signal } : {}) });
}

export function validateApiOperationResult(operation: CompiledApiContract, result: ApiOperationResult): ApiResponseContract {
  const status = String(result.status);
  if (!operation.contract.responses[status] && !operation.contract.responses.default) {
    throw new ApiContractError(500, "API_RESPONSE_STATUS_UNDECLARED", "response.status", operation.contract.operationId);
  }
  const descriptor = operation.contract.responses[status] ?? operation.contract.responses.default!;
  if ([101, 204, 304].includes(result.status)) {
    if (result.body !== undefined || result.stream !== undefined) throw new ApiContractError(500, "API_RESPONSE_BODY_UNEXPECTED", "response.body", operation.contract.operationId);
    return descriptor;
  }
  const headers = Object.fromEntries(Object.entries(result.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const variants = operation.responseValidators.get(status) ?? operation.responseValidators.get("default")!;
  for (const variant of variants) {
    if (variant.descriptor.mediaType === "*/*" && variant.descriptor.binary) {
      try {
        const mediaType = headers["content-type"];
        if (!mediaType) continue;
        validateHeaderValue("content-type", mediaType);
        const parsed = new MIMEType(mediaType);
        if (parsed.type.includes("*") || parsed.subtype.includes("*")) continue;
      } catch { continue; }
    } else if (headers["content-type"] && headers["content-type"]!.split(";")[0]!.trim().toLowerCase() !== variant.descriptor.mediaType.split(";")[0]!.trim().toLowerCase()) continue;
    const streamMatches = variant.descriptor.stream
      ? result.body === undefined && Boolean(result.stream && typeof result.stream.cancel === "function" && result.stream.frames
        && typeof result.stream.frames[Symbol.asyncIterator] === "function" && (!result.stream.signal
          || typeof result.stream.signal.aborted === "boolean" && typeof result.stream.signal.addEventListener === "function" && typeof result.stream.signal.removeEventListener === "function"))
      : result.stream === undefined;
    const binary = variant.descriptor.binary;
    const bytes = result.body instanceof Uint8Array ? result.body.byteLength : undefined;
    const length = headers["content-length"];
    const headMetadata = binary && operation.contract.method === "HEAD" && result.body === undefined
      && (length === undefined || /^\d+$/.test(length) && Number(length) >= (binary.minBytes ?? 0) && Number(length) <= binary.maxBytes);
    const binaryMatches = !binary || headMetadata
      || bytes !== undefined && bytes >= (binary.minBytes ?? 0) && bytes <= binary.maxBytes
        && (headers["content-length"] === undefined || /^\d+$/.test(headers["content-length"]!) && Number(headers["content-length"]) === bytes);
    if (streamMatches && binaryMatches && (!variant.body || variant.body(result.body)) && (!variant.headers || variant.headers({ "content-type": variant.descriptor.mediaType, ...headers }))) return variant.descriptor;
  }
  throw new ApiContractError(500, "API_RESPONSE_SCHEMA_INVALID", "response", operation.contract.operationId);
}
