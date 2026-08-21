import type http from "node:http";
import type { DeliveryReplayRequest } from "../deliveryReplay.js";
import type { GatewayConfigFile } from "../shared/gatewayConfigModel.js";
import type { ManualTriggerLaunchResult } from "./manualTriggerProcess.js";

export type GatewayManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
  triggerSource?: "manual" | "auto";
};

export type GatewayPayloadOptions = {
  includeDiagnostics?: boolean;
  includeConfigDefinitions?: boolean;
};

export type GatewayWeixinLoginTarget = {
  enabled: boolean;
  dataDir: string;
};

export type GatewayControlRoutesContext = {
  readJsonBody: <T>(request: http.IncomingMessage) => Promise<T>;
  jsonResponse: (response: http.ServerResponse, statusCode: number, body: unknown) => void;
  redirectResponse: (response: http.ServerResponse, statusCode: number, location: string) => void;
  gatewayPayload: (options?: GatewayPayloadOptions) => Record<string, unknown>;
  writeConfig: (config: GatewayConfigFile) => unknown;
  loadRuntimes: () => void;
  syncRunningGateways: () => void;
  runtimeStatuses: () => unknown[];
  networkOptionsPayload: () => Record<string, unknown>;
  startGateway: (id: string) => void;
  stopGateway: (id: string) => void;
  restartGateway: (id: string) => void;
  removeGatewayConfig: (id: string) => void;
  weixinLoginTarget: (id: string) => GatewayWeixinLoginTarget | undefined;
  requestWeixinLogin: (dataDir: string) => void;
  triggerManualRule: (id: string, request: GatewayManualTriggerRequest) => ManualTriggerLaunchResult;
  listDeliveryReplayAttempts: (id: string, limit: number, status: string | null) => Record<string, unknown>;
  replayDelivery: (id: string, request: DeliveryReplayRequest) => Promise<void>;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function runTrackedOperation<T>(
  context: Pick<GatewayControlRoutesContext, "trackOperation">,
  operation: Promise<T>
): void {
  void (context.trackOperation?.(operation) ?? operation);
}

function decodedGatewayId(encodedId: string): string {
  return decodeURIComponent(encodedId);
}

function handleGatewayAction(
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/(start|stop|restart|delete)$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  const action = match[2];
  try {
    if (action === "start") {
      context.startGateway(id);
    } else if (action === "stop") {
      context.stopGateway(id);
    } else if (action === "restart") {
      context.restartGateway(id);
    } else {
      context.removeGatewayConfig(id);
      context.loadRuntimes();
      context.syncRunningGateways();
      context.jsonResponse(response, 200, context.gatewayPayload());
      return true;
    }
  } catch (error) {
    context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
    return true;
  }

  context.jsonResponse(response, 200, {
    code: 0,
    message: `requested ${action}`,
    data: context.runtimeStatuses()
  });
  return true;
}

function handleWeixinLogin(
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/weixin-login$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  const target = context.weixinLoginTarget(id);
  if (!target) {
    context.jsonResponse(response, 404, { code: -1, message: `Gateway not found: ${id}` });
    return true;
  }
  if (!target.enabled) {
    context.jsonResponse(response, 400, { code: -1, message: "该 Route 未启用个人微信消息端。" });
    return true;
  }

  try {
    context.requestWeixinLogin(target.dataDir);
    context.jsonResponse(response, 202, {
      code: 0,
      message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。"
    });
  } catch (error) {
    context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
  }
  return true;
}

function handleManualTrigger(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/manual-trigger$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  runTrackedOperation(context, context.readJsonBody<GatewayManualTriggerRequest>(request)
    .then((body) => {
      const result = context.triggerManualRule(id, body);
      context.jsonResponse(response, 202, {
        code: 0,
        message: result.alreadyRunning ? "manual trigger already running" : "manual trigger accepted",
        data: result
      });
    })
    .catch((error) => {
      context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
    }));
  return true;
}

function handleDeliveryReplay(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  const match = requestUrl.pathname.match(/^\/gateways\/([^/]+)\/delivery-replay$/);
  if (!match) return false;

  const id = decodedGatewayId(match[1]);
  if (request.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") ?? "50") || 50;
      const status = requestUrl.searchParams.get("status");
      context.jsonResponse(response, 200, {
        code: 0,
        ...context.listDeliveryReplayAttempts(id, limit, status)
      });
    } catch (error) {
      context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
    }
    return true;
  }

  if (request.method === "POST") {
    runTrackedOperation(context, context.readJsonBody<DeliveryReplayRequest>(request)
      .then((body) => context.replayDelivery(id, body))
      .then(() => {
        context.jsonResponse(response, 202, {
          code: 0,
          message: "delivery replay requested",
          data: context.runtimeStatuses()
        });
      })
      .catch((error) => {
        context.jsonResponse(response, 500, { code: -1, message: errorMessage(error) });
      }));
    return true;
  }

  context.jsonResponse(response, 405, { code: -1, message: "Method not allowed" });
  return true;
}

export function handleGatewayControlApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: GatewayControlRoutesContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/gateways") {
    context.jsonResponse(response, 200, context.gatewayPayload({
      includeDiagnostics: requestUrl.searchParams.get("summary") !== "1",
      includeConfigDefinitions: requestUrl.searchParams.get("summary") !== "1"
        || requestUrl.searchParams.get("includeConfig") === "1"
    }));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/gateways") {
    runTrackedOperation(context, context.readJsonBody<GatewayConfigFile>(request)
      .then((body) => {
        context.writeConfig(body);
        context.loadRuntimes();
        context.syncRunningGateways();
        context.jsonResponse(response, 200, context.gatewayPayload());
      })
      .catch((error) => {
        context.jsonResponse(response, 400, { code: -1, message: errorMessage(error) });
      }));
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/network-options") {
    context.jsonResponse(response, 200, context.networkOptionsPayload());
    return true;
  }

  if (request.method === "POST" && handleGatewayAction(requestUrl.pathname, response, context)) return true;
  if (request.method === "POST" && handleWeixinLogin(requestUrl.pathname, response, context)) return true;
  if (request.method === "POST" && handleManualTrigger(request, requestUrl.pathname, response, context)) return true;
  if (handleDeliveryReplay(request, requestUrl, response, context)) return true;

  if (request.method === "POST" && requestUrl.pathname === "/reload") {
    context.loadRuntimes();
    context.syncRunningGateways();
    if (request.headers.accept?.includes("application/json")) {
      context.jsonResponse(response, 200, { ok: true, gateways: context.runtimeStatuses() });
    } else {
      context.redirectResponse(response, 303, "/");
    }
    return true;
  }

  return false;
}
