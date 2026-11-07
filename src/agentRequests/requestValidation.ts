export const agentThreadSourceTypes = ["primary_persona", "message_processing", "plan_secretary", "plan_agent", "agent"] as const;
/** Descriptive source label; it does not grant or restrict delivery. */
export type AgentThreadSourceType = string;

export class AgentThreadContractError extends Error {
  constructor(message: string, readonly field: string, readonly stage: "validation" | "source_verification", readonly repair: string,
    readonly code = "AGENT_THREAD_CONTRACT_INVALID") {
    super(message);
    this.name = "AgentThreadContractError";
  }
}

/** Discovery describes the same target; it never changes a frozen execution intent. */
export function agentWorkspaceMismatch(target: { provider: string; sessionId: string; instanceId?: string; agentId?: string; ownerDeviceId?: string }): AgentThreadContractError {
  const binding = target.instanceId && target.agentId ? { instanceBinding: { instanceId: target.instanceId, agentId: target.agentId,
    ...(target.ownerDeviceId ? { ownerDeviceId: target.ownerDeviceId } : {}) } } : {};
  const read = { action: "read", agentAdapter: target.provider, threadId: target.sessionId, ...binding };
  const list = { action: "list", agentAdapter: target.provider, query: "", limit: 20, offset: 0, ...binding };
  return new AgentThreadContractError(
    "Frozen execution cwd does not match the target session's registered workspace.", "cwd", "validation",
    `Query the registered session workspace: POST /api/agent/threads ${JSON.stringify(read)}; read thread.cwd (omit cwd on this read). `
    + `List sessions on the same target: POST /api/agent/threads ${JSON.stringify(list)}; follow nextOffset. `
    + "Query instance/Agent bindings: GET /api/lan-agent/instances; match instances[].instanceId and agents[].agentId. "
    + "Read the current contract with GET /api/agent/help?operationId=manager.agent.threads.action. "
    + "Keep the original request, deliveryId, receipt and frozen cwd. Discovery does not authorize changing cwd or resending the prompt. "
    + "A failed lookup does not prove the session is missing; 401/403 means the connection lacks access, while a transport/service error means the lookup failed.",
    "AGENT_WORKSPACE_MISMATCH");
}

/** Only this owner-created error is projected; arbitrary causes/remote properties are not exposed. */
export function agentThreadContractFailure(error: unknown): { code: string; field: string; message: string; repair: string; retryable: false } | undefined {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof AgentThreadContractError) return { code: error.code, field: error.field, message: error.message, repair: error.repair, retryable: false };
  }
}

/** Read-only examples keep the original execution target and leave resolution to its owner. */
export function agentThreadAmbiguity(request: { agentAdapter?: string | null; instanceBinding?: unknown }, adapter: string, field: "title" | "threadId" = "title"): AgentThreadContractError {
  const target = request.instanceBinding as { instanceId?: unknown; agentId?: unknown; ownerDeviceId?: unknown } | undefined;
  const binding = typeof target?.instanceId === "string" && typeof target.agentId === "string"
    ? { instanceBinding: { instanceId: target.instanceId, agentId: target.agentId,
      ...(typeof target.ownerDeviceId === "string" ? { ownerDeviceId: target.ownerDeviceId } : {}) } } : {};
  const list = { action: "list", agentAdapter: adapter, query: "", limit: 20, offset: 0,
    ...binding };
  return new AgentThreadContractError("Agent session name is ambiguous.", field, "validation",
    `POST /api/agent/threads ${JSON.stringify(list)}; follow nextOffset and compare complete IDs, titles and updatedAt. `
    + "Read the chosen existing session with action=read, the same agentAdapter/instanceBinding and its full threadId. "
    + "Read GET /api/agent/help?operationId=manager.agent.threads.action for the current request contract. "
    + "Preserve the original request, cwd, IDs and receipt; discovery does not create, select or send automatically. "
    + "401/403 is an access failure; a failed lookup is not evidence that no matching session exists.", "AGENT_SESSION_NAME_AMBIGUOUS");
}

export function agentThreadUnsupported(field: "action" | "agentAdapter", message: string): AgentThreadContractError {
  return new AgentThreadContractError(message, field, "validation",
    "Read GET /api/agent/help?operationId=manager.agent.threads.action for declared actions and parameters. "
    + "Read GET /api/agent-adapters/catalog for data.adapters[].type and capabilities.managedTasks.agentThreads; "
    + "GET /api/lan-agent/instances identifies the original instance/Agent binding. These catalogs describe capabilities, not permission. "
    + "Keep the same target, original IDs, cwd, request and receipt. Unsupported operations do not authorize another adapter, Runtime or replay. "
    + "401/403 is an access failure; failed discovery does not prove the adapter or action is unsupported.",
    field === "action" ? "AGENT_THREAD_ACTION_UNSUPPORTED" : "AGENT_THREAD_ADAPTER_UNSUPPORTED");
}

/** Owner IDs are opaque: preserve their complete bytes instead of guessing a provider from their shape. */
export function completeAgentSessionId(value: unknown, field: "sourceThreadId" | "threadId"): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 4096 || /[\0\r\n\u2028\u2029]/.test(value)) {
    throw new AgentThreadContractError("Complete opaque session ID is required.", field,
      field === "sourceThreadId" ? "source_verification" : "validation",
      `Supply the complete existing ${field === "sourceThreadId" ? "source" : "target"} owner's session ID without trimming or substitution.`,
      "AGENT_SESSION_ID_REQUIRED");
  }
  return value;
}

export function normalizeAgentThreadSourceType(value: unknown, _required = false): AgentThreadSourceType {
  return typeof value === "string" ? value.replace(/[\r\n\u2028\u2029]/g, " ").trim().slice(0, 80) || "agent" : "agent";
}

export function callerAgentDeliveryId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 100 || /[\0\r\n\u2028\u2029]/.test(value)) {
    throw new AgentThreadContractError("Invalid deliveryId for Agent delivery.", "deliveryId", "validation",
      "Use one stable non-empty deliveryId of at most 100 characters for this operation; retain it on retries.");
  }
  return value;
}
