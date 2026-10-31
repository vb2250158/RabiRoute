import type http from "node:http";
import type { ApiOperationResult } from "./apiOperationContract.js";
import type { AgentDeliveryTestResult } from "../agentDeliveryTest.js";
import type { AgentAdapterType } from "../agentAdapters/types.js";
import type { DeliveryReplayRequest } from "../deliveryReplay.js";
import type { GatewayConfigFile, GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { ManualTriggerLaunchResult } from "./manualTriggerProcess.js";

export type GatewayAgentDeliveryTestRequest = {
  agentTargetId?: string;
  agentAdapterType?: AgentAdapterType;
};

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
  gatewayPayload: (options?: GatewayPayloadOptions) => Record<string, unknown>;
  writeConfig: (
    config: GatewayConfigFile,
    expectedContentHash: string | undefined,
    operationId: string
  ) => Promise<GatewayConfigFile>;
  writeGatewayConfig: (id: string, definition: GatewayDefinition, hash: string, operationId: string) => Promise<void>;
  resolveRouteMutation: (operationId: string) => Promise<{ state: "committed" | "not_committed" }>;
  loadRuntimes: () => Promise<void>;
  syncRunningGateways: () => void;
  runtimeStatuses: () => unknown[];
  networkOptionsPayload: () => Record<string, unknown>;
  startGateway: (id: string) => void;
  stopGateway: (id: string) => void;
  restartGateway: (id: string) => void;
  removeGatewayConfig: (
    id: string,
    expectedContentHash: string | undefined,
    operationId: string
  ) => Promise<void>;
  routeCatalogVersion: () => Readonly<{
    contentHash: string;
    routeConfigHash: string;
    presentationHash: string;
    revision: number;
  }>;
  weixinLoginTarget: (id: string) => GatewayWeixinLoginTarget | undefined;
  requestWeixinLogin: (dataDir: string) => void;
  triggerManualRule: (id: string, request: GatewayManualTriggerRequest) => ManualTriggerLaunchResult;
  testAgentDelivery: (id: string, request: GatewayAgentDeliveryTestRequest) => Promise<AgentDeliveryTestResult>;
  listDeliveryReplayAttempts: (id: string, limit: number, status: string | null) => Record<string, unknown>;
  replayDelivery: (id: string, request: DeliveryReplayRequest) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown, fallback = 400): number {
  const statusCode = Number((error as { statusCode?: unknown } | null)?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : fallback;
}

function errorCode(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : "request_failed";
}

export function publicRouteMutationError(error: unknown): Readonly<{
  statusCode: number;
  errorCode: string;
  message: string;
}> {
  switch (errorCode(error)) {
    case "ROUTE_CATALOG_REVISION_CONFLICT":
    case "route_catalog_conflict":
      return Object.freeze({
        statusCode: 412,
        errorCode: "route_catalog_conflict",
        message: "Route catalog changed; refresh and retry this update."
      });
    case "ROUTE_CATALOG_IDEMPOTENCY_CONFLICT":
      return Object.freeze({
        statusCode: 409,
        errorCode: "route_catalog_idempotency_conflict",
        message: "Idempotency-Key was already used for a different route catalog update."
      });
    case "ROUTE_CATALOG_BUSY":
      return Object.freeze({
        statusCode: 503,
        errorCode: "route_catalog_busy",
        message: "Route catalog update queue is temporarily full."
      });
    case "ROUTE_CATALOG_TRANSACTION_FAILED":
      return Object.freeze({
        statusCode: 500,
        errorCode: "route_catalog_transaction_failed",
        message: "Route catalog update failed."
      });
    default:
      return Object.freeze({
        statusCode: errorStatus(error),
        errorCode: errorCode(error),
        message: errorMessage(error)
      });
  }
}

function expectedContentHash(
  request: http.IncomingMessage,
  _context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">
): string {
  const header = Array.isArray(request.headers["if-match"])
    ? request.headers["if-match"][0] ?? ""
    : request.headers["if-match"] ?? "";
  const raw = String(header).trim();
  if (!raw) {
    throw Object.assign(new Error("If-Match is required for route catalog mutations."), {
      statusCode: 400,
      code: "route_catalog_revision_required"
    });
  }
  if (raw === "*" || /^W\//i.test(raw)) {
    throw Object.assign(new Error("If-Match must contain the exact strong route catalog revision."), {
      statusCode: 400,
      code: "route_catalog_revision_invalid"
    });
  }
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw Object.assign(new Error("If-Match contains an invalid route catalog revision."), {
      statusCode: 400,
      code: "route_catalog_revision_invalid"
    });
  }
  return value.toLowerCase();
}

function routeMutationOperationId(request: http.IncomingMessage): string {
  const header = Array.isArray(request.headers["idempotency-key"])
    ? request.headers["idempotency-key"][0] ?? ""
    : request.headers["idempotency-key"] ?? "";
  const operationId = String(header).trim();
  if (!operationId) {
    throw Object.assign(new Error("Idempotency-Key is required for route catalog mutations."), {
      statusCode: 400,
      code: "idempotency_key_required"
    });
  }
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(operationId)) {
    throw Object.assign(new Error("Idempotency-Key is invalid for a route catalog mutation."), {
      statusCode: 400,
      code: "idempotency_key_invalid"
    });
  }
  return operationId;
}

function withRouteCatalogVersion(
  context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return { ...payload, routeCatalog: context.routeCatalogVersion() };
}

function withRouteMutationReceipt(
  context: Pick<GatewayControlRoutesContext, "routeCatalogVersion">,
  operationId: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const routeCatalog = context.routeCatalogVersion();
  return {
    ...payload,
    receipt: {
      state: "committed",
      operationId,
      routeConfigHash: routeCatalog.routeConfigHash
    },
    routeCatalog
  };
}
export type GatewayMutation = Readonly<{ operationId: string; contentHash: string }>;

/** Parse the original native CAS and operation identity before consuming a write body. */
export function prepareGatewayMutation(request: http.IncomingMessage, context: GatewayControlRoutesContext): GatewayMutation {
  const operationId = routeMutationOperationId(request);
  return Object.freeze({ operationId, contentHash: expectedContentHash(request, context) });
}

/** Native owner orchestration; HTTP dispatch, body parsing and leases belong to the registry. */
export function createGatewayControlOwner(context: GatewayControlRoutesContext) {
  const success = (body: unknown, status = 200): ApiOperationResult => ({ status, body });
  const failed = (error: unknown, fallback = 400): ApiOperationResult => ({ status: errorStatus(error, fallback), body: { code: -1, message: errorMessage(error) } });
  const mutationFailed = (error: unknown, includeStatus = false): ApiOperationResult => {
    const failure = publicRouteMutationError(error);
    return { status: failure.statusCode, body: { code: -1, ...(includeStatus ? { statusCode: failure.statusCode } : {}), errorCode: failure.errorCode, message: failure.message } };
  };
  return Object.freeze({
    list(summary: string | null, includeConfig: string | null): ApiOperationResult {
      return success(withRouteCatalogVersion(context, context.gatewayPayload({ includeDiagnostics: summary !== "1", includeConfigDefinitions: summary !== "1" || includeConfig === "1" })));
    },
    async replace(body: GatewayConfigFile, mutation: GatewayMutation): Promise<ApiOperationResult> {
      try { await context.writeConfig(body, mutation.contentHash, mutation.operationId); context.syncRunningGateways(); return success(withRouteMutationReceipt(context, mutation.operationId, context.gatewayPayload())); }
      catch (error) { return mutationFailed(error); }
    },
    async save(id: string, definition: GatewayDefinition, mutation: GatewayMutation): Promise<ApiOperationResult> {
      try {
        await context.writeGatewayConfig(id, definition, mutation.contentHash, mutation.operationId);
        // A committed save remains committed even if runtime activation fails.
        let activationError: string | undefined;
        try { context.syncRunningGateways(); } catch (error) { activationError = errorMessage(error); }
        return success({ ...withRouteMutationReceipt(context, mutation.operationId, context.gatewayPayload({ includeDiagnostics: false, includeConfigDefinitions: true })), activation: activationError ? { state: "failed", message: activationError } : { state: "requested" } });
      } catch (error) { return mutationFailed(error, true); }
    },
    async resolve(operationId: string): Promise<ApiOperationResult> {
      try { const result = await context.resolveRouteMutation(operationId); return success({ ...withRouteCatalogVersion(context, context.gatewayPayload({ includeDiagnostics: false, includeConfigDefinitions: true })), receipt: { ...result, operationId, routeConfigHash: context.routeCatalogVersion().routeConfigHash } }); }
      catch (error) { return mutationFailed(error, true); }
    },
    action(id: string, action: "start" | "stop" | "restart"): ApiOperationResult {
      try {
        if (action === "start") context.startGateway(id);
        else if (action === "stop") context.stopGateway(id);
        else context.restartGateway(id);
        return success({ code: 0, message: `requested ${action}`, data: context.runtimeStatuses() });
      } catch (error) { return { status: 400, body: { code: -1, message: errorMessage(error) } }; }
    },
    async remove(id: string, mutation: GatewayMutation): Promise<ApiOperationResult> {
      try { await context.removeGatewayConfig(id, mutation.contentHash, mutation.operationId); context.syncRunningGateways(); return success(withRouteMutationReceipt(context, mutation.operationId, context.gatewayPayload())); }
      catch (error) { return mutationFailed(error); }
    },
    weixinLogin(id: string): ApiOperationResult {
      const target = context.weixinLoginTarget(id);
      if (!target) return { status: 404, body: { code: -1, message: `Gateway not found: ${id}` } };
      if (!target.enabled) return { status: 400, body: { code: -1, message: "该 Route 未启用个人微信消息端。" } };
      try { context.requestWeixinLogin(target.dataDir); return success({ code: 0, message: "已明确请求生成个人微信登录二维码；不会发送消息或修改账号配置。" }, 202); }
      catch (error) { return { status: 500, body: { code: -1, message: errorMessage(error) } }; }
    },
    manual(id: string, body: GatewayManualTriggerRequest): ApiOperationResult {
      try { const result = context.triggerManualRule(id, body); return success({ code: 0, message: result.alreadyRunning ? "manual trigger already running" : "manual trigger accepted", data: result }, 202); }
      catch (error) { return { status: 500, body: { code: -1, message: errorMessage(error) } }; }
    },
    async testDelivery(id: string, body: GatewayAgentDeliveryTestRequest): Promise<ApiOperationResult> {
      try { return success({ code: 0, message: "agent delivery test completed", data: await context.testAgentDelivery(id, body) }); }
      catch (error) { return { status: 502, body: { code: -1, message: errorMessage(error) } }; }
    },
    replays(id: string, limit: string | null, status: string | null): ApiOperationResult {
      try { return success({ code: 0, ...context.listDeliveryReplayAttempts(id, Number(limit ?? "50") || 50, status) }); }
      catch (error) { return { status: 400, body: { code: -1, message: errorMessage(error) } }; }
    },
    async replay(id: string, body: DeliveryReplayRequest): Promise<ApiOperationResult> {
      try { await context.replayDelivery(id, body); return success({ code: 0, message: "delivery replay requested", data: context.runtimeStatuses() }, 202); }
      catch (error) { return { status: 500, body: { code: -1, message: errorMessage(error) } }; }
    },
    network: () => success(context.networkOptionsPayload()),
    async reload(accept: string | undefined): Promise<ApiOperationResult> {
      try { await context.loadRuntimes(); context.syncRunningGateways(); return accept?.includes("application/json") ? success({ ok: true, gateways: context.runtimeStatuses(), routeCatalog: context.routeCatalogVersion() }) : { status: 303, headers: { location: "/" } }; }
      catch (error) { return failed(error, 503); }
    }
  });
}
