import { errorResponsePresentation } from "../shared/errorPresentation.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createManagerConfigurationOwner, createRabiApiOwner, publicRouteMutationFailure, requireRouteMutationContract, type ManagerConfigurationContext, type RabiApiContext, type RouteMutationContract } from "./rabiApi.js";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";

const empty = { type: "object", additionalProperties: false };
const ignored = { type: "object" };
const rawField = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
const lifecycleHeaders = { type: "object", additionalProperties: true, properties: {
  "x-rabiroute-expected-application-generation-id": { ...rawField, description: "Optional native generation fence; supply both lifecycle headers together." },
  "x-rabiroute-expected-manager-instance-id": { ...rawField, description: "Original selected Manager instance; paired with the generation fence." },
  "idempotency-key": { ...rawField, description: "Native Route mutation identity: 1..256 ASCII letters, digits, colon, dot, underscore or hyphen." },
  "if-match": { ...rawField, description: "Native Route mutation precondition: strong 64-hex content hash, bare or quoted. Weak ETags are rejected before body consumption." }
} };
const instanceQuery = { type: "object", additionalProperties: true, properties: {
  timeoutMs: { ...rawField, description: "Native DNS-SD operation budget; default and maximum are configurable in timeout settings (original defaults 450ms and 3000ms)." },
  ports: { ...rawField, description: "Retired input; the native owner rejects its presence rather than scanning ports." }
} };
const routeQuery = { type: "object", additionalProperties: true, properties: {
  includeProfiles: { ...rawField, description: "The first value equal to true includes unbound persona profiles." },
  presentation: { ...rawField, description: "The first value equal to mobile selects native mobile summary fields." },
  ...instanceQuery.properties
} };
const repliesQuery = { type: "object", additionalProperties: true, properties: {
  limit: { ...rawField, description: "Native numeric coercion clamped to 1..100; default 20." },
  afterId: { ...rawField, description: "Read after this native reply identity before applying the tail limit." },
  ...instanceQuery.properties
} };
const error = { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" }, errorCode: { type: "string" } }, additionalProperties: true };
const envelope = { type: "object", required: ["code"], properties: { code: { type: "number" }, data: { type: "object" }, message: { type: "string" }, receipt: { type: "object" }, routeCatalog: { type: "object" } }, additionalProperties: true };
// Discovery's selected Manager is an independently versioned native JSON owner. Its original
// proxy deliberately passes any valid JSON through, including upstream non-envelope failures.
const proxiedJson = { description: "Native selected-Manager JSON, forwarded without rewriting its fields or status.", anyOf: ["object", "array", "string", "number", "boolean", "null"].map(type => ({ type })) };
const pathSchema = (route = false) => ({ type: "object", required: route ? ["guid", "routeId"] : ["guid"], additionalProperties: false, properties: { guid: { type: "string", minLength: 1 }, ...(route ? { routeId: { type: "string", minLength: 1 } } : {}) } });
const nativeBody = (properties: Record<string, ApiSchema>) => ({ kind: "json" as const, maxBytes: 0, allowAnyContentType: true, emptyValue: {}, schema: { description: "The native owner ignores unknown properties, preserves JavaScript coercion and accepts non-null primitive or array JSON as an empty patch. Field constraints are enforced by its existing configuration and Route owners.", anyOf: [{ type: "object", properties, additionalProperties: true }, ...["array", "string", "number", "boolean"].map(type => ({ type }))] } });
const routeBase = "/api/rabi/instances/:guid/routes/:routeId";
type Guard = () => void;
type Invoke = (input: ApiOperationInput, mutation: RouteMutationContract | undefined, assertCurrent: Guard) => ApiOperationResult | Promise<ApiOperationResult>;

/** Single executable declaration source; native owner methods never decode or dispatch HTTP. */
export function createRabiControlOperations(context: RabiApiContext, managerConfig?: ManagerConfigurationContext): readonly ApiOperationDefinition[] {
  const owner = createRabiApiOwner(context);
  const define = (name: string, method: "GET" | "POST" | "PATCH", pathTemplate: string, path: ApiSchema, body: ApiOperationDefinition["contract"]["request"]["body"], invoke: Invoke,
    options: { mutation?: boolean; effects?: string; recovery?: string; response?: ApiSchema; query?: ApiSchema; preflight?: (input: Omit<ApiOperationInput, "body">) => ApiOperationResult | undefined; lifecycle?: boolean } = {}): ApiOperationDefinition => {
    const operationId = "manager.route-control." + name;
    const run = async (input: ApiOperationInput, mutation?: RouteMutationContract): Promise<ApiOperationResult> => {
      const assertCurrent = () => { input.signal?.throwIfAborted(); hasAuthenticatedConnectionRequest(input.request); };
      assertCurrent();
      const result = await invoke(input, mutation, assertCurrent);
      return { ...result, body: errorResponsePresentation(result.body, result.status) };
    };
    return { contract: { operationId, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: options.effects ?? `Read native ${name} from the existing Manager owner.`,
      request: { path, query: options.query ?? ignored, headers: pathTemplate === "/api/rabi/timeouts" ? { ...lifecycleHeaders, properties: { ...lifecycleHeaders.properties, "if-match": { ...rawField, description: "Copy the complete strong ETag returned by GET /api/rabi/timeouts, including quotes. The version is bound to this Manager generation and instance." } } } : lifecycleHeaders, body },
      responses: { "200": { mediaType: "application/json", schema: options.response ?? envelope }, default: { mediaType: "application/json", schema: pathTemplate.includes(":guid") ? proxiedJson : error } },
      effects: { mode: options.mutation ? "route-catalog-mutation" : method === "GET" ? "read" : "native-owner-action", description: options.effects ?? "Read the existing Manager and immutable Route catalog; no new Agent runtime, permission store or configuration copy." },
      recovery: { strategy: options.mutation ? "native-route-catalog-idempotency" : method === "GET" ? "repeatable-read" : "inspect-original-owner-no-blind-replay",
        ...(options.mutation ? { idempotencyHeader: "Idempotency-Key", receiptPath: "/api/rabi/instances/:guid/routes" } : {}),
        description: options.recovery ?? (options.mutation ? "Preserve the original Idempotency-Key and strong If-Match catalog hash. Native writeConfig resolves committed replay and conflicts; inspect the original receipt/catalog before repeating uncertain work." : method === "GET" ? "Repeat the read against the freshly discovered Manager generation." : "No request-level idempotency exists. Read the original owner state before retrying an uncertain action.") },
      validators: [{ id: "native-rabi-owner", description: "Authenticated remote connections use the same public owner without additional feature grants. Existing generation pair, object identity, Route CAS, native coercion and selected-Manager DNS-SD verification remain authoritative; caller credentials are never copied into proxy headers." }]
    }, prepare(input) {
      const lifecycle = options.lifecycle === false ? undefined : owner.assertLifecycle(input.request);
      if (lifecycle) return { ...lifecycle, body: errorResponsePresentation(lifecycle.body, lifecycle.status) };
      const rejected = options.preflight?.(input);
      if (rejected) return { ...rejected, body: errorResponsePresentation(rejected.body, rejected.status) };
      let mutation: RouteMutationContract | undefined;
      if (options.mutation) {
        try { mutation = requireRouteMutationContract(input.request); }
        catch (cause) { const failure = publicRouteMutationFailure(cause); return { status: failure.statusCode, body: errorResponsePresentation({ code: -1, errorCode: failure.errorCode, message: failure.message }, failure.statusCode) }; }
      }
      return prepared => run(prepared, mutation);
    }, handler: input => run(input, options.mutation ? requireRouteMutationContract(input.request) : undefined) };
  };
  const ignoredBody = { kind: "none" as const, allowIgnoredBody: true };
  const definitions: ApiOperationDefinition[] = [
    define("timeouts.read", "GET", "/api/rabi/timeouts", empty, ignoredBody, () => owner.timeouts()),
    define("timeouts.update", "PATCH", "/api/rabi/timeouts", empty, { kind: "json", maxBytes: 0, schema: { type: "object", required: ["overrides"], additionalProperties: false, properties: { overrides: { type: "object", additionalProperties: { type: "integer", minimum: 1, maximum: 2147483647 } } } } }, (input, _, guard) => owner.updateTimeouts(input.body as { overrides: unknown }, guard, String(input.request.headers["if-match"] ?? "")), { effects: "Persist timeout overrides through the global configuration owner and publish the committed snapshot. Read back before retrying an uncertain write; this does not resend any timed-out business operation." }),
    define("identity.read", "GET", "/api/rabi/identity", empty, ignoredBody, input => owner.identity(input.request)),
    define("identity.update", "PATCH", "/api/rabi/identity", empty, nativeBody({ rabiName: {}, rabiLinkRelay: {}, agentUploads: {} }), (input, _, guard) => owner.updateIdentity(input.body as any, guard), { effects: "Patch the native global configuration, synchronize the original Relay, mark affected native RabiLink gateways for restart and synchronize them. The public response excludes the saved Relay token." }),
    define("link-home.read", "GET", "/api/rabi/link-home", empty, { kind: "none" }, () => owner.home(), { query: empty,
      preflight: input => input.url.search || input.request.headers["transfer-encoding"] || Number(input.request.headers["content-length"] || 0) > 0 ? { status: 400, headers: { "cache-control": "no-store" }, body: { code: -1, errorCode: "RABILINK_HOME_INVALID_REQUEST", message: "此接口不接受查询参数或请求正文。" } } : undefined,
      response: { type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data: { type: "object", required: ["devices", "checkedAt"], additionalProperties: false, properties: { checkedAt: { type: "string" }, devices: { type: "array", items: { type: "object", required: ["id", "guid", "name", "deviceKind", "online", "capabilities", "rabiPcVersion", "isLocal"], additionalProperties: false, properties: { id: { type: "string" }, guid: { type: "string" }, name: { type: "string" }, deviceKind: { type: "string" }, online: { type: "boolean" }, capabilities: { type: "array", items: { type: "string" } }, rabiPcVersion: { type: ["string", "null"] }, isLocal: { type: "boolean" } } } } } } } } }),
    define("instances.list", "GET", "/api/rabi/instances", empty, ignoredBody, input => owner.instances(input.request, input.url), { query: instanceQuery }),
    define("routes.list", "GET", "/api/rabi/instances/:guid/routes", pathSchema(), ignoredBody, input => owner.routes(input.request, input.url, input.path.guid), { response: proxiedJson, query: routeQuery }),
    define("agent-options.read", "GET", routeBase + "/agent-options", pathSchema(true), ignoredBody, input => owner.agentOptions(input.request, input.url, input.path.guid, input.path.routeId), { response: proxiedJson }),
    define("rabilink-replies.list", "GET", routeBase + "/rabilink-replies", pathSchema(true), ignoredBody, input => owner.replies(input.request, input.url, input.path.guid, input.path.routeId), { response: proxiedJson, query: repliesQuery }),
    ...(["PATCH", "POST"] as const).map(method => define("agent-binding." + (method === "PATCH" ? "update" : "post"), method, routeBase + "/agent-binding", pathSchema(true), nativeBody({ agentAdapter: {}, codexCwd: {}, codexThreadId: {}, codexThreadName: {}, copilotThreadName: {}, copilotCwd: {}, copilotCliBin: {}, marvisAppId: {}, agentInstanceBindings: {}, remoteAgentTargets: {}, primaryAgentTarget: {}, astrbotUrl: {}, astrbotUsername: {}, astrbotPassword: {}, astrbotProjectId: {}, astrbotSessionId: {}, grokBotProfilePath: {}, grokBotBackendUrl: {}, grokBotAgentId: {}, grokBotSessionId: {}, grokBotSessionName: {}, dshSessionId: {}, dshSessionName: {}, dshCwd: {}, dshBaseUrl: {} }), (input, mutation, guard) => owner.agentBinding(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, mutation!, guard), { mutation: true, response: proxiedJson, effects: "Change the existing Route Agent binding through writeConfig's atomic catalog CAS and idempotency receipt, preserve explicit remote targets, then synchronize native gateways. No Agent prompt or fallback Runtime is started." })),
    define("message-processing.read", "GET", routeBase + "/message-processing", pathSchema(true), ignoredBody, (input, _, guard) => owner.messageProcessing(input.request, input.url, input.path.guid, input.path.routeId, undefined, undefined, guard), { response: proxiedJson }),
    define("message-processing.update", "PATCH", routeBase + "/message-processing", pathSchema(true), nativeBody({ adapter: {}, maxAgents: {} }), (input, mutation, guard) => owner.messageProcessing(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, mutation, guard), { mutation: true, response: proxiedJson, effects: "Update native per-adapter worker limits through the original Route catalog transaction. The native owner coerces and clamps maxAgents to 1..32, skips unknown adapters, and returns its committed receipt." }),
    define("message-processing.cleanup", "POST", routeBase + "/message-processing-cleanup", pathSchema(true), nativeBody({ adapter: {}, keepSessionIds: {} }), (input, _, guard) => owner.cleanup(input.request, input.url, input.path.guid, input.path.routeId, input.body as any, guard, input.signal), { response: proxiedJson, effects: "Delete only native message-processing workers selected by the original adapter/workspace/title rules, retain keepSessionIds, and persist the original worker and affinity files. DSH deletion can partially succeed; no operation-level replay guarantee exists." })
  ];
  if (managerConfig) {
    const configuration = createManagerConfigurationOwner(managerConfig);
    const schema = { type: "object", required: ["code", "routeDir", "rolesDir"], additionalProperties: false, properties: { code: { const: 0 }, routeDir: { type: "string" }, rolesDir: { type: "string" } } };
    definitions.push(
      define("manager-config.read", "GET", "/manager-config", empty, ignoredBody, () => ({ status: 200, body: configuration.read() }), { response: schema, lifecycle: false }),
      define("manager-config.update", "POST", "/manager-config", empty, nativeBody({ routeDir: {}, rolesDir: {} }), async (input, _, guard) => {
        try { return { status: 200, body: await configuration.update(input.body as any, guard) }; }
        catch (cause) { const error = cause as { statusCode?: number; code?: string }; return { status: Number.isInteger(error?.statusCode) ? error.statusCode! : 400, body: { code: -1, errorCode: typeof error?.code === "string" ? error.code : "request_failed", message: cause instanceof Error ? cause.message : String(cause) } }; }
      }, { response: schema, lifecycle: false, effects: "Patch the original Manager routeDir/rolesDir configuration, then await its existing ensureDataDirs lifecycle. Readback reports the native resolved paths; no second configuration store or extra remote permission exists." })
    );
  }
  return definitions;
}
