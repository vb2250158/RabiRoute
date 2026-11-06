import { errorResponsePresentation } from "@rabiroute/host-api/shared/errorPresentation";
import type http from "node:http";
import { getTrustedLanAgentSource, validateLanAgentRequestBody } from "@rabiroute/host-api/manager/lanAgentBodyAuthority";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { CODEX_HOOK_OPERATIONS, codexHookOperationContract, type CodexHookOperationKey } from "@rabiroute/host-api/manager/codexHookContract";
import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import {
  CodexHookContextService,
  type CodexHookEventName
} from "@rabiroute/host-api/manager/codexHookContext";

function managerBaseUrl(request: http.IncomingMessage): string {
  const host = String(request.headers.host || "").replace(/[\r\n]/g, "").trim();
  if (!host) throw new Error("Manager request Host header is required.");
  return `http://${host}`;
}

export function hookContextRequest(body: Record<string, unknown>, request: http.IncomingMessage) {
  const principal = assertTrustedLanAgentPrincipal(request);
  const trustedRemoteSource = getTrustedLanAgentSource(request);
  return {
    // Older Codex hook packages predate adapter tagging and omit `agentType`.
    // Codex is the only untagged producer, so an absent value means Codex.
    agentType: principal?.source?.provider ?? (typeof body.agentType === "string" && body.agentType.trim() ? body.agentType : "codex"),
    sessionId: principal?.source?.sessionId ?? String(body.session_id || body.sessionId || ""),
    // CLI ingress proves node/provider/session, not a configured connector Agent ID.
    ...(principal ? { sourceInstance: { instanceId: principal.nodeId } } : {}),
    ...(trustedRemoteSource ? { trustedRemoteSource: Object.freeze({ ...trustedRemoteSource }) } : {}),
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
  const status = 400;
  return { status, body: errorResponsePresentation({ code: -1,
    message: error instanceof Error ? error.message : String(error) }, status) };
}

/** Dispatch the registered operation to the existing Hook owner. */
async function runCodexHookOperation(key: CodexHookOperationKey, request: http.IncomingMessage,
  service: CodexHookContextService, sessionId?: string, body?: unknown): Promise<ApiOperationResult> {
  try {
    let data: unknown;
    if (key === "context" || key === "bind") validateLanAgentRequestBody(request, body);
    const principal = assertTrustedLanAgentPrincipal(request);
    const sourceInstance = principal ? { instanceId: principal.nodeId } : undefined;
    const sourceAgentType = principal?.source?.provider;
    switch (key) {
      case "context": data = await service.handleHook(hookContextRequest(body as Record<string, unknown>, request)); break;
      case "roles": data = { roleIds: service.listRoles() }; break;
      case "doctor": data = service.doctor(); break;
      case "sessions": data = { sessions: service.listBindings() }; break;
      case "session": data = service.getBinding(sessionId!, sourceInstance, sourceAgentType); break;
      case "bind": data = service.bindSession(sessionId!, String((body as Record<string, unknown>).roleId || ""), sourceInstance, sourceAgentType); break;
      case "unbind": data = { removed: service.unbindSession(sessionId!, sourceInstance, sourceAgentType) }; break;
    }
    return { status: 200, body: { code: 0, data } };
  } catch (error) { return hookFailure(error); }
}

export function createCodexHookOperations(service: CodexHookContextService): readonly ApiOperationDefinition[] {
  return CODEX_HOOK_OPERATIONS.map(definition => ({ contract: codexHookOperationContract(definition), handler: input =>
    runCodexHookOperation(definition.key, input.request, service, input.path.sessionId, input.body) }));
}
