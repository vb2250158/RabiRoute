import type http from "node:http";
import type { RoleKnowledgeSnapshot } from "../roleKnowledge.js";

export const ROLE_CONTEXT_PROJECTION_PATH = "/api/internal/role-context/resolve";
export const ROLE_CONTEXT_ROUTE_HEADER = "x-rabiroute-route-id";
export const ROLE_CONTEXT_CAPABILITY_HEADER = "x-rabiroute-persona-messaging-capability";
export const ROLE_CONTEXT_GENERATION_HEADER = "x-rabiroute-expected-application-generation-id";
export const ROLE_CONTEXT_MANAGER_HEADER = "x-rabiroute-expected-manager-instance-id";

export type RoleContextProjectionRequest = {
  roleId: string;
  signalText?: string;
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
};

export type RoleContextProjectionResponse = {
  applicationGenerationId: string;
  managerInstanceId: string;
  roleId: string;
  projection: RoleKnowledgeSnapshot;
};

export class RoleContextProjectionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    readonly code = "ROLE_CONTEXT_PROJECTION_UNAVAILABLE"
  ) {
    super(message);
    this.name = "RoleContextProjectionError";
  }
}

type JsonResponse = (response: http.ServerResponse, statusCode: number, body: unknown) => void;

export type RoleContextProjectionRouteContext = {
  identity: Readonly<{ applicationGenerationId: string; managerInstanceId: string }>;
  isLoopback: (remoteAddress: string | undefined) => boolean;
  verifyCapability: (routeId: string, roleId: string, capability: string) => boolean;
  readJsonBody: <T>(request: http.IncomingMessage, maxBytes?: number) => Promise<T>;
  resolve: (request: RoleContextProjectionRequest) => RoleKnowledgeSnapshot | undefined;
  requestRefresh: (roleId: string) => void;
  jsonResponse: JsonResponse;
};

/** Routes the private child-process projection endpoint and owns all rejection responses. */
export function handleRoleContextProjectionRequest(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: RoleContextProjectionRouteContext
): boolean {
  if (requestUrl.pathname !== ROLE_CONTEXT_PROJECTION_PATH) return false;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") {
    context.jsonResponse(response, 405, { code: -1, error: "METHOD_NOT_ALLOWED", message: "POST is required." });
    return true;
  }
  if (!context.isLoopback(request.socket.remoteAddress)) {
    context.jsonResponse(response, 403, { code: -1, error: "LOOPBACK_REQUIRED", message: "Role context is local-only." });
    return true;
  }
  const expectedGeneration = String(request.headers[ROLE_CONTEXT_GENERATION_HEADER] || "").trim();
  const expectedManager = String(request.headers[ROLE_CONTEXT_MANAGER_HEADER] || "").trim();
  if (expectedGeneration !== context.identity.applicationGenerationId || expectedManager !== context.identity.managerInstanceId) {
    context.jsonResponse(response, 409, { code: -1, error: "MANAGER_IDENTITY_MISMATCH", message: "Manager generation changed." });
    return true;
  }
  const routeId = String(request.headers[ROLE_CONTEXT_ROUTE_HEADER] || "").trim();
  const capability = String(request.headers[ROLE_CONTEXT_CAPABILITY_HEADER] || "").trim();
  void context.readJsonBody<RoleContextProjectionRequest>(request, 64 * 1024)
    .then((body) => {
      const roleId = String(body?.roleId || "").trim();
      if (!roleId || !context.verifyCapability(routeId, roleId, capability)) {
        context.jsonResponse(response, 403, { code: -1, error: "PERSONA_CAPABILITY_REQUIRED", message: "Persona capability is invalid." });
        return;
      }
      const projection = context.resolve({
        roleId,
        signalText: String(body.signalText || ""),
        includePendingConsolidation: body.includePendingConsolidation === true,
        consolidationTrigger: body.consolidationTrigger
      });
      if (!projection) {
        context.requestRefresh(roleId);
        response.setHeader("retry-after", "1");
        context.jsonResponse(response, 503, { code: -1, error: "ROLE_CONTEXT_WARMING", message: "Role context is warming; retry shortly." });
        return;
      }
      context.jsonResponse(response, 200, {
        code: 0,
        data: {
          ...context.identity,
          roleId,
          projection
        } satisfies RoleContextProjectionResponse
      });
    })
    .catch((error) => context.jsonResponse(response, 400, {
      code: -1,
      error: "INVALID_ROLE_CONTEXT_REQUEST",
      message: error instanceof Error ? error.message : String(error)
    }));
  return true;
}

type FetchRoleContextProjectionInput = RoleContextProjectionRequest & {
  managerBaseUrl: string;
  routeId: string;
  capability: string;
  applicationGenerationId: string;
  managerInstanceId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function managerProjectionUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new RoleContextProjectionError("Role context Manager URL must be an unauthenticated loopback HTTP origin.", 400, "INVALID_MANAGER_URL");
  }
  return new URL(ROLE_CONTEXT_PROJECTION_PATH, `${url.origin}/`).toString();
}

export async function fetchRoleContextProjection(input: FetchRoleContextProjectionInput): Promise<RoleKnowledgeSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Role context request timed out after ${input.timeoutMs ?? 2_500} ms.`)),
    input.timeoutMs ?? 2_500
  );
  timeout.unref?.();
  const abortFromCaller = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await (input.fetchImpl ?? fetch)(managerProjectionUrl(input.managerBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        [ROLE_CONTEXT_ROUTE_HEADER]: input.routeId,
        [ROLE_CONTEXT_CAPABILITY_HEADER]: input.capability,
        [ROLE_CONTEXT_GENERATION_HEADER]: input.applicationGenerationId,
        [ROLE_CONTEXT_MANAGER_HEADER]: input.managerInstanceId
      },
      body: JSON.stringify({
        roleId: input.roleId,
        signalText: input.signalText,
        includePendingConsolidation: input.includePendingConsolidation,
        consolidationTrigger: input.consolidationTrigger
      } satisfies RoleContextProjectionRequest),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      data?: Partial<RoleContextProjectionResponse>;
    };
    if (!response.ok) {
      throw new RoleContextProjectionError(
        String(payload.message || `Manager role context request failed with HTTP ${response.status}.`),
        response.status,
        String(payload.error || "ROLE_CONTEXT_PROJECTION_UNAVAILABLE")
      );
    }
    const data = payload.data;
    if (
      data?.applicationGenerationId !== input.applicationGenerationId
      || data.managerInstanceId !== input.managerInstanceId
      || data.roleId !== input.roleId
      || !data.projection
    ) {
      throw new RoleContextProjectionError("Manager role context response failed its generation fence.", 409, "MANAGER_IDENTITY_MISMATCH");
    }
    return data.projection;
  } catch (error) {
    if (error instanceof RoleContextProjectionError) throw error;
    throw new RoleContextProjectionError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}
