import { freezeApiData, type ApiOperationContract, type ApiSchema } from "./apiOperationContract.js";

export const CODEX_HOOK_BODY_MAX_BYTES = 256 * 1024;
export const CODEX_HOOK_OPERATIONS = freezeApiData([
  { key: "context", method: "POST", path: "/context", description: "Submit one original Agent session Hook event to the existing context owner." },
  { key: "roles", method: "GET", path: "/roles", description: "List selectable persona IDs." },
  { key: "doctor", method: "GET", path: "/doctor", description: "Read the existing Hook owner's diagnostics." },
  { key: "sessions", method: "GET", path: "/sessions", description: "List current session-persona bindings." },
  { key: "session", method: "GET", path: "/sessions/:sessionId", description: "Read the original session's binding, or null when absent." },
  { key: "bind", method: "PUT", path: "/sessions/:sessionId", description: "Set the original session's persona binding." },
  { key: "bind", method: "PATCH", path: "/sessions/:sessionId", description: "Set the original session's persona binding, retaining PUT semantics." },
  { key: "unbind", method: "DELETE", path: "/sessions/:sessionId", description: "Remove the original session's persona binding." }
] as const);
export type CodexHookOperationKey = typeof CODEX_HOOK_OPERATIONS[number]["key"];
const text = { type: "string" } as const;
const textFields = (names: string) => Object.fromEntries(names.split(" ").map(name => [name, text]));
const binding = { type: "object", required: ["sessionId", "roleId", "createdAt", "updatedAt"], additionalProperties: true,
  properties: { ...textFields("sessionId roleId createdAt updatedAt lastEventAt lastEventName cwd baseFingerprint lastTurnId activeRunId consolidationTurnId lastPlanCompletionPlanId lastPlanCompletionTurnId lastPlanCompletionAt lastPlanCompletionStatus lastPlanCompletionError"),
    turnContextKeys: { type: "array", items: text }, consolidationInputMemoryIds: { type: "array", items: text } } };
const nullableBinding = { anyOf: [binding, { type: "null" }] };
const resultStatus = { type: "object", required: ["status", "reason"], properties: { status: text, reason: text }, additionalProperties: true };
const completion = { type: "object", required: ["sessionId", "updatedAt", "status"],
  properties: textFields("sessionId roleId planId turnId updatedAt status gatewayId error"), additionalProperties: false };
const contextResult = { type: "object", required: ["action", "binding", "additionalContext"], additionalProperties: true,
  properties: { action: { enum: ["none", "bind", "status", "refresh", "off"] }, binding: nullableBinding, additionalContext: text,
    followup: { type: "object", required: ["decision", "reason"], properties: { decision: { const: "block" }, reason: text }, additionalProperties: false },
    completionDeliveries: { type: "array", items: { type: "object" } }, planTaskCompletion: resultStatus,
    projectFileChangeReminder: resultStatus, agentRequestStop: resultStatus,
    toolDecision: { type: "object", required: ["permissionDecision", "reason"], properties: { permissionDecision: { const: "deny" }, reason: text }, additionalProperties: false } } };
const response = (data: ApiSchema) => ({ mediaType: "application/json", schema: { type: "object", required: ["code", "data"],
  properties: { code: { const: 0 }, data }, additionalProperties: false } });
const bodyFields = "agentType session_id sessionId hook_event_name eventName prompt source cwd turn_id turnId tool_name toolName tool_use_id toolUseId tool_input toolInput tool_response toolResponse stop_hook_active stopHookActive last_assistant_message lastAssistantMessage";
const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"],
  properties: { code: { const: -1 }, message: text, reason: text, errorMessages: { type: "object" }, error: text, commitState: text }, additionalProperties: true } };
export function codexHookOperationContract(definition: typeof CODEX_HOOK_OPERATIONS[number]): ApiOperationContract {
  const { key, method } = definition;
  const pathTemplate = `/api/codex-hook${definition.path}`;
  const writeBody = key === "context" || key === "bind";
  const pathProperties = definition.path.includes(":sessionId") ? { sessionId: { type: "string", minLength: 1 } } : {};
  const data: ApiSchema = key === "context" ? contextResult : key === "roles" ? { type: "object", required: ["roleIds"],
    properties: { roleIds: { type: "array", items: text } }, additionalProperties: false }
    : key === "doctor" ? { type: "object", required: ["ok", "rolesRoot", "rolesRootAvailable", "roleIds", "storePath", "bindings", "planTaskCompletions"], additionalProperties: false,
      properties: { ok: { const: true }, rolesRoot: text, rolesRootAvailable: { type: "boolean" }, roleIds: { type: "array", items: text }, storePath: text,
        bindings: { type: "array", items: { type: "object", required: ["sessionId", "roleId", "updatedAt"], properties: textFields("sessionId roleId updatedAt"), additionalProperties: false } }, planTaskCompletions: { type: "array", items: completion } } }
    : key === "sessions" ? { type: "object", required: ["sessions"], properties: { sessions: { type: "array", items: binding } }, additionalProperties: false }
    : key === "unbind" ? { type: "object", required: ["removed"], properties: { removed: nullableBinding }, additionalProperties: false }
    : key === "bind" ? binding : nullableBinding;
  return { operationId: `agent.hook.${key}.${method.toLowerCase()}`, aliases: [`hook:${method}:${pathTemplate}`], contractVersion: "1.0.0",
    method, pathTemplate, description: definition.description, exposure: "public", transport: "http",
    request: { path: { type: "object", required: Object.keys(pathProperties), properties: pathProperties, additionalProperties: false },
      query: { type: "object", properties: {}, additionalProperties: false }, headers: { type: "object" },
      body: writeBody ? { kind: "json", maxBytes: CODEX_HOOK_BODY_MAX_BYTES, schema: { anyOf: [
        { type: "object", properties: Object.fromEntries((key === "context" ? bodyFields : "roleId").split(" ").map(name => [name, true])), additionalProperties: true },
        { type: "array" }, { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }
      ] } } : { kind: "none" } },
    responses: { "200": response(data), "400": error, ...(key === "context" ? { "503": error } : {}) },
    effects: { mode: key === "context" ? "owner-event" : method === "GET" ? "owner-read" : "binding-write",
      description: key === "context" ? "The existing Hook owner may change the original binding, plan/follow-up state and completion deliveries. Stop and tool events retain their real session, provider and turn identity. This contract creates no execution Runtime."
        : method === "GET" ? "Reads the current Hook owner. Existing cold-store initialization may persist its empty store; no prompt or completion is delivered." : "Changes only the original session's persona binding through the existing owner. It does not create a session or execute a prompt." },
    recovery: { strategy: method === "GET" ? "owner-read" : "inspect-original-owner", description: "Never replay automatically. Inspect the original session binding and, for Hook events, the original turn/plan/delivery records before repeating an uncertain event. Retain original IDs; no replacement session or Runtime." },
    validators: [{ id: "agent.hook.owner-normalization", description: "Existing snake_case/camelCase aliases, string/default normalization, supported events, role existence, trimmed session ID (1..240 characters), and owner/source checks remain in hookContextRequest and CodexHookContextService. Opaque tool input/output fields retain their original JSON values. Additional JSON fields remain compatible." },
      { id: "agent.hook.connection-and-recovery", description: "Shared ingress authenticates public management access without persona grants. Source Hook bodies retain the existing session/provider guard. Plan recovery errors preserve 503 PLAN_STORAGE_STARTUP_UNAVAILABLE and commitState=not_started; the service owns all follow-up and delivery behavior." }] };
}
