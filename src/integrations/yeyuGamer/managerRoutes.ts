import type http from "node:http";
import { hasAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";
import {
  YeYuGamerManagerApiClient,
  YeYuGamerManagerApiError,
  type YeYuGamerDispatchOptions,
  type YeYuGamerManagerConfigInput,
  type YeYuGamerRequestAccess,
  type YeYuGamerWorkItemCreate
} from "./managerApi.js";
import type { ManagerPluginRouteHandler } from "../../manager/managerPluginRouteRegistry.js";
import { assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "../../manager/speechModelSettingsAccess.js";

export type YeYuGamerManagerRouteClient = Pick<
  YeYuGamerManagerApiClient,
  "getHealth" | "getMeta" | "getSnapshot" | "getCapabilities" | "createWorkItem"
>;

export type YeYuGamerManagerRoutesContext = {
  getConfig: () => YeYuGamerManagerConfigInput | undefined;
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  createClient?: (config: YeYuGamerManagerConfigInput | undefined) => YeYuGamerManagerRouteClient;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

export type YeYuGamerWorkItemDispatchRequest = {
  workItem: YeYuGamerWorkItemCreate;
  idempotencyKey: string;
  expectedStateVersion: number;
  requestId?: string;
};

const readRoutes = Object.freeze({
  "/api/agent/yeyu-gamer/health": "getHealth",
  "/api/agent/yeyu-gamer/meta": "getMeta",
  "/api/agent/yeyu-gamer/snapshot": "getSnapshot",
  "/api/agent/yeyu-gamer/capabilities": "getCapabilities"
} as const);

function presentedError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof YeYuGamerManagerApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "yeyu_gamer_integration_error",
    message: "YeYu Gamer Manager integration failed."
  };
}

export function handleYeYuGamerManagerApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: YeYuGamerManagerRoutesContext
): boolean {
  const readMethod = readRoutes[requestUrl.pathname as keyof typeof readRoutes];
  const isWorkItemDispatch = requestUrl.pathname === "/api/agent/yeyu-gamer/work-items";
  if (!(request.method === "GET" && readMethod)
    && !(request.method === "POST" && isWorkItemDispatch)) return false;

  let denied: YeYuGamerManagerApiError | undefined;
  let dispatched = false;
  const access: YeYuGamerRequestAccess = {
    authorize() {
      if (denied) throw denied;
      try {
        if (assertTrustedLanAgentPrincipal(request)) return;
        if (localModelSettingsRequestAllowed(request)) return;
      } catch { /* An invalid original lease never falls back to local access. */ }
      denied = new YeYuGamerManagerApiError(403, "yeyu_gamer_access_denied", "An enabled authenticated Agent or a trusted local caller is required.");
      throw denied;
    },
    beforeDispatch() {
      access.authorize();
      if (isWorkItemDispatch) dispatched = true;
    }
  };
  const fail = (error: unknown) => {
    try { access.authorize(); } catch (authorizationError) { error = authorizationError; }
    const presented = presentedError(error);
    context.jsonResponse(response, presented.status, {
      code: -1,
      error: { code: presented.code, message: presented.message },
      ...(isWorkItemDispatch && presented.status === 403 ? {
        mutationOutcome: dispatched ? "unknown" : "not_started",
        uncertain: dispatched
      } : {})
    });
  };

  let client: YeYuGamerManagerRouteClient;
  try {
    access.authorize();
    const config = context.getConfig();
    client = context.createClient?.(config) ?? new YeYuGamerManagerApiClient(config);
    access.authorize();
  } catch (error) {
    fail(error);
    return true;
  }

  const operation = Promise.resolve().then(async () => {
    access.authorize();
    if (request.method === "GET" && readMethod) return client[readMethod](access);
    const body = await context.readJsonBody<YeYuGamerWorkItemDispatchRequest>(request);
    access.authorize();
    if (!body || typeof body !== "object" || !body.workItem) {
      throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "workItem is required.");
    }
    const options: YeYuGamerDispatchOptions = {
      idempotencyKey: body.idempotencyKey,
      expectedStateVersion: body.expectedStateVersion,
      ...(body.requestId ? { requestId: body.requestId } : {})
    };
    return client.createWorkItem(body.workItem, options, access);
  }).then(data => {
    access.authorize();
    context.jsonResponse(response, isWorkItemDispatch ? 202 : 200, { code: 0, data });
  }).catch(fail);
  void (context.trackOperation?.(operation) ?? operation);
  return true;
}

export function createYeYuGamerManagerRouteHandler(
  context: YeYuGamerManagerRoutesContext
): ManagerPluginRouteHandler {
  return (request, requestUrl, response) => handleYeYuGamerManagerApi(
    request,
    requestUrl,
    response,
    context
  );
}
