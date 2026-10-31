import { ApiContractError, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult, type ApiSchema } from "./apiOperationContract.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { readAgentDeliveryAuthority, type AgentDeliveryAuthorityContext } from "./agentDeliveryAuthorityRoutes.js";
import { captureIdentityResetAuthority, createInstanceIdentityResetOwner, IdentityResetAuthorizationError, IdentityResetOwnerChangedError, IdentityResetError, type InstanceIdentityResetContext } from "./identityResetRoutes.js";
import { sourcePatchOperationView } from "./sourcePatchRoutes.js";
import type { ManagerSourcePatchService } from "./sourcePatchService.js";
import type { WebPatchService } from "./webPatchService.js";

const empty = { type: "object", additionalProperties: false };
const ignored = { type: "object" };
const string = { type: "string" };
const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
const noBody = { kind: "none" as const, allowIgnoredBody: true };
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties)): ApiSchema => ({ type: "object", properties, required, additionalProperties: true });
const envelope = (data: ApiSchema) => object({ code: { const: 0 }, data });
const failure = object({ code: { anyOf: [{ type: "number" }, string] }, message: string }, ["code"]);
const resetStatus = object({ operationId: uuid, state: { enum: ["queued", "committed", "rolled_back", "failed"] }, newGuid: uuid, message: string }, ["operationId", "state"]);
const sourceOperation = object({ operationId: string, moduleId: string, state: { enum: ["pending", "committed", "failed", "indeterminate"] },
  commitState: { enum: ["unknown", "committed", "not_started"] }, createdAt: string, result: ignored, error: string }, ["operationId", "moduleId", "state", "commitState", "createdAt"]);
const integer = { type: "integer", minimum: 0 };
const healthSnapshot = object({ protocolVersion: { const: 1 }, applicationGenerationId: string, managerInstanceId: string, managerBaseUrl: string,
  health: object({ state: string, live: { type: "boolean" }, requiredReady: { type: "boolean" } }), pluginReadiness: ignored,
  sourcePatches: ignored, routeLifecycle: ignored, backgroundLifecycle: ignored }, ["protocolVersion", "applicationGenerationId", "health", "pluginReadiness", "routeLifecycle", "backgroundLifecycle"]);
const automaticSnapshot = object({ state: string, reason: string, digest: string, webInputDigest: string, publication: ignored, runtime: ignored,
  changedFiles: { type: "array", items: string }, reasons: { type: "array" } }, ["state"]);
const sourceSnapshot = object({ state: { enum: ["closed", "failed", "degraded", "starting", "ready"] }, queued: integer,
  modules: { type: "array", items: object({ id: string, state: string }, ["id", "state"]) } });
const webSnapshot = object({ state: { enum: ["blocked", "starting", "ready"] }, baseline: string, backend: string, active: string, previous: string,
  revision: integer, codeRevision: string, queued: integer, activeReads: integer, error: string,
  identity: object({ applicationGenerationId: string, managerInstanceId: string, pluginGenerationId: string }),
  limits: object({ candidateBytes: integer, operations: integer, candidates: integer }) }, ["state", "queued", "activeReads", "identity", "limits"]);
const webReceipt = object({ operationId: string, fingerprint: string, state: { const: "committed" }, revision: integer, active: string, previous: string, codeRevision: string },
  ["operationId", "fingerprint", "state", "revision", "active", "previous"]);
const noStore = { "cache-control": "no-store" };
const result = (body: unknown, status = 200): ApiOperationResult => ({ status, headers: noStore, body });

const text = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const health = { type: "object", required: ["live", "requiredReady", "state"],
  properties: { live: bool, requiredReady: bool, state: text, businessReady: bool, pid: { type: "integer", minimum: 1 } }, additionalProperties: true };
const metadata: ApiSchema = { type: "object", required: ["applicationGenerationId", "managerInstanceId", "health"],
  properties: { version: text, applicationGenerationId: { type: "string", minLength: 1 }, managerInstanceId: { type: "string", minLength: 1 }, health,
    managerBaseUrl: text, managerPort: { type: "integer", minimum: 0, maximum: 65535 },
    webguiLan: { type: "object", properties: { enabled: bool, tokenConfigured: bool, listeningOnLan: bool, restartRequired: bool }, additionalProperties: true },
    pluginGeneration: { type: "object", properties: { id: text, sequence: { type: "integer", minimum: 0 } }, additionalProperties: true },
    agentUploads: { type: "object" }, readWorkers: { type: "object" }, catalogWorkers: { type: "object" }, agentScanWorkers: { type: "object" },
    performanceWorkers: { type: "object" }, httpLimits: { type: "object" }, computerName: text }, additionalProperties: true };

/** Stable discovery belongs to core; retain the original diagnostic read contract and registry authority fence. */
export function createManagerMetadataOperation(read: () => unknown): ApiOperationDefinition {
  const operationId = "manager.meta.read", pathTemplate = "/meta", schema = metadata;
    const contract: ApiOperationContract = { operationId, aliases: ["agent:GET:/meta"],
      contractVersion: "1.0.0", method: "GET", pathTemplate, exposure: "public", transport: "http",
      description: "Read current Manager identity and health, including when business dependencies are unready.",
      request: { path: { type: "object", properties: {}, additionalProperties: false },
        query: { type: "object", additionalProperties: true, description: "Existing diagnostic owners ignore query parameters. Use exact /meta without query for identity discovery." },
        headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema,
        headers: { type: "object", required: ["cache-control"], properties: { "cache-control": { const: "private, no-store" } }, additionalProperties: true } } },
      effects: { mode: "diagnostic-read", description: "Reads current identity/status through the existing diagnostic owners and performance instrumentation. Does not launch a Runtime, scan Agent sessions, change Route state or grant business permissions." },
      recovery: { strategy: "repeatable-read", description: "Rediscover through Host/READY on identity change. Health false, startup or unrelated dependency failure remains diagnostic data; it does not authorize a second Manager or a fallback Runtime." },
      validators: [{ id: "manager.diagnostics.owner-payload", description: "Identity strings are nonempty. Health values are validated by type, never required to be healthy/ready. Provider-specific diagnostic sections remain extensible. The same ingress connection authority applies before and after awaited reads; no separate persona, workspace or feature grant is introduced." }] };
    return { contract, handler: async () => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: await read() }) };
}

export type CorePublicManagerIdentity = Readonly<{ applicationGenerationId: string; managerInstanceId: string }>;
export type CorePublicOperationsContext = Readonly<{
  identity: () => CorePublicManagerIdentity;
  /** Manager always supplies metadata; optional preserves existing nine-operation factory callers. */
  metaPayload?: () => unknown;
  health: () => unknown;
  automaticUpdates: () => unknown;
  sourcePatches: Pick<ManagerSourcePatchService, "status" | "operation">;
  webPatches: Pick<WebPatchService, "status" | "operation">;
  deliveryAuthority: Omit<AgentDeliveryAuthorityContext, "assertRequestAuthority">;
  identityReset: InstanceIdentityResetContext;
}>;

/** Native read and command owners, with one executable method/path declaration per public entry.
 * Host lifecycle/publication and immutable Web assets keep their distinct existing protocols. */
export function createCorePublicOperations(context: CorePublicOperationsContext): readonly ApiOperationDefinition[] {
  const define = (ownerKey: CoreOwnerKey, name: string, method: "GET" | "POST", pathTemplate: string, description: string,
    invoke: (input: ApiOperationInput, admitted: CorePublicOperationsContext, guard: () => void) => ApiOperationResult | Promise<ApiOperationResult>, options: {
      path?: ApiSchema; query?: ApiSchema; body?: ApiOperationDefinition["contract"]["request"]["body"];
      responses?: ApiOperationDefinition["contract"]["responses"]; prepare?: ApiOperationDefinition["prepare"];
      recovery?: string; effects?: string;
    } = {}): ApiOperationDefinition => {
    const prepare: NonNullable<ApiOperationDefinition["prepare"]> = options.prepare ?? (input => {
      const admission = captureCoreOwner(input, context, ownerKey);
      return async prepared => { admission.guard(); const reply = await invoke(prepared, admission.owner, admission.guard); admission.guard(); return reply; };
    });
    return ({
    contract: { operationId: "manager.core-public." + name, contractVersion: "1.0.0", method, pathTemplate,
      description, exposure: "public", transport: "http",
      request: { path: options.path ?? empty, query: options.query ?? ignored, headers: ignored, body: options.body ?? noBody },
      responses: options.responses ?? { "200": json(envelope(ignored)), default: json(failure) },
      effects: { mode: options.effects ? "native-host-command" : "read", description: options.effects ?? description },
      recovery: { strategy: options.effects ? "native-operation-receipt" : "repeatable-read",
        description: options.recovery ?? "Repeat against the freshly discovered original Manager identity; this is a snapshot, not activation evidence." },
      validators: [{ id: "native-core-owner", description: "Capture the original target service/methods and copied Manager generation/instance before parsing; revalidate before dispatch and after awaits/disclosure. Preserve original connection authority, exact reservation identity, operation receipts and native CAS. Authenticated remote connections need no extra feature grant. Host-only publication is not reclassified as a public operation." }]
    }, prepare, handler: async input => { const prepared = await prepare(input); return typeof prepared === "function" ? prepared(input) : prepared; }
  });
  };
  const resetRun = (input: Omit<ApiOperationInput, "body">) => {
    let outcome: "not_started" | "unknown" = "not_started";
    const fail = (error: unknown): ApiOperationResult => {
      if (error instanceof IdentityResetOwnerChangedError || error instanceof IdentityResetAuthorizationError) { outcome = error.commitState; return { ...result({ code: error instanceof IdentityResetOwnerChangedError ? "owner_changed" : "authorization_revoked", commitState: outcome, ...(outcome === "unknown" ? { uncertain: true } : {}) }, error.statusCode), mutationOutcome: outcome }; }
      if (error instanceof ApiContractError) return { ...result({ code: -1, errorCode: error.code, commitState: outcome }, error.status), mutationOutcome: outcome };
      return { ...result({ code: -1, message: error instanceof IdentityResetError ? error.message : "重置请求结果未确认，请查询原操作。" }, error instanceof IdentityResetError ? error.statusCode : 503), mutationOutcome: outcome };
    };
    let guard: () => void, reset: ReturnType<typeof createInstanceIdentityResetOwner>;
    try {
      const admission = captureCoreOwner(input, context, "identityReset");
      const originalGuard = () => {
        try { admission.guard(); } catch (error) {
          if (error instanceof ApiContractError && error.status === 409) throw new IdentityResetOwnerChangedError(outcome);
          throw error;
        }
      };
      guard = captureIdentityResetAuthority(input.request, input.url, () => outcome, originalGuard);
      reset = createInstanceIdentityResetOwner(admission.owner.identityReset);
    }
    catch (error) { return fail(error); }
    if (input.url.search) return result({ code: -1, message: "此接口不接受查询参数。" }, 400);
    try {
      if (input.request.method === "POST" && !reset.available()) return result({ code: -1, message: "此操作需要安装版 RabiRoute Host。" }, 503);
      guard();
    } catch (error) { return fail(error); }
    return async (prepared: ApiOperationInput): Promise<ApiOperationResult> => {
      try {
        guard();
        const reply = prepared.request.method === "POST"
          ? await reset.enqueue(prepared.body, guard, () => { outcome = "unknown"; })
          : await reset.status(prepared.path.operationId!, prepared.signal ?? new AbortController().signal, guard);
        guard(); return { ...reply, headers: noStore, ...(outcome === "unknown" ? { mutationOutcome: outcome } : {}) };
      } catch (error) { return fail(error); }
    };
  };
  const resetPrepare: ApiOperationDefinition["prepare"] = resetRun;
  const resetHandler: ApiOperationDefinition["handler"] = input => { const prepared = resetRun(input); return typeof prepared === "function" ? prepared(input) : prepared; };
  const operationPath = (pattern: string) => object({ operationId: { type: "string", pattern } });
  return [
    ...(context.metaPayload ? [createManagerMetadataOperation(context.metaPayload)] : []),
    define("health", "health.read", "GET", "/health", "Read the original Manager application health payload.", (_input, admitted) => result(admitted.health()), { responses: { "200": json(healthSnapshot) } }),
    define("automaticUpdates", "automatic-updates.read", "GET", "/api/automatic-updates", "Read the automatic-code owner snapshot, including its native disabled state.", (_input, admitted) => result({ code: 0, data: admitted.automaticUpdates() }), { responses: { "200": json(envelope(automaticSnapshot)) } }),
    define("sourcePatches", "source-patches.read", "GET", "/api/source-patches", "Read cached source Worker state without waiting for business Workers.", (_input, admitted) => result({ code: 0, data: admitted.sourcePatches.status() }), { responses: { "200": json(envelope(sourceSnapshot)) } }),
    define("sourcePatches", "source-patch-operation.read", "GET", "/api/source-patches/operations/:operationId", "Read the original source operation, excluding private proof and fingerprint.", async (input, admitted, guard) => {
      try { const record = await admitted.sourcePatches.operation(input.path.operationId!); guard(); return result({ code: record ? 0 : -1, data: record ? sourcePatchOperationView(record) : undefined }, record ? 200 : 404); }
      catch { guard(); return result({ code: -1, message: "Source patch operation record is unavailable; do not replay." }, 503); }
    }, { path: operationPath("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"), responses: { "200": json(envelope(sourceOperation)), default: json(failure) } }),
    define("webPatches", "web-patches.read", "GET", "/api/web-patches", "Read the original Web publication state and current identity.", (_input, admitted) => result({ code: 0, data: admitted.webPatches.status() }), { responses: { "200": json(envelope(webSnapshot)) } }),
    define("webPatches", "web-patch-operation.read", "GET", "/api/web-patches/operations/:operationId", "Read native Web receipt; ready missing is 404, blocked missing is 503/unknown.", (input, admitted) => {
      const receipt = admitted.webPatches.operation(input.path.operationId!), blocked = admitted.webPatches.status().state !== "ready";
      return result({ code: receipt ? 0 : -1, data: receipt, operationState: receipt ? "committed" : blocked ? "unknown" : "not_started" }, receipt ? 200 : blocked ? 503 : 404);
    }, { path: operationPath("^[A-Za-z0-9_-]{1,128}$"), responses: { default: json(object({ code: { enum: [0, -1] }, data: webReceipt, operationState: { enum: ["committed", "unknown", "not_started"] } }, ["code", "operationState"])) } }),
    define("deliveryAuthority", "delivery-authority.read", "GET", "/api/agent/delivery-authority", "Prove an exact existing endpoint delivery reservation without disclosing its prompt.", (input, admitted, guard) => readAgentDeliveryAuthority({ deliveryId: input.query.deliveryId, generation: input.query.generation }, admitted.deliveryAuthority, guard), {
      query: { type: "object", properties: { deliveryId: { type: "string", minLength: 1, maxLength: 100 }, generation: { type: "string", minLength: 1, maxLength: 100 } }, required: ["deliveryId", "generation"], additionalProperties: true },
      responses: { "200": json(envelope(object({ authorized: { type: "boolean" }, deliveryId: string, generation: string, promptHash: string, executionOptionsHash: string, ledgerManagerInstanceId: string, source: ignored, endpoint: ignored, preparation: ignored, state: { enum: ["dispatching", "committed", "cancelled"] } }, ["authorized", "deliveryId", "generation", "promptHash", "executionOptionsHash", "ledgerManagerInstanceId", "source", "endpoint", "state"]))), "403": json(object({ code: { const: -1 }, error: { const: "DELIVERY_AUTHORITY_UNAVAILABLE" }, authorized: { const: false } })) }
    }),
    define("identityReset", "identity-reset.enqueue", "POST", "/api/rabi/identity/reset-instance-id", "Queue the original Host instance reset with exact saved GUID CAS and stable operation identity.", resetHandler, {
      prepare: resetPrepare, query: empty, body: { kind: "json", maxBytes: 2048, schema: { type: "object", additionalProperties: false, required: ["operationId", "expectedGuid", "confirmed"], properties: { operationId: uuid, expectedGuid: uuid, confirmed: { const: true } } } },
      effects: "Write only the native reset request and ask the controlled Host driver to enqueue it. 202/queued is not committed reset. Cancellation after dispatch does not cancel or replay the accepted Host transaction.",
      recovery: "Keep operationId and exact expectedGuid. Read /api/rabi/identity/reset-instance-id/:operationId; an unknown result must never be replayed with a new ID.",
      responses: { "200": json(envelope(resetStatus)), "202": json(envelope(resetStatus)), default: json(failure) }
    }),
    define("identityReset", "identity-reset.status", "GET", "/api/rabi/identity/reset-instance-id/:operationId", "Await the original reset status file event, bounded to ten seconds; disconnect closes the watcher.", resetHandler, {
      prepare: resetPrepare, query: empty, path: object({ operationId: string }), responses: { "200": json(envelope(resetStatus)), default: json(failure) }
    })
  ];
}

/** Capture once in prepare; revalidate the same principal and connection after every owner await. */
function captureGuard(input: Omit<ApiOperationInput, "body">): () => void {
  let original: ReturnType<typeof assertTrustedLanAgentPrincipal>;
  try { original = assertTrustedLanAgentPrincipal(input.request); }
  catch { throw new ApiContractError(403, "API_REQUEST_SOURCE_INVALID", "authority", "manager.core-public"); }
  const guard = () => {
    input.signal?.throwIfAborted();
    try {
      if (assertTrustedLanAgentPrincipal(input.request) !== original) throw new Error("Request principal changed.");
      hasAuthenticatedConnectionRequest(input.request);
    } catch { throw new ApiContractError(403, "API_REQUEST_SOURCE_INVALID", "authority", "manager.core-public"); }
  };
  guard(); return guard;
}

type CoreOwnerKey = Exclude<keyof CorePublicOperationsContext, "identity" | "metaPayload">;
function ownerStamp(context: CorePublicOperationsContext, key: CoreOwnerKey): readonly unknown[] {
  const owner = context[key];
  switch (key) {
    case "health": case "automaticUpdates": return [owner];
    case "sourcePatches": return [owner, context.sourcePatches.status, context.sourcePatches.operation];
    case "webPatches": return [owner, context.webPatches.status, context.webPatches.operation];
    case "deliveryAuthority": { const value = context.deliveryAuthority; return [owner, value.store, value.store.getEndpointDelivery, value.store.assertEndpointDeliveryActive, value.managerInstanceId, value.authorize, value.refreshEndpoints]; }
    case "identityReset": { const value = context.identityReset, service = value.service; return [owner, service, service.available, service.enqueue, service.status, service.waitStatus, value.currentGuid]; }
  }
}

/** Every request pins the selected native owner, its methods and a copied Manager identity before body parsing. */
function captureCoreOwner(input: Omit<ApiOperationInput, "body">, context: CorePublicOperationsContext, key: CoreOwnerKey) {
  const connection = captureGuard(input), identityReader = context.identity;
  const identity = identityReader?.();
  if (typeof identity?.applicationGenerationId !== "string" || !identity.applicationGenerationId || typeof identity.managerInstanceId !== "string" || !identity.managerInstanceId) throw new ApiContractError(503, "CORE_PUBLIC_IDENTITY_UNAVAILABLE", "identity", "manager.core-public");
  const applicationGenerationId = identity.applicationGenerationId, managerInstanceId = identity.managerInstanceId;
  const stamp = ownerStamp(context, key), owner = Object.freeze({ ...context });
  const guard = () => {
    connection();
    let changed = true;
    try {
      const current = identityReader();
      changed = context.identity !== identityReader || current?.applicationGenerationId !== applicationGenerationId || current?.managerInstanceId !== managerInstanceId
        || ownerStamp(context, key).some((value, index) => value !== stamp[index]);
    } catch { /* An unavailable original getter/owner cannot adopt or disclose this request. */ }
    if (changed) {
      throw new ApiContractError(409, "CORE_PUBLIC_OWNER_CHANGED", "owner", "manager.core-public");
    }
  };
  guard(); return { owner, guard };
}
