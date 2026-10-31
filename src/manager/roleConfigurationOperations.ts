import { createRoleConfigurationOwner, type RoleConfigurationContext, type RoleConfigurationCommand } from "./roleConfigurationOwner.js";
import { RoleLifecycleError } from "../roleLifecycle.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { ROLE_CONFIGURATION_KEYS } from "../shared/roleConfiguration.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";

const string = { type: "string" };
const roleId = { type: "string", minLength: 1, pattern: "^[\\p{L}\\p{N}_-]+$" };
const configuration = { type: "object", properties: Object.fromEntries(ROLE_CONFIGURATION_KEYS.map(key => [key, true])) };
const roleDetail = { type: "object", required: ["roleId", "schemaVersion", "revision", "archivedAt", "config", "runningWork", "rolePath", "roleDir", "routes"],
  properties: { roleId, schemaVersion: { const: 1 }, revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, archivedAt: { type: ["string", "null"] },
    config: configuration, runningWork: { type: "integer", minimum: 0 }, rolePath: string, roleDir: string,
    routes: { type: "array", items: { type: "object", required: ["id", "name"], properties: { id: string, name: string } } } } };
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
  code: { const: -1 }, error: string, message: string, uncertain: { const: true }, mutationOutcome: { enum: ["not_started", "unknown"] }
} } } as const;
const commands = ["config", "archive", "restore", "delete"] as const;
type Action = "list" | "create" | "detail" | "references" | typeof commands[number];
const entries: readonly [Action, "GET" | "POST" | "PUT", string, ApiSchema][] = [
  ["list", "GET", "/api/roles", roleList], ["create", "POST", "/api/roles", roleDetail],
  ["detail", "GET", "/api/roles/:roleId/configuration", roleDetail],
  ["references", "GET", "/api/roles/:roleId/references", references],
  ["config", "PUT", "/api/roles/:roleId/configuration", roleDetail],
  ["archive", "POST", "/api/roles/:roleId/archive", roleDetail],
  ["restore", "POST", "/api/roles/:roleId/restore", roleDetail],
  ["delete", "POST", "/api/roles/:roleId/delete", deleted]
];
type Bound = ReturnType<ReturnType<typeof createRoleConfigurationOwner>["prepare"]>;

function failed(error: unknown, action: Action, selectedRole: string | undefined, outcome: ReturnType<Bound["mutationOutcome"]>): ApiOperationResult {
  const status = error instanceof RoleLifecycleError ? error.status : (error as { statusCode?: number })?.statusCode ?? 500;
  const uncertain = outcome === "unknown";
  recordDataMutationAudit({ level: "error", group: "persona", event: "role_operation_unconfirmed", owner: "role-configuration",
    action, target: { type: "role", id: selectedRole || "catalog" }, dataSource: { kind: "file", id: "roles" }, outcome: "failed", error });
  return { status, mutationOutcome: outcome, headers: { "cache-control": "no-store" }, body: {
    code: -1, error: error instanceof RoleLifecycleError ? error.code : "ROLE_OPERATION_FAILED",
    message: error instanceof RoleLifecycleError ? error.message : "角色操作未完成，请检查目录状态后重试。",
    mutationOutcome: outcome, ...(uncertain ? { uncertain: true } : {})
  } };
}

/** The eight native routes are executable registrations, including their complete async lifetime. */
export function createRoleConfigurationOperations(context: RoleConfigurationContext): readonly ApiOperationDefinition[] {
  const owner = createRoleConfigurationOwner(context);
  return entries.map(([action, method, pathTemplate, data]) => {
    const mutation = method !== "GET", nativeCommand = commands.includes(action as typeof commands[number]);
    const contract: ApiOperationContract = {
      operationId: `manager.roles.${action}`, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: "Manage role configuration and lifecycle independently of Route bindings using the original role storage.",
      request: {
        path: { type: "object", additionalProperties: false, ...(pathTemplate.includes(":roleId") ? { required: ["roleId"], properties: { roleId } } : {}) },
        query: action === "list" ? { type: "object", properties: { scope: string, query: string, cursor: string, limit: string } } : { type: "object" },
        headers: nativeCommand ? { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", pattern: "^[A-Za-z0-9:._-]{1,128}$" } } } : { type: "object" },
        body: !mutation ? { kind: "none", allowIgnoredBody: true } : { kind: "json", maxBytes: action === "create" ? 64 * 1024 : 2 * 1024 * 1024,
          allowAnyContentType: true, schema: { type: "object", required: action === "create" ? ["roleId", "title"] : ["expectedRevision"], properties: {
            expectedRevision: string, roleId: string, title: string, confirmationId: string, config: configuration
          } } }
      },
      responses: { [action === "create" ? "201" : "200"]: { mediaType: "application/json; charset=utf-8", schema: {
        type: "object", required: ["code", "data", ...(nativeCommand ? ["operationId", "state"] : [])], properties: {
          code: { const: 0 }, data, ...(nativeCommand ? { operationId: string, state: { const: "committed" } } : {})
        }
      } }, ...Object.fromEntries([400,403,404,409,410,412,413,500,503].map(status => [status, failure])) },
      effects: { mode: mutation ? "native-role-lifecycle-mutation" : "read", description: mutation
        ? "Preserve role locks, expectedRevision CAS, atomic JSON writes, native operation receipts, archive admission and deletion tombstones; publish catalog changes only after persisted writes. Creation is a non-atomic multi-file operation without a replay receipt."
        : "Read role catalog, revision, role-owned configuration and live references without requiring a Route or feature binding." },
      recovery: { strategy: action === "create" ? "inspect-original-role" : nativeCommand ? "native-role-receipt" : "read-current-role",
        description: action === "create" ? "Creation has no idempotency receipt. Inspect the original role directory after a partial write; do not repeat with another ID."
          : nativeCommand ? "Keep the original role ID, expectedRevision, payload and Idempotency-Key. Reconcile pending native receipts with exactly that payload; committed retries return the original result. Never replay unknown mutations with a new key."
          : "Retry against the newly discovered Manager identity and selected role root.",
        ...(nativeCommand ? { idempotencyHeader: "Idempotency-Key" } : {}) },
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
          const value = action === "list" ? await bound.list(parsed.url) : action === "create" ? await bound.create(parsed.body as RoleConfigurationCommand)
            : action === "detail" ? await bound.detail(parsed.path.roleId) : action === "references" ? await bound.references(parsed.path.roleId)
            : await bound.command(parsed.path.roleId, action, parsed.body as RoleConfigurationCommand, String(parsed.request.headers["idempotency-key"]));
          bound.assertCurrent();
          return { status: action === "create" ? 201 : 200, mutationOutcome: bound.mutationOutcome(), headers: { "cache-control": "no-store" },
            body: { code: 0, data: value, ...(nativeCommand ? { operationId: String(parsed.request.headers["idempotency-key"]), state: "committed" } : {}) } };
        } catch (error) {
          parsed.signal?.throwIfAborted();
          return failed(error, action, parsed.path.roleId, bound.mutationOutcome());
        }
      };
    };
    return { contract, prepare, handler: async input => { const bound = prepare(input); return typeof bound === "function" ? bound(input) : bound; } };
  });
}
