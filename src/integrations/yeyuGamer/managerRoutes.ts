import { YeYuGamerManagerApiClient, YeYuGamerManagerApiError, type YeYuGamerManagerConfigInput, type YeYuGamerWorkItemCreate } from "./managerApi.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "../../manager/apiOperationContract.js";
import { assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "../../manager/speechModelSettingsAccess.js";
import { YEYU_MANAGER_RESPONSE_SCHEMAS, YEYU_WORK_ITEM_REQUEST_SCHEMA } from "./managerSchemas.js";

export type YeYuGamerManagerRouteClient = Pick<YeYuGamerManagerApiClient, "getHealth" | "getMeta" | "getSnapshot" | "getCapabilities" | "createWorkItem">;
export type YeYuGamerManagerRoutesContext = {
  getConfig: () => YeYuGamerManagerConfigInput | undefined;
  createClient?: (config: YeYuGamerManagerConfigInput | undefined) => YeYuGamerManagerRouteClient;
};
export type YeYuGamerWorkItemDispatchRequest = {
  workItem: YeYuGamerWorkItemCreate; idempotencyKey: string; expectedStateVersion: number; requestId?: string;
};
const readMethods = { health: "getHealth", meta: "getMeta", snapshot: "getSnapshot", capabilities: "getCapabilities" } as const;
const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const errorSchema = { type: "object", required: ["code", "error"], additionalProperties: true, properties: {
  code: { const: -1 }, error: { type: "object", required: ["code", "message"], additionalProperties: false, properties: { code: { type: "string" }, message: { type: "string" } } },
  mutationOutcome: { enum: ["not_started", "unknown"] }, uncertain: { type: "boolean" }
} } as const;
function presentedError(error: unknown) {
  return error instanceof YeYuGamerManagerApiError ? { status: error.status, code: error.code, message: error.message }
    : { status: 500, code: "yeyu_gamer_integration_error", message: "YeYu Gamer Manager integration failed." };
}

/** One original client/configuration per accepted request; the external Manager owns plans and receipts. */
export function createYeYuGamerManagerOperations(context: YeYuGamerManagerRoutesContext) {
  const controller = new AbortController();
  const inFlight = new Set<Promise<ApiOperationResult>>();
  let accepting = true;
  const prepare = (resource: keyof typeof readMethods | "work-items", input: Omit<ApiOperationInput, "body">): ApiOperationDefinition["handler"] | ApiOperationResult => {
    const mutation = resource === "work-items";
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let denied: YeYuGamerManagerApiError | undefined, dispatched = false;
    const access = {
      signal,
      authorize() {
        if (denied) throw denied;
        try {
          if (assertTrustedLanAgentPrincipal(input.request)) return;
          if (localModelSettingsRequestAllowed(input.request)) return;
        } catch { /* Never fall back after the original lease fails. */ }
        denied = new YeYuGamerManagerApiError(403, "yeyu_gamer_access_denied", "An enabled authenticated Agent or a trusted local caller is required.");
        throw denied;
      },
      beforeDispatch() { access.authorize(); signal.throwIfAborted(); if (mutation) dispatched = true; }
    };
    const fail = (error: unknown): ApiOperationResult => {
      try { access.authorize(); } catch (authorizationError) { error = authorizationError; }
      if (!(error instanceof YeYuGamerManagerApiError) && signal.aborted) error = new YeYuGamerManagerApiError(503, "yeyu_gamer_request_cancelled", "The original YeYu Gamer request was cancelled; inspect its original outcome before retrying.");
      const presented = presentedError(error);
      return { status: presented.status, ...(mutation ? { mutationOutcome: dispatched ? "unknown" as const : "not_started" as const } : {}), body: { code: -1, error: { code: presented.code, message: presented.message },
        ...(mutation ? { mutationOutcome: dispatched ? "unknown" : "not_started", uncertain: dispatched } : {}) } };
    };
    let client: YeYuGamerManagerRouteClient;
    try {
      access.authorize();
      if (!accepting) throw new YeYuGamerManagerApiError(503, "yeyu_gamer_stopping", "YeYu Gamer integration is stopping.");
      signal.throwIfAborted();
      const config = context.getConfig();
      client = context.createClient?.(config) ?? new YeYuGamerManagerApiClient(config);
      access.authorize();
    } catch (error) { return fail(error); }
    return fullInput => {
      const task: Promise<ApiOperationResult> = (async () => {
        try {
          access.authorize(); signal.throwIfAborted();
          let data: unknown;
          if (resource !== "work-items") data = await client[readMethods[resource]](access);
          else {
            const body = fullInput.body as YeYuGamerWorkItemDispatchRequest;
            if (!body || typeof body !== "object" || !body.workItem) throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "workItem is required.");
            data = await client.createWorkItem(body.workItem, { idempotencyKey: body.idempotencyKey, expectedStateVersion: body.expectedStateVersion,
              ...(body.requestId ? { requestId: body.requestId } : {}) }, access);
          }
          access.authorize(); signal.throwIfAborted();
          return { status: mutation ? 202 : 200, ...(mutation ? { mutationOutcome: "unknown" as const } : {}), body: { code: 0, data } };
        } catch (error) { return fail(error); }
      })().finally(() => inFlight.delete(task));
      inFlight.add(task); return task;
    };
  };
  const resources = [...Object.keys(readMethods) as (keyof typeof readMethods)[], "work-items"] as const;
  const operations = resources.map<ApiOperationDefinition>(resource => {
    const mutation = resource === "work-items";
    const contract: ApiOperationContract = {
      operationId: mutation ? "manager.yeyu-gamer.work-items.create" : "manager.yeyu-gamer." + resource + ".read",
      aliases: ["gamer:" + (mutation ? "POST" : "GET") + ":/api/agent/yeyu-gamer/" + resource],
      contractVersion: "1.0.0", method: mutation ? "POST" : "GET", pathTemplate: "/api/agent/yeyu-gamer/" + resource,
      exposure: "public", transport: "http", description: mutation ? "Create a plan-only YeYu Gamer work item through its original fixed local Manager; no game action executes here." : "Read the native YeYu Gamer " + resource + " view through its fixed local Manager.",
      request: { path: empty, query: ignored, headers: ignored, body: mutation ? { kind: "json", maxBytes: 0, allowAnyContentType: true, schema: YEYU_WORK_ITEM_REQUEST_SCHEMA } : { kind: "none" } },
      responses: { [mutation ? "202" : "200"]: { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
        properties: { code: { const: 0 }, data: mutation ? YEYU_MANAGER_RESPONSE_SCHEMAS.receipt : YEYU_MANAGER_RESPONSE_SCHEMAS[resource as keyof typeof readMethods] } } },
        default: { mediaType: "application/json", schema: errorSchema } },
      effects: { mode: mutation ? "external-plan-create" : "read", description: mutation ? "Forward the original idempotency key and expectedStateVersion, force mode=plan and requestedBy=rabiroute, and return the native receipt. The external Manager owns subsequent claim, execution and acceptance. Protected actor credentials remain in the configured local runtime directory." : "Read the original Manager. Snapshot and capabilities use its existing local actor credential; health and meta do not read credentials. No runtime starts or game action executes." },
      recovery: mutation ? { strategy: "native-idempotency-and-version", description: "Read a fresh snapshot before a new plan. Retain the original idempotencyKey, exact payload, expectedStateVersion and returned native statusUrl/commandId. This facade has no receipt lookup route; reconcile with the original Manager before retrying an uncertain dispatch. A returned receipt does not prove game execution or acceptance." }
        : { strategy: "repeatable-read", description: "Repeat the same read against the active original configuration. Missing credentials and an unavailable local dependency are not remote feature-permission failures." },
      validators: [{ id: "yeyu-native-manager", description: "The native client owns fixed loopback target, local runtime path, actor credential validation, bounded timeout, plan normalization and response schemas shared with this executable contract. Capture its configuration before body consumption, revalidate the original connection before credentials, dispatch and disclosure, and cancel/join original requests on disconnect or plugin shutdown. Unknown query fields and upstream extension fields remain accepted." }]
    };
    return { contract, prepare: input => prepare(resource, input), handler: input => { const prepared = prepare(resource, input); return typeof prepared === "function" ? prepared(input) : prepared; } };
  });
  return { operations, async stop() { accepting = false; controller.abort(new Error("YeYu Gamer integration stopped.")); await Promise.allSettled([...inFlight]); } };
}
