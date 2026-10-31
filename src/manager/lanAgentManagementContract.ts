import type { ApiOperationContract, ApiSchema } from "./apiOperationContract.js";

const text = { type: "string" }, strings = { type: "array", items: text }, flag = { type: "boolean" };
const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties), additionalProperties = false): ApiSchema =>
  ({ type: "object", properties, required, additionalProperties });
const agent = object({ agentId: text, name: text, provider: text, enabled: flag, workspace: text, sessionId: text,
  managedSessionIds: strings, model: text, reasoningEffort: text, routeId: text, configRevision: text, dshBaseUrl: text }, ["agentId", "name", "provider", "enabled"], true);
// Retained records predate today's hello/task protocol. Reading them must not require newer fields.
const node = object({ nodeId: text, connected: flag, name: text, hostname: text, version: text, platform: text,
  agentTypes: strings, allowedWorkspaces: strings, agents: { type: "array", items: agent }, terminalShells: strings,
  computerCapabilities: strings, taskTargeting: text, connectedAt: text, lastSeenAt: text, remoteAddress: text,
  targetVersion: text, updateState: text, lastUpdateAt: text, lastUpdateError: text,
  releaseDigest: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Current selected publication digest for this stable node, including the common release when unassigned. Use for release selection compare-and-set." } }, ["nodeId", "connected"], true);
const taskProperties = { taskId: text, idempotencyKey: text, nodeId: text, targetAgent: text, agentId: text,
  threadId: text, message: text, cwd: text, status: text, createdAt: text, updatedAt: text, result: text, error: text };
const taskHistory = object(taskProperties, ["taskId", "nodeId", "status"], true);
const task = object(taskProperties, ["taskId", "idempotencyKey", "nodeId", "targetAgent", "threadId", "message", "status", "createdAt", "updatedAt"], true);
const instance = object({ instanceId: text, local: flag, connected: flag, agents: { type: "array", items: agent },
  name: text, hostname: text, enabled: flag, address: text, version: text }, ["instanceId", "local", "connected", "agents", "enabled"], true);
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const credentialDiagnostics = { type: "array", items: object({ index: { type: "integer", minimum: 0 }, nodeId: text,
  reason: { enum: ["invalid_record", "duplicate_identity"] } }, ["index", "reason"]) };
const envelope = (name: string, schema: ApiSchema) => json(object({ code: { const: 0 }, [name]: schema }));
const failure = json(object({ code: { const: -1 }, error: text, message: text, uncertain: flag, taskId: text }, ["code"]));
const nativeBody = (properties: Record<string, ApiSchema> = {}, required: string[] = []): ApiSchema => object(properties, required, true);
const nativeConversion = { description: "Preserves the original owner conversion/default; named native validation determines admissible values." };
const taskInput = { provider: text, targetAgent: text, agentId: text, threadId: text, message: nativeConversion,
  cwd: text, taskId: text, idempotencyKey: text };

export const LAN_AGENT_MANAGEMENT_ROUTES = Object.freeze([
  { key: "self.read", method: "GET", pathTemplate: "/api/lan-agent/self" },
  { key: "enrollments.create", method: "POST", pathTemplate: "/api/lan-agent/enrollments" },
  { key: "enroll.exchange", method: "POST", pathTemplate: "/api/lan-agent/enroll" },
  { key: "instances.list", method: "GET", pathTemplate: "/api/lan-agent/instances" },
  { key: "instances.enabled", method: "PUT", pathTemplate: "/api/lan-agent/instances/:instanceId/enabled" },
  { key: "instances.name", method: "PUT", pathTemplate: "/api/lan-agent/instances/:instanceId/name" },
  { key: "agents.create", method: "POST", pathTemplate: "/api/lan-agent/instances/:instanceId/agents" },
  ...(["tasks", "configure", "scan", "threads", "hooks"] as const).map(action => ({ key: `agents.${action}` as const,
    method: "POST" as const, pathTemplate: `/api/lan-agent/instances/:instanceId/agents/:agentId/${action}` })),
  { key: "nodes.list", method: "GET", pathTemplate: "/api/lan-agent/nodes" },
  { key: "nodes.update", method: "POST", pathTemplate: "/api/lan-agent/nodes/:nodeId/update" },
  { key: "nodes.tasks", method: "POST", pathTemplate: "/api/lan-agent/nodes/:nodeId/tasks" }
] as const);
for (const route of LAN_AGENT_MANAGEMENT_ROUTES) Object.freeze(route);
export type ManagementRoute = typeof LAN_AGENT_MANAGEMENT_ROUTES[number];

export function lanAgentManagementContract(route: ManagementRoute): ApiOperationContract {
  let request: ApiSchema = nativeBody(), success = envelope("result", { description: "Delegated provider JSON result; its original executor owns provider-specific fields and business checks." }), status = "200";
  switch (route.key) {
    case "self.read": success = envelope("data", object({ nodeId: text, connected: flag, agents: { type: "array", items: agent },
      guid: text, applicationGenerationId: text, managerInstanceId: text, health: { type: "object", additionalProperties: true } }, ["nodeId", "connected", "agents"], true)); break;
    case "enrollments.create": status = "201"; success = envelope("data", object({ ticket: text, expiresAt: { type: "number" } })); break;
    case "enroll.exchange": status = "201"; request = nativeBody({ ticket: nativeConversion, nodeId: nativeConversion, enrollmentSecret: text });
      success = envelope("data", object({ nodeId: text, token: text })); break;
    case "instances.list": success = json(object({ code: { const: 0 }, instances: { type: "array", items: instance }, credentialDiagnostics })); break;
    case "instances.enabled": request = nativeBody({ enabled: flag, expectedEnabled: flag }, ["enabled", "expectedEnabled"]);
      success = envelope("data", object({ nodeId: text, enabled: flag })); break;
    case "instances.name": request = nativeBody({ name: nativeConversion, expectedName: text }, ["expectedName"]); success = envelope("result", node); break;
    case "agents.tasks": request = nativeBody({ message: nativeConversion }); break;
    case "agents.threads": request = nativeBody({ agentAdapter: { type: "string", pattern: "\\S" } }, ["agentAdapter"]); break;
    case "nodes.list": success = json(object({ code: { const: 0 }, nodes: { type: "array", items: node }, tasks: { type: "array", items: taskHistory }, releaseVersion: text, releasePublicKeySha256: text, credentialDiagnostics })); break;
    case "nodes.update": status = "202"; request = nativeBody({ version: nativeConversion,
      releaseDigest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }], description: "Select an existing locally imported immutable signed release for this stable node only. null returns to the common publication. Omit version when selecting." },
      expectedReleaseDigest: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Required with releaseDigest; compare-and-set against this node's current selected publication digest." } }); success = envelope("result", node); break;
    case "nodes.tasks": status = "202"; request = nativeBody(taskInput, ["targetAgent", "threadId", "message"]); success = envelope("result", task); break;
  }
  const names = [...route.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
  return { operationId: `manager.lan-agent.${route.key}`, contractVersion: "1.0.0", method: route.method, pathTemplate: route.pathTemplate,
    description: "Use the existing node enrollment, instance management, signed update or explicit-session task owner.", exposure: "public", transport: "http",
    request: { path: object(Object.fromEntries(names.map(name => [name, text]))), query: { type: "object", additionalProperties: true },
      headers: { type: "object", additionalProperties: true }, body: route.method === "GET" ? { kind: "none" }
        : route.key === "enrollments.create" ? { kind: "binary", optional: true, mediaType: "application/octet-stream", allowAnyContentType: true,
          maxBytes: Number.MAX_SAFE_INTEGER, rules: ["Body is ignored and drained without parsing; ticket issuance does not consume caller body fields."] }
        : { kind: "json", allowAnyContentType: true,
          ...(typeof request === "object" && Array.isArray(request.required) && request.required.length ? {} : { emptyValue: {} }),
          maxBytes: Number.MAX_SAFE_INTEGER, schema: request } },
    responses: { [status]: success, ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(value => [String(value), failure])) },
    effects: { mode: route.method === "GET" ? "read-existing-owner" : "existing-owner-mutation", description: "Original authority/registry/local configuration owns state and persistence. Enrollment issues secrets; node listing may provision the release signing identity; task/update requests dispatch to the current connector. Discovery never includes issued secret values." },
    recovery: { strategy: "read-original-state-before-retry", description: "Retain node/instance IDs, original taskId and idempotencyKey. Await actual task acceptance, not HTTP 202 alone. Query original task/history or update status after uncertainty; name/enabled writes require current expected values. Enrollment recovery retains enrollmentSecret and nodeId; a valid recovery proof does not require a new ticket." },
    validators: [
      { id: "lan-agent.management.original-admission", description: "Authenticated public connections use original shared admission, not persona/Agent grants. Self identifies the bearer node. Enrollment exchanges an existing bootstrap ticket or recovery proof with admission enabled. Revalidate the original connection before dispatch and after awaited owner work." },
      { id: "lan-agent.management.native-fields", description: "Original owners validate node IDs, display names, expected state/revisions, bootstrap expiration/recovery and explicit full-session task targeting. Existing String/default conversions remain server-owned. Retained historical records may lack fields introduced by newer protocols." },
      { id: "lan-agent.management.delegated-provider", description: "Configure/scan/threads/hooks bodies and result extensions belong to the existing provider. Explicit agentAdapter is required for threads, including list. Path agentId overrides any body agentId; creating a remote Agent forwards no agentId. Hook requests retain their original 90-second owner timeout, other management requests 30 seconds. Local callbacks use the existing local owner." }
    ] };
}
