/** Native accepted response shapes; preserve unknown upstream extension fields. */
function freezeSchema<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freezeSchema(item); Object.freeze(value); }
  return value;
}
const object = { type: "object" } as const;
const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const nullableString = { anyOf: [string, { type: "null" }] } as const;
const nonnegativeInteger = { type: "integer", minimum: 0 } as const;
export const YEYU_WORK_ITEM_KINDS = Object.freeze(["run_game", "run_batch", "diagnose_game", "cancel_run", "observation", "incident_review", "evidence_review", "repair_validation"] as const);
export const YEYU_RECEIPT_STATES = Object.freeze(["accepted", "running", "succeeded", "rejected", "failed"] as const);
export const YEYU_HEALTH_STATES = Object.freeze(["ok", "degraded", "error"] as const);
export const YEYU_CAPABILITY_RISKS = Object.freeze(["observe_only", "controlled_write", "routine_action", "approval_required", "forbidden"] as const);
export const YEYU_WORK_ITEM_LIMITS = Object.freeze({ note: 500, refs: 50, artifactRef: 160, capabilityRef: 100, runId: 80, key: 128 });
const healthState = { type: "string", enum: YEYU_HEALTH_STATES } as const;
const capability = { type: "object", required: ["capabilityId", "version", "description", "displayName", "risk", "enabled", "requiresIdempotencyKey", "inputSchema", "outputSchema", "policy", "preEvidence", "postEvidence", "implementationHash"], properties: {
  capabilityId: string, version: string, description: string, displayName: string, risk: { type: "string", enum: YEYU_CAPABILITY_RISKS }, enabled: boolean,
  requiresIdempotencyKey: boolean, inputSchema: object, outputSchema: object, policy: object, preEvidence: { type: "array" }, postEvidence: { type: "array" }, implementationHash: string
} } as const;
export const YEYU_MANAGER_RESPONSE_SCHEMAS = freezeSchema({
  health: { type: "object", required: ["status", "manager", "storage", "eventStream", "checkedAt", "checks"], properties: {
    status: healthState, manager: string, storage: string, eventStream: string, checkedAt: string,
    checks: { type: "object", additionalProperties: { type: "object", required: ["status", "detail"], properties: { status: healthState, detail: string } } }
  } },
  meta: { type: "object", required: ["name", "version", "apiVersion", "managerId", "startedAt", "hostPolicy", "webGuiAvailable", "legacyExecutionEnabled"], properties: {
    name: string, version: string, apiVersion: string, managerId: string, startedAt: string, hostPolicy: string, webGuiAvailable: boolean, legacyExecutionEnabled: boolean
  } },
  snapshot: { type: "object", required: ["stateVersion", "generatedAt", "eventCursor", "manager", "health", "gameDay", "recentBatches", "games", "counters"], properties: {
    stateVersion: nonnegativeInteger, generatedAt: string, eventCursor: string, manager: object, health: object, gameDay: string,
    activeBatch: { anyOf: [object, { type: "null" }] }, recentBatches: { type: "array", items: object }, games: { type: "array", items: object }, counters: object
  } },
  capabilities: { type: "object", required: ["items", "total"], properties: { total: nonnegativeInteger, items: { type: "array", items: capability } } },
  receipt: { type: "object", required: ["commandId", "idempotencyKey", "acceptedStateVersion", "state", "message", "result", "submittedAt", "replayed"], properties: {
    commandId: string, idempotencyKey: string, requestId: nullableString, statusUrl: nullableString, acceptedStateVersion: nonnegativeInteger,
    state: { type: "string", enum: YEYU_RECEIPT_STATES }, message: string, result: object, submittedAt: string, completedAt: nullableString, replayed: boolean
  } }
} as const);
const opaqueId = (maxLength: number) => ({ type: "string", minLength: 1, maxLength, pattern: "^[A-Za-z0-9._:-]+$" });
const key = { type: "string", minLength: 1, maxLength: YEYU_WORK_ITEM_LIMITS.key, pattern: "^[!-~]+$" } as const;
export const YEYU_WORK_ITEM_REQUEST_SCHEMA = freezeSchema({
  type: "object", required: ["workItem", "idempotencyKey", "expectedStateVersion"], properties: {
    idempotencyKey: key, requestId: { anyOf: [key, { enum: ["", null, false, 0] }], description: "The existing facade omits falsy requestId values; nonempty values must be visible ASCII." }, expectedStateVersion: nonnegativeInteger,
    workItem: { type: "object", required: ["kind"], properties: {
      kind: { type: "string", enum: YEYU_WORK_ITEM_KINDS }, gameId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" }, cadence: { type: "string", enum: ["daily", "weekly"] },
      runId: opaqueId(YEYU_WORK_ITEM_LIMITS.runId), note: { anyOf: [{ type: "string", maxLength: YEYU_WORK_ITEM_LIMITS.note }, { type: "null" }], description: "Native validation additionally counts JavaScript UTF-16 units; null means the existing empty default." },
      artifactRefs: { anyOf: [{ type: "array", maxItems: YEYU_WORK_ITEM_LIMITS.refs, items: opaqueId(YEYU_WORK_ITEM_LIMITS.artifactRef) }, { type: "null" }] },
      allowedCapabilityRefs: { anyOf: [{ type: "array", maxItems: YEYU_WORK_ITEM_LIMITS.refs, items: opaqueId(YEYU_WORK_ITEM_LIMITS.capabilityRef) }, { type: "null" }] }
    }, allOf: [
      { if: { properties: { kind: { enum: ["run_game", "diagnose_game"] } } }, then: { properties: { gameId: true }, required: ["gameId"] } },
      { if: { properties: { kind: { const: "cancel_run" } } }, then: { properties: { runId: true }, required: ["runId"] } }
    ] }
  }
} as const);
