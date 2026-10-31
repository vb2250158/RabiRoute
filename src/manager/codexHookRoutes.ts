import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import { validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { CODEX_HOOK_BODY_MAX_BYTES, CODEX_HOOK_OPERATIONS, codexHookOperationContract, type CodexHookOperationKey } from "./codexHookContract.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import {
  CodexHookContextService,
  CodexHookPlanStorageUnavailableError,
  type CodexHookEventName
} from "./codexHookContext.js";

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody(request: http.IncomingMessage, maximumBytes = CODEX_HOOK_BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        reject(new Error("Codex hook request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function managerBaseUrl(request: http.IncomingMessage): string {
  const host = String(request.headers.host || "").replace(/[\r\n]/g, "").trim();
  if (!host) throw new Error("Manager request Host header is required.");
  return `http://${host}`;
}

export function hookContextRequest(body: Record<string, unknown>, request: http.IncomingMessage) {
  return {
    // Older Codex hook packages predate adapter tagging and omit `agentType`.
    // Codex is the only untagged producer, so an absent value means Codex.
    agentType: typeof body.agentType === "string" && body.agentType.trim() ? body.agentType : "codex",
    sessionId: String(body.session_id || body.sessionId || ""),
    eventName: String(body.hook_event_name || body.eventName || "") as CodexHookEventName,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    source: typeof body.source === "string" ? body.source : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    turnId: typeof body.turn_id === "string" ? body.turn_id : typeof body.turnId === "string" ? body.turnId : undefined,
    toolName: typeof body.tool_name === "string" ? body.tool_name : typeof body.toolName === "string" ? body.toolName : undefined,
    toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : typeof body.toolUseId === "string" ? body.toolUseId : undefined,
    toolInput: body.tool_input ?? body.toolInput,
    toolResponse: body.tool_response ?? body.toolResponse,
    stopHookActive: body.stop_hook_active === true || body.stopHookActive === true,
    lastAssistantMessage: typeof body.last_assistant_message === "string"
      ? body.last_assistant_message
      : typeof body.lastAssistantMessage === "string"
        ? body.lastAssistantMessage
        : undefined,
    managerBaseUrl: managerBaseUrl(request)
  };
}

function hookFailure(error: unknown): ApiOperationResult {
  const status = error instanceof CodexHookPlanStorageUnavailableError ? error.statusCode : 400;
  return { status, body: errorResponsePresentation({ code: -1,
    ...(error instanceof CodexHookPlanStorageUnavailableError ? { error: error.code, commitState: "not_started" } : {}),
    message: error instanceof Error ? error.message : String(error) }, status) };
}

/** One existing service owns both executable dispatch and transitional raw fixtures. */
async function runCodexHookOperation(key: CodexHookOperationKey, request: http.IncomingMessage,
  service: CodexHookContextService, sessionId?: string, body?: unknown): Promise<ApiOperationResult> {
  try {
    let data: unknown;
    if (key === "context" || key === "bind") validateLanAgentRequestBody(request, body);
    switch (key) {
      case "context": data = await service.handleHook(hookContextRequest(body as Record<string, unknown>, request)); break;
      case "roles": data = { roleIds: service.listRoles() }; break;
      case "doctor": data = service.doctor(); break;
      case "sessions": data = { sessions: service.listBindings() }; break;
      case "session": data = service.getBinding(sessionId!); break;
      case "bind": data = service.bindSession(sessionId!, String((body as Record<string, unknown>).roleId || "")); break;
      case "unbind": assertTrustedLanAgentPrincipal(request); data = { removed: service.unbindSession(sessionId!) }; break;
    }
    return { status: 200, body: { code: 0, data } };
  } catch (error) { return hookFailure(error); }
}

export function createCodexHookOperations(service: CodexHookContextService): readonly ApiOperationDefinition[] {
  return CODEX_HOOK_OPERATIONS.map(definition => ({ contract: codexHookOperationContract(definition), handler: input =>
    runCodexHookOperation(definition.key, input.request, service, input.path.sessionId, input.body) }));
}

/** Transitional raw adapter; production registers the executable operations above. */
export function handleCodexHookApi(request: http.IncomingMessage, requestUrl: URL,
  response: http.ServerResponse, service: CodexHookContextService): boolean {
  const session = /^\/api\/codex-hook\/sessions\/([^/]+)$/.exec(requestUrl.pathname);
  const definition = CODEX_HOOK_OPERATIONS.find(item => item.method === request.method
    && (item.path.includes(":sessionId") ? Boolean(session) : requestUrl.pathname === "/api/codex-hook" + item.path));
  if (!definition) {
    if (!session) return false;
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." }); return true;
  }
  const execute = async () => {
    try {
      const body = definition.key === "context" || definition.key === "bind" ? await readJsonBody(request) : undefined;
      return await runCodexHookOperation(definition.key, request, service, session ? decodeURIComponent(session[1]!) : undefined, body);
    } catch (error) { return hookFailure(error); }
  };
  void execute().then(result => jsonResponse(response, result.status, result.body));
  return true;
}
