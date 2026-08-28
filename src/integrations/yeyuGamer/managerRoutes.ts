import type http from "node:http";
import {
  YeYuGamerManagerApiClient,
  YeYuGamerManagerApiError,
  type YeYuGamerDispatchOptions,
  type YeYuGamerManagerConfigInput,
  type YeYuGamerWorkItemCreate
} from "./managerApi.js";
import type { ManagerPluginRouteHandler } from "../../manager/managerPluginRouteRegistry.js";

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

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  return normalized === "::1"
    || normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized.startsWith("127.")
    || normalized.startsWith("::ffff:127.");
}

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

function tracked<T>(context: YeYuGamerManagerRoutesContext, operation: Promise<T>): void {
  void (context.trackOperation?.(operation) ?? operation);
}

function respondWithOperation<T>(
  response: http.ServerResponse,
  context: YeYuGamerManagerRoutesContext,
  operation: Promise<T>,
  successStatus = 200
): void {
  tracked(context, operation.then(data => {
    context.jsonResponse(response, successStatus, { code: 0, data });
  }).catch(error => {
    const presented = presentedError(error);
    context.jsonResponse(response, presented.status, {
      code: -1,
      error: {
        code: presented.code,
        message: presented.message
      }
    });
  }));
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

  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    context.jsonResponse(response, 403, {
      code: -1,
      error: {
        code: "yeyu_gamer_loopback_required",
        message: "YeYu Gamer Manager integration is available only to a local RabiRoute Agent."
      }
    });
    return true;
  }

  let client: YeYuGamerManagerRouteClient;
  try {
    const config = context.getConfig();
    client = context.createClient?.(config) ?? new YeYuGamerManagerApiClient(config);
  } catch (error) {
    const presented = presentedError(error);
    context.jsonResponse(response, presented.status, {
      code: -1,
      error: { code: presented.code, message: presented.message }
    });
    return true;
  }

  if (request.method === "GET" && readMethod) {
    respondWithOperation(response, context, client[readMethod]() as Promise<unknown>);
    return true;
  }

  if (request.method === "POST" && isWorkItemDispatch) {
    respondWithOperation(
      response,
      context,
      context.readJsonBody<YeYuGamerWorkItemDispatchRequest>(request).then(body => {
        if (!body || typeof body !== "object" || !body.workItem) {
          throw new YeYuGamerManagerApiError(400, "yeyu_gamer_work_item_rejected", "workItem is required.");
        }
        const options: YeYuGamerDispatchOptions = {
          idempotencyKey: body.idempotencyKey,
          expectedStateVersion: body.expectedStateVersion,
          ...(body.requestId ? { requestId: body.requestId } : {})
        };
        return client.createWorkItem(body.workItem, options);
      }),
      202
    );
    return true;
  }

  return false;
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
