import { randomUUID } from "node:crypto";
import { createRoleConfigurationOwner, type RoleConfigurationContext, type RoleConfigurationCommand } from "./roleConfigurationOwner.js";
import { createRoleAutomationOperations } from "./roleAutomationOperations.js";
import { ReadSettingsError } from "@rabiroute/host-api/shared/readSettingsError";
import { RoleLifecycleError } from "@rabiroute/host-api/roleLifecycle";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import { ROLE_CONFIGURATION_KEYS } from "@rabiroute/host-api/shared/roleConfiguration";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";

const string = { type: "string" };
const roleId = { type: "string", minLength: 1, pattern: "^[\\p{L}\\p{N}_-]+$" };
const configuration = { type: "object", properties: Object.fromEntries(ROLE_CONFIGURATION_KEYS.map(key => [key, true])) };
const configurationInput = { type: "object", properties: {
  ...configuration.properties,
  automationRules: { if: { type: "array" }, then: { type: "array", items: {
    if: { type: "object" }, then: { type: "object", properties: {
      trigger: {
        if: { type: "object", required: ["type"], properties: { type: { const: "schedule" } } },
        then: { type: "object", properties: {
          schedule: {
            if: { type: "object", required: ["type"], properties: { type: { const: "daily_time" } } },
            then: { type: "object", properties: {
              timeOfDays: { type: "array", minItems: 1, items: string, description: "Daily local times, for example [10:00, 14:00, 18:00], on one rule; takes precedence over legacy timeOfDay." }
            } }
          }
        } }
      }
    } }
  } } }
}, additionalProperties: true };
const roleDetail = { type: "object", required: ["roleId", "schemaVersion", "revision", "archivedAt", "config", "runningWork", "rolePath", "roleDir", "routes"],
  properties: { roleId, schemaVersion: { const: 1 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, archivedAt: { type: ["string", "null"] },
    config: configuration, personaConfig: { type: "object" }, runningWork: { type: "integer", minimum: 0 }, rolePath: string, roleDir: string,
    routes: { type: "array", items: { type: "object", required: ["id", "name"], properties: { id: string, name: string } } } } };
const documentDetail = { type: "object", required: ["roleId", "document", "personaConfig", "revision", "configurationRevision"], properties: { roleId, document: string, personaConfig: { type: "object" }, revision: string, configurationRevision: string } };
const roleList = { type: "object", required: ["roles", "nextCursor"], properties: {
  roles: { type: "array", items: { type: "object", required: ["roleId", "title", "archivedAt", "error"], properties: {
    roleId, title: string, archivedAt: { type: ["string", "null"] }, error: string, avatarConfigured: { type: "boolean" }, avatarUrl: string
  } } }, nextCursor: { type: ["string", "null"] }
} };
const references = { type: "object", required: ["references", "runningWork"], properties: {
  references: { type: "array", items: string }, runningWork: { type: "integer", minimum: 0 }
} };
const deleted = { type: "object", required: ["roleId", "deleted"], properties: { roleId, deleted: { const: true } } };
const failure = { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "error", "message"], properties: {
  code: { const: -1 }, error: string, message: string, errorCode: string, field: string, repair: string, retryable: { const: false },
  help: { type: "object", required: ["method", "path"], properties: { method: { const: "GET" }, path: string }, additionalProperties: false },
  uncertain: { const: true }, mutationOutcome: { enum: ["not_started", "unknown"] }
} } } as const;
const commands = ["config", "config-patch", "document", "archive", "restore", "delete"] as const;
type Action = "list" | "create" | "detail" | "document-read" | "references" | typeof commands[number];
const entries: readonly [Action, "GET" | "POST" | "PUT" | "PATCH", string, ApiSchema][] = [
  ["list", "GET", "/api/roles", roleList], ["create", "POST", "/api/roles", roleDetail],
  ["detail", "GET", "/api/roles/:roleId/configuration", roleDetail],
  ["references", "GET", "/api/roles/:roleId/references", references],
  ["config", "PUT", "/api/roles/:roleId/configuration", roleDetail],
  ["config-patch", "PATCH", "/api/roles/:roleId/configuration", roleDetail],
  ["document-read", "GET", "/api/roles/:roleId/document", documentDetail],
  ["document", "PUT", "/api/roles/:roleId/document", documentDetail],
  ["archive", "POST", "/api/roles/:roleId/archive", roleDetail],
  ["restore", "POST", "/api/roles/:roleId/restore", roleDetail],
  ["delete", "POST", "/api/roles/:roleId/delete", deleted]
];
type Bound = ReturnType<ReturnType<typeof createRoleConfigurationOwner>["prepare"]>;

function failed(error: unknown, action: Action, selectedRole: string | undefined, outcome: ReturnType<Bound["mutationOutcome"]>): ApiOperationResult {
  const status = error instanceof RoleLifecycleError ? error.status : error instanceof ReadSettingsError ? 503 : (error as { statusCode?: number })?.statusCode ?? 500;
  const uncertain = outcome === "unknown";
  const operationId = `manager.roles.${action}`, rolePath = selectedRole ? `/api/roles/${encodeURIComponent(selectedRole)}` : undefined;
  let field: string | undefined, repair: string | undefined;
  if (error instanceof RoleLifecycleError) {
    switch (error.code) {
      case "ROLE_ID_INVALID": field = "body.roleId"; repair = "Read GET /api/roles for active data.roles[].roleId and GET /api/roles?scope=archived for archived roles; follow data.nextCursor separately. A new ID must follow the current create contract; do not substitute an existing role."; break;
      case "ROLE_TITLE_REQUIRED": field = "body.title"; repair = "Supply a nonempty role title in body.title; read the current create contract for its field shape."; break;
      case "ROLE_NOT_FOUND": field = "path.roleId"; repair = "Read GET /api/roles for active data.roles[].roleId and GET /api/roles?scope=archived for archived roles; follow data.nextCursor separately. Keep the original role ID while investigating a failed lookup; do not create a replacement."; break;
      case "ROLE_REVISION_CONFLICT": field = "body.expectedRevision"; repair = `Read GET ${rolePath}/${action === "document" ? "document" : "configuration"} for data.revision and current content. Merge the intended change before submitting the latest revision; keep unknown operations separate.`; break;
      case "ROLE_CONFIRMATION_REQUIRED": field = "body.confirmationId"; repair = `Read GET ${rolePath}/configuration to confirm the intended role's data.roleId. Use that exact ID only when deletion is already authorized.`; break;
      case "ROLE_TARGET_REQUIRED": field = "body.config.automationRules"; repair = "Read GET /api/lan-agent/instances for instance/Agent bindings and GET /api/agent-adapters/catalog for published capabilities. Read the selected role configuration before choosing its explicit automation target."; break;
      case "ROLE_OPERATION_CONFLICT": field = "headers.idempotency-key"; repair = `Keep the original key and payload; read GET ${rolePath}/configuration to observe current state. This key identifies another payload; discovery does not authorize rewriting or replaying the original operation.`; break;
      case "ROLE_REFERENCED": field = "path.roleId"; repair = `Read GET ${rolePath}/references for data.references and runningWork. Resolve the actual references within the original task's scope before deletion.`; break;
      case "ROLE_NOT_ARCHIVED": case "ROLE_ARCHIVED": field = action === 'create' ? 'body.roleId' : "path.roleId"; repair = rolePath
        ? `Read GET ${rolePath}/configuration for data.archivedAt. Inspect the original lifecycle intent; discovery does not archive or restore the role.`
        : 'Read GET /api/roles and GET /api/roles?scope=archived for current role IDs. Inspect the original lifecycle intent; discovery does not archive or restore a role.'; break;
    }
  }
  recordDataMutationAudit({ level: "error", group: "persona", event: "role_operation_unconfirmed", owner: "role-configuration",
    action, target: { type: "role", id: selectedRole || "catalog" }, dataSource: { kind: "file", id: "roles" }, outcome: "failed", error });
  return { status, mutationOutcome: outcome, headers: { "cache-control": "no-store" }, body: {
    code: -1, error: error instanceof RoleLifecycleError || error instanceof ReadSettingsError ? error.code : "ROLE_OPERATION_FAILED",
    ...(error instanceof RoleLifecycleError ? { errorCode: error.code } : {}),
    ...(field && repair ? { field, repair: repair + " Read GET /api/agent/help?operationId=" + encodeURIComponent(operationId)
      + ". Handle lookup failures and 401/403 access failures separately; preserve the original request, key and receipt and do not automatically replay a write.", retryable: false,
      help: { method: "GET", path: `/api/agent/help?operationId=${encodeURIComponent(operationId)}` } } : {}),
    message: error instanceof RoleLifecycleError || error instanceof ReadSettingsError ? error.message : "角色操作未完成，请检查目录状态后重试。",
    mutationOutcome: outcome, ...(uncertain ? { uncertain: true } : {})
  } };
}

/** The eight native routes are executable registrations, including their complete async lifetime. */
export function createRoleConfigurationOperations(context: RoleConfigurationContext): readonly ApiOperationDefinition[] {
  const owner = createRoleConfigurationOwner(context);
  const definitions: ApiOperationDefinition[] = entries.map(([action, method, pathTemplate, data]) => {
    const mutation = method !== "GET", nativeCommand = commands.includes(action as typeof commands[number]);
    const contract: ApiOperationContract = {
      operationId: `manager.roles.${action}`, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: "Manage role configuration and lifecycle independently of Route bindings using the original role storage.",
      request: {
        path: { type: "object", additionalProperties: false, ...(pathTemplate.includes(":roleId") ? { required: ["roleId"], properties: { roleId } } : {}) },
        query: action === "list" ? { type: "object", properties: { scope: string, query: string, cursor: string, limit: string } } : { type: "object" },
        headers: nativeCommand || action === "create" ? { type: "object", ...(nativeCommand ? { required: ["idempotency-key"] } : {}), properties: { "idempotency-key": { type: "string", pattern: "^[A-Za-z0-9:._-]{1,128}$" } } } : { type: "object" },
        body: !mutation ? { kind: "none", allowIgnoredBody: true } : { kind: "json", maxBytes: 0,
          allowAnyContentType: true, schema: { type: "object", required: action === "create" ? ["roleId", "title"] : action === "document" ? ["expectedRevision", "document"] : action === "config-patch" ? ["expectedRevision", "config"] : ["expectedRevision"], properties: {
            expectedRevision: string, roleId: string, title: string, confirmationId: string, document: string, config: action === "config" ? configurationInput : action === "config-patch" ? { type: "object" } : configuration
          } } }
      },
      responses: { [action === "create" ? "201" : "200"]: { mediaType: "application/json; charset=utf-8", schema: {
        type: "object", required: ["code", "data", ...(mutation ? ["operationId", "state"] : [])], properties: {
          code: { const: 0 }, data, ...(mutation ? { operationId: string, state: { const: "committed" } } : {})
        }
      } }, ...Object.fromEntries([400,403,404,409,410,412,413,500,503].map(status => [status, failure])) },
      effects: { mode: mutation ? "native-role-lifecycle-mutation" : "read", description: mutation
        ? "Preserve role locks, expectedRevision CAS, atomic JSON writes, native operation receipts, archive admission and deletion tombstones; publish catalog changes only after persisted writes. Creation stages complete role files before publication and preserves an operation receipt."
        : "Read role catalog, revision, role-owned configuration and live references without requiring a Route or feature binding." },
      recovery: { strategy: action === "create" || nativeCommand ? "native-role-receipt" : "read-current-role",
        description: action === "create" ? "Supply and retain the original Idempotency-Key and payload to recover a staged creation. Without a supplied key, inspect the original role after an uncertain outcome."
          : nativeCommand ? "Keep the original role ID, expectedRevision, payload and Idempotency-Key. Reconcile pending native receipts with exactly that payload; committed retries return the original result. Never replay unknown mutations with a new key."
          : "Retry against the newly discovered Manager identity and selected role root.",
        ...(nativeCommand || action === "create" ? { idempotencyHeader: "Idempotency-Key" } : {}) },
      validators: [
        { id: "original-admission", description: "Prepare captures the original authenticated connection, dynamic role root and Manager identity before body consumption. Recheck after awaits, before native writes, around catalog publication and before disclosure; explicit read-only mode rejects mutations. Empty authenticated remote bindings remain valid." },
        { id: "native-role-lifecycle", description: "Keep assertRoleAcceptsWork, revision mismatch 412, operation-key fingerprint conflict, archived-role admission, disabled Route and role-automation references, active work leases, exact deletion confirmation and recursive link rejection. Preserve fields outside ROLE_CONFIGURATION_KEYS." }
      ]
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      let bound: Bound;
      try { bound = owner.prepare(input.request, input.signal); }
      catch (error) { input.signal?.throwIfAborted(); return failed(error, action, input.path.roleId, "not_started"); }
      return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
        try {
          bound.assertCurrent();
          const operationId = mutation ? String(parsed.request.headers["idempotency-key"] || randomUUID()) : "";
          const value = action === "list" ? await bound.list(parsed.url) : action === "create" ? await bound.create(parsed.body as RoleConfigurationCommand, operationId)
            : action === "detail" ? await bound.detail(parsed.path.roleId) : action === "document-read" ? await bound.document(parsed.path.roleId) : action === "references" ? await bound.references(parsed.path.roleId)
            : await bound.command(parsed.path.roleId, action, parsed.body as RoleConfigurationCommand, String(parsed.request.headers["idempotency-key"]));
          bound.assertCurrent();
          return { status: action === "create" ? 201 : 200, mutationOutcome: bound.mutationOutcome(), headers: { "cache-control": "no-store" },
            body: { code: 0, data: value, ...(mutation ? { operationId, state: "committed" } : {}) } };
        } catch (error) {
          parsed.signal?.throwIfAborted();
          const createdRole = action === 'create' && parsed.body && typeof parsed.body === 'object' && typeof (parsed.body as { roleId?: unknown }).roleId === 'string'
            ? (parsed.body as { roleId: string }).roleId : undefined;
          return failed(error, action, parsed.path.roleId ?? createdRole, bound.mutationOutcome());
        }
      };
    };
    return { contract, prepare, handler: async input => { const bound = prepare(input); return typeof bound === "function" ? bound(input) : bound; } };
  });
  return [...definitions, ...createRoleAutomationOperations(context)];
}
