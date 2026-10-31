// Generated from src/manager/apiOperationContract.ts. Do not edit; run scripts/generate-plugin-api-types.mjs.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

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
