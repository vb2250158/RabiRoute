import { errorResponsePresentation } from "@rabiroute/host-api/shared/errorPresentation";
import type http from "node:http";
import { getTrustedLanAgentSource, validateLanAgentRequestBody } from "@rabiroute/host-api/manager/lanAgentBodyAuthority";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { CODEX_HOOK_OPERATIONS, codexHookOperationContract, type CodexHookOperationKey } from "@rabiroute/host-api/manager/codexHookContract";
import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import { RoleLifecycleError } from "@rabiroute/host-api/roleLifecycle";
import { desktopPetWorkDetached, desktopPetWorkEvent } from "./desktopPetWorkEvent.js";
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
    messageId: typeof body.messageId === "string" ? body.messageId : undefined,
    observedAt: typeof body.observedAt === "number" ? body.observedAt : undefined,
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
  if (error instanceof RoleLifecycleError && (error.code === "ROLE_STORAGE_WAIT_TIMEOUT" || error.code === "ROLE_STORAGE_UNAVAILABLE")) {
    return { status: error.status, body: errorResponsePresentation({ code: -1, error: error.code,
      message: error.message }, error.status) };
  }
  const status = 400;
  return { status, body: errorResponsePresentation({ code: -1,
    message: error instanceof Error ? error.message : String(error) }, status) };
}

/** Dispatch the registered operation to the existing Hook owner. */
async function runCodexHookOperation(key: CodexHookOperationKey, request: http.IncomingMessage,
  service: CodexHookContextService, publish?: (event: string, data: unknown) => void,
  sessionId?: string, body?: unknown): Promise<ApiOperationResult> {
  try {
    let data: unknown;
    if (key === "context" || key === "bind") validateLanAgentRequestBody(request, body);
    const principal = assertTrustedLanAgentPrincipal(request);
    const sourceInstance = principal ? { instanceId: principal.nodeId } : undefined;
    const sourceAgentType = principal?.source?.provider;
    switch (key) {
      case "context": {
        const hook = hookContextRequest(body as Record<string, unknown>, request);
        const previous = publish && hook.eventName === "UserPromptSubmit" && hook.sessionId.trim()
          ? service.getBinding(hook.sessionId, hook.sourceInstance, hook.agentType) : null;
        const result = await service.handleHook(hook);
        if (publish) {
          if (previous && previous.roleId !== result.binding?.roleId) {
            publish("desktop_pet_work", desktopPetWorkDetached(hook, previous.roleId));
          }
          const event = desktopPetWorkEvent(hook, result);
          if (event) publish("desktop_pet_work", event);
        }
        data = result;
        break;
      }
      case "roles": data = { roleIds: service.listRoles() }; break;
      case "doctor": data = service.doctor(); break;
      case "sessions": data = { sessions: service.listBindings() }; break;
      case "session": data = service.getBinding(sessionId!, sourceInstance, sourceAgentType); break;
      case "bind": {
        const newRole = String((body as Record<string, unknown>).roleId || "");
        const previous = publish ? service.getBinding(sessionId!, sourceInstance, sourceAgentType) : null;
        const binding = service.bindSession(sessionId!, newRole, sourceInstance, sourceAgentType);
        if (previous && previous.roleId !== binding.roleId) {
          publish?.("desktop_pet_work", desktopPetWorkDetached({ sessionId: sessionId!, agentType: sourceAgentType, sourceInstance }, previous.roleId));
        }
        data = binding;
        break;
      }
      case "unbind": {
        const previous = service.unbindSession(sessionId!, sourceInstance, sourceAgentType);
        if (previous) {
          publish?.("desktop_pet_work", desktopPetWorkDetached({ sessionId: sessionId!, agentType: sourceAgentType, sourceInstance }, previous.roleId));
        }
        data = { removed: previous };
        break;
      }
    }
    return { status: 200, body: { code: 0, data } };
  } catch (error) { return hookFailure(error); }
}

export function createCodexHookOperations(service: CodexHookContextService,
  publish?: (event: string, data: unknown) => void): readonly ApiOperationDefinition[] {
  return CODEX_HOOK_OPERATIONS.map(definition => ({ contract: codexHookOperationContract(definition), handler: input =>
    runCodexHookOperation(definition.key, input.request, service, publish, input.path.sessionId, input.body) }));
}
