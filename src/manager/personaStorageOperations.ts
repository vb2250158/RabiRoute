import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { canonicalLogicalPlanId } from "../planStorageIdentity.js";
import { PLAN_ACTIVATION_STATUSES } from "../planState.js";
import { PLAN_ATTACHMENT_REQUEST_MAX_BYTES } from "../shared/planAttachmentContract.js";
import { PLAN_FEEDBACK_REQUEST_MAX_BYTES } from "../shared/planFeedbackContract.js";
import { presentPlan, presentPlans } from "../roleKnowledgePresentation.js";
import { ensurePersonaPlanWorkflow, readPersonaPlanWorkflowAsync } from "../personaPlanWorkflow.js";
import { normalizeRoleMemoryPageLimit, normalizeRolePlanPageLimit, previewRolePlan } from "../roleKnowledgePagination.js";
import { parseWorkspacePlanQuery } from "../planWorkspaceQuery.js";
import type { PlanItem } from "../roleKnowledge.js";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import { ManagerReadWorkerError, managerKnowledgePageWorkerPool, managerReadWorkerPool, type ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { PlanPageCatalogInitializingError } from "./planPageCatalogLifecycle.js";
import { RoleStorageApplicationError, roleStorageHttpError, type RoleStorageApplication, type RoleStorageCommandContext, type RoleStorageGenerationIdentity } from "./roleStorageApplication.js";
import { preparePersonaResourceAdmission } from "./personaResourceAdmission.js";
import { captureNativeStorageWork, withoutNativeStorageWork } from "./nativeStorageWork.js";
import type { ApiMethod, ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiResponseContract } from "./apiOperationContract.js";

type Work<T> = Readonly<{ result: Promise<T>; closed: Promise<void> }>;
export type PersonaStorageOperationsContext = Readonly<{
  roleDirectory(roleId: string): string;
  application(): RoleStorageApplication;
  identity(): RoleStorageGenerationIdentity;
  readOnly(): boolean;
  planHistoryContext(request: http.IncomingMessage, body: Record<string, unknown>, context: RoleStorageCommandContext): Promise<RoleStorageCommandContext>;
  scheduleFeedbackPostCommit(roleDir: string, roleId: string, gatewayId: string, plan: PlanItem, record: PlanFeedbackRecord, application: RoleStorageApplication): void;
  reportFeedbackScheduleError(roleId: string, planId: string, feedbackId: string, error: unknown): void;
  publish(type: "plan_status_catalog_changed" | "plan_feedback_changed" | "memory_consolidation_changed", data: Record<string, unknown>): void;
  rescheduleMemory(): void;
  noteMemoryRunCompleted(runId: string): void;
  /** Result deadlines remain native; closed joins the original worker release, even after a rejected result. */
  captureNativeWork?<T>(run: () => Promise<T>): Work<T>;
  pools?: Readonly<{
    knowledge: Pick<ManagerReadWorkerPool, "queryRoleFileCounts" | "queryRolePlanPage" | "queryRoleMemoryCounts" | "queryRoleMemoryPage" | "queryRoleMemoryOverview">;
    catalog: Pick<ManagerReadWorkerPool, "run" | "queryRolePlanCatalog">;
    read: Pick<ManagerReadWorkerPool, "queryRecentMemoryDetail" | "queryRoleMemoryCatalog">;
  }>;
}>;

type Admission = {
  roleId: string; roleDir: string; application: RoleStorageApplication;
  command: RoleStorageCommandContext; assertCurrent(): void; committedId?: string;
};
type Spec = Readonly<{ id: string; method: ApiMethod; suffix: string; action: string; fields?: readonly string[]; maxBytes?: number; failure?: "worker" | "page"; mutates?: boolean }>;
const planFields = ["id", "title", "focus", "status", "activationStatus", "markerStatus", "archiveStatus", "importance", "urgency", "priority", "kind", "currentStep", "currentStepId", "nextAction", "waitingFor", "isBlocked", "blockedBy", "attachments", "steps", "project", "source", "secretaryBinding", "taskBinding", "dueAt", "completedAt", "archivedAt", "createdAt", "updatedAt", "messageChannels", "keywords", "messageSource", "actor"];
const memoryFields = ["id", "title", "focus", "content", "source", "keywords"];
const workflowFields = ["key", "state", "label", "labelEn", "description", "descriptionEn", "order", "palette", "views", "currentStep", "requiresApproval", "acceptsGuidance", "setsCompletedAt", "terminal", "archiveEligible", "legacyAliases"];
const feedbackFields = ["feedbackId", "stepId", "gatewayId", "kind", "author", "source", "text", "formData", "reuseFeedbackId", "notifyAgent", "planAttachmentIds", "attachments"];
const specs: readonly Spec[] = [
  { id: "counts.read", method: "GET", suffix: "counts", action: "counts", failure: "worker" },
  { id: "counts.legacy-item", method: "GET", suffix: "counts/:ignoredItemId", action: "counts", failure: "worker" },
  { id: "plans.query", method: "POST", suffix: "plans/query", action: "plan-query", fields: ["bindingScope", "cursor", "limit", "view", "query", "sort", "statuses", "tags"], maxBytes: 1024 * 1024, failure: "page" },
  { id: "plans.list", method: "GET", suffix: "plans", action: "plan-list", failure: "page" },
  { id: "plans.read", method: "GET", suffix: "plans/:planId", action: "plan-read" },
  { id: "plans.create", method: "POST", suffix: "plans", action: "plan-create", fields: planFields, maxBytes: PLAN_ATTACHMENT_REQUEST_MAX_BYTES, mutates: true },
  { id: "plans.update", method: "PATCH", suffix: "plans/:planId", action: "plan-update", fields: planFields, maxBytes: PLAN_ATTACHMENT_REQUEST_MAX_BYTES, mutates: true },
  { id: "plans.history", method: "GET", suffix: "plans/:planId/history", action: "plan-history", failure: "worker" },
  { id: "feedback.read", method: "GET", suffix: "plans/:planId/feedback", action: "feedback-read" },
  { id: "feedback.submit", method: "POST", suffix: "plans/:planId/feedback", action: "feedback-submit", fields: feedbackFields, maxBytes: PLAN_FEEDBACK_REQUEST_MAX_BYTES, mutates: true },
  ...["plan-statuses", "plan-marker-statuses"].flatMap(resource => [
    { id: resource + ".read", method: "GET" as const, suffix: resource, action: "workflow-read" },
    { id: resource + ".create", method: "POST" as const, suffix: resource, action: "workflow-create", fields: workflowFields, mutates: true },
    { id: resource + ".update", method: "PATCH" as const, suffix: resource + "/:statusKey", action: "workflow-update", fields: workflowFields, mutates: true },
    { id: resource + ".delete", method: "DELETE" as const, suffix: resource + "/:statusKey", action: "workflow-delete", fields: ["replacementKey"], mutates: true }
  ]),
  { id: "memory.overview", method: "GET", suffix: "memory", action: "memory-overview", failure: "worker" },
  { id: "memory.recent.list", method: "GET", suffix: "memory/recent", action: "recent-list", failure: "worker" },
  { id: "memory.recent.read", method: "GET", suffix: "memory/recent/:memoryId", action: "recent-read", mutates: true },
  { id: "memory.recent.create", method: "POST", suffix: "memory/recent", action: "recent-create", fields: memoryFields, mutates: true },
  { id: "memory.recent.update", method: "PATCH", suffix: "memory/recent/:memoryId", action: "recent-update", fields: memoryFields, mutates: true },
  { id: "memory.consolidated.list", method: "GET", suffix: "memory/consolidated", action: "consolidated-list", failure: "worker" },
  { id: "memory.consolidated.read", method: "GET", suffix: "memory/consolidated/:memoryId", action: "consolidated-read", failure: "worker" },
  { id: "consolidation.runs.list", method: "GET", suffix: "memory/consolidation-runs", action: "runs-list", failure: "worker" },
  { id: "consolidation.runs.read", method: "GET", suffix: "memory/consolidation-runs/:runId", action: "runs-read" },
  { id: "consolidation.request", method: "POST", suffix: "memory/consolidation-requests", action: "consolidation-request", fields: ["triggerSource", "includeOlderThanHours", "triggerOlderThanHours", "force"], mutates: true },
  { id: "consolidation.result", method: "POST", suffix: "memory/consolidation-runs/:runId/result", action: "consolidation-result", fields: ["memories", "consolidatedMemories", "items"], mutates: true }
];

function singleHeader(request: http.IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new RoleStorageApplicationError(`${name} must be sent exactly once.`, "invalid_request", 400);
    return raw[0]?.trim() || undefined;
  }
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
function directoryIdentity(directory: string): string {
  try { return fs.realpathSync.native(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return path.resolve(directory); }
}
const ok = (data: unknown, headers?: Record<string, string>): ApiOperationResult => ({ status: 200, body: { code: 0, data }, ...(headers ? { headers } : {}) });
const missing = (message: string, roleId?: string): ApiOperationResult => ({ status: 404, body: { code: -1, message,
  ...(roleId ? { nextAction: "仅在当前角色范围未找到该计划。可按名称查询 GET /api/roles/" + encodeURIComponent(roleId) + "/plans?limit=20&query=<URL编码的名称>&sort=updated；或省略 query 列最近更新计划，沿 nextCursor 分页。核对原角色、标题、planId 和 taskBinding；保留原计划与投递编号，不自动新建替代计划或重发消息。" } : {}) } });
const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
function feedbackPlanId(value: unknown): string {
  try { return canonicalLogicalPlanId(value); }
  catch (error) {
    throw new RoleStorageApplicationError(error instanceof Error ? error.message : String(error), "invalid_request", 400, undefined, "not_started");
  }
}

/** HTTP composition only; native application owns CAS, operation identity, ledger, queue and projections. */
export class PersonaStorageOwner {
  private readonly nativeClosures = new Set<Promise<void>>();
  private stopped = false;
  private readonly pools: NonNullable<PersonaStorageOperationsContext["pools"]>;

  constructor(private readonly context: PersonaStorageOperationsContext) {
    // Interactive full catalogs/history share the bounded foreground lane, not background diagnostics.
    this.pools = context.pools ?? { knowledge: managerKnowledgePageWorkerPool, catalog: managerKnowledgePageWorkerPool, read: managerReadWorkerPool };
  }

  capture(input: Omit<ApiOperationInput, "body">, spec: Spec): Admission {
    if (this.stopped) throw new RoleStorageApplicationError("Persona storage API is retiring.", "busy", 503);
    const assertConnection = preparePersonaResourceAdmission(input.request, input.signal, this.context.identity);
    const roleId = spec.action === "plan-history" || spec.action.startsWith("feedback-") ? sanitizeRoleId(input.path.roleId) : input.path.roleId;
    if (!roleId) invalid("Missing role id.");
    const roleDir = this.context.roleDirectory(roleId), realDirectory = directoryIdentity(roleDir), application = this.context.application();
    const admission: Admission = { roleId, roleDir, application, command: {}, assertCurrent: () => {} };
    admission.assertCurrent = () => {
      try {
        assertConnection();
        if (this.context.application() !== application || this.context.roleDirectory(roleId) !== roleDir || directoryIdentity(roleDir) !== realDirectory) {
          throw new RoleStorageApplicationError("Original persona storage owner or directory changed; inspect the original operation.", "generation_mismatch", 409);
        }
      } catch (error) {
        if (admission.committedId) {
          throw new RoleStorageApplicationError("The write committed but its original owner can no longer disclose the result. Read the original operation receipt.", (error as { statusCode?: number }).statusCode === 403 ? "authorization_revoked" : "generation_mismatch", (error as { statusCode?: number }).statusCode === 403 ? 403 : 409, admission.committedId, "committed");
        }
        throw error;
      }
    };
    admission.command = Object.freeze({ signal: input.signal, idempotencyKey: singleHeader(input.request, "idempotency-key"), expectedRevision: singleHeader(input.request, "if-match") ?? singleHeader(input.request, "x-rabiroute-expected-revision"), authorize: admission.assertCurrent });
    admission.assertCurrent();
    return admission;
  }

  private native<T>(run: () => Promise<T>): Promise<T> {
    const work = (this.context.captureNativeWork ?? captureNativeStorageWork)(run);
    const closed = work.closed.finally(() => this.nativeClosures.delete(closed));
    this.nativeClosures.add(closed);
    void closed.catch(() => {});
    return work.result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const failures = await Promise.allSettled([...this.nativeClosures]);
    const failure = failures.find(value => value.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  error(spec: Spec, error: unknown): ApiOperationResult {
    if (error instanceof RoleStorageApplicationError) {
      const mapped = roleStorageHttpError(error);
      return { status: mapped.statusCode, headers: mapped.headers, body: mapped.body, mutationOutcome: error.commitState === "not_started" ? "not_started" : "unknown" };
    }
    if (spec.failure === "page" && error instanceof PlanPageCatalogInitializingError) return { status: 503, headers: { "retry-after": "2" }, body: { code: -1, reason: error.reason, message: error.message } };
    const status = (error as { statusCode?: number })?.statusCode ?? (spec.failure ? error instanceof ManagerReadWorkerError && (spec.failure === "page" || error.code === "busy") ? 503 : 500 : 500);
    return { status, body: { code: -1, message: error instanceof Error ? error.message : String(error) } };
  }

  async execute(spec: Spec, input: ApiOperationInput, admission: Admission): Promise<ApiOperationResult> {
    admission.assertCurrent();
    return this.native(async () => {
      try {
        const result = await this.executeNative(spec, input, admission);
        admission.assertCurrent();
        return result;
      } catch (error) {
        try { admission.assertCurrent(); }
        catch (fence) {
          if (error instanceof RoleStorageApplicationError && error.commitState !== "not_started") {
            const status = (fence as { statusCode?: number }).statusCode;
            throw new RoleStorageApplicationError("The original operation can no longer disclose a result. Read its resource and receipt before retrying.", status === 403 ? "authorization_revoked" : "generation_mismatch", status === 403 ? 403 : status === 409 ? 409 : error.statusCode, error.operationId, error.commitState, error.causeCode);
          }
          throw fence;
        }
        throw error;
      }
    });
  }

  private commit(admission: Admission, status: number, receipt: { operationId: string }, data: unknown, revision?: string | null): ApiOperationResult {
    admission.committedId = receipt.operationId;
    admission.assertCurrent();
    return { status, headers: { "idempotency-key": receipt.operationId, ...(revision ? { etag: `"${revision}"` } : {}) }, body: { code: 0, data } };
  }

  private async executeNative(spec: Spec, input: ApiOperationInput, a: Admission): Promise<ApiOperationResult> {
    const { roleId, roleDir, application, command } = a, { searchParams: query } = input.url;
    const body = input.body as Record<string, unknown>, readOptions = { signal: input.signal };
    const planId = input.path.planId, memoryId = input.path.memoryId, runId = input.path.runId, statusKey = input.path.statusKey;
    switch (spec.action) {
      case "counts": return ok(await this.pools.knowledge.queryRoleFileCounts(roleDir, readOptions));
      case "plan-history": {
        const data = await this.pools.catalog.run<{ plan: PlanItem; records: unknown[] } | null>({ type: "role_plan_history", roleDir, planId }, readOptions);
        return data ? ok({ count: data.records.length, records: data.records }) : missing(`Plan not found: ${planId}`, roleId);
      }
      case "plan-query": {
        let parsed; try { parsed = parseWorkspacePlanQuery(body); } catch (error) { invalid(error instanceof Error ? error.message : String(error)); }
        return ok(await this.pools.knowledge.queryRolePlanPage(roleDir, parsed!, { ...readOptions, readyOnly: true }));
      }
      case "plan-list": {
        const view = query.get("view")?.trim() || undefined, sort = query.get("sort")?.trim() || "status";
        if (view && !["current", "plans", "archived"].includes(view)) invalid("Invalid plan page view.");
        if (!["status", "updated", "importance", "urgency"].includes(sort)) invalid("Invalid plan page sort.");
        if (query.has("limit")) return ok(await this.pools.knowledge.queryRolePlanPage(roleDir, {
          cursor: query.get("cursor")?.trim() || "", limit: normalizeRolePlanPageLimit(query.get("limit")), view: view as "current" | "plans" | "archived" | undefined,
          query: query.get("query") || "", sort: sort as "status" | "updated" | "importance" | "urgency", statuses: query.getAll("status").map(value => value.trim()).filter(Boolean), tags: query.getAll("tag").map(value => value.trim()).filter(Boolean), includeFacets: query.get("facets") !== "0", summary: query.get("detail") === "summary"
        }, { ...readOptions, readyOnly: true }));
        const data = await this.pools.catalog.queryRolePlanCatalog(roleDir, readOptions); a.assertCurrent();
        return ok(presentPlans(data.plans, ensurePersonaPlanWorkflow(roleDir).workflow).map(plan => ({ ...plan, approval: data.approvalByPlanId[plan.id] })));
      }
      case "plan-read": {
        const [projection, workflow] = await Promise.all([application.queries.plan(roleId, planId, readOptions), readPersonaPlanWorkflowAsync(roleDir)]); a.assertCurrent();
        if (!projection) return missing(`Plan not found: ${planId}`, roleId);
        if (!workflow) throw new Error("Persona plan workflow is not initialized.");
        const viewRevision = createHash("sha256").update(JSON.stringify([projection.revision, projection.approval, workflow.workflow])).digest("hex"), headers = { etag: `"${projection.revision}"`, "x-plan-view-revision": viewRevision };
        if (input.request.headers["if-plan-view-revision"] === viewRevision) return { status: 304, headers };
        const presented = presentPlan(projection.plan, workflow.workflow);
        return ok({ ...(query.get("detail")?.trim() === "preview" ? previewRolePlan(presented) : presented), approval: projection.approval }, headers);
      }
      case "plan-create":
      case "plan-update": {
        const actor = await this.context.planHistoryContext(input.request, body, command); a.assertCurrent();
        const { messageSource: _source, actor: _actor, ...value } = body;
        const receipt = spec.action === "plan-create" ? await application.commands.createPlan(roleId, value, { ...actor, authorize: a.assertCurrent }) : await application.commands.updatePlan(roleId, planId, value, { ...actor, authorize: a.assertCurrent });
        a.committedId = receipt.operationId; a.assertCurrent();
        return this.commit(a, spec.action === "plan-create" ? 201 : 200, receipt, { ...presentPlan(receipt.projection.plan, ensurePersonaPlanWorkflow(roleDir).workflow), approval: receipt.projection.approval }, receipt.projection.revision);
      }
      case "workflow-read": {
        const data = await application.queries.planWorkflow(roleId, readOptions);
        return data ? ok({ ...data.workflow, activationStatuses: PLAN_ACTIVATION_STATUSES, markerStatuses: data.workflow.statuses, revision: data.revision }, { etag: `"${data.revision}"` }) : missing(`Plan status catalog not found for role: ${roleId}`);
      }
      case "workflow-create":
      case "workflow-update":
      case "workflow-delete": {
        const receipt = spec.action === "workflow-create" ? await application.commands.createPlanStatus(roleId, body, command) : spec.action === "workflow-update" ? await application.commands.updatePlanStatus(roleId, statusKey, body, command) : await application.commands.deletePlanStatus(roleId, statusKey, typeof body.replacementKey === "string" ? body.replacementKey : "", command);
        a.committedId = receipt.operationId; a.assertCurrent();
        this.context.publish("plan_status_catalog_changed", { roleId, statusKey: receipt.commit.status.key, action: spec.action === "workflow-create" ? "created" : spec.action === "workflow-update" ? "updated" : "retired", ...(spec.action === "workflow-delete" ? { migratedPlanIds: receipt.commit.migratedPlanIds } : {}) });
        return this.commit(a, spec.action === "workflow-create" ? 201 : 200, receipt, receipt.commit, receipt.projection.revision);
      }
      case "feedback-read": {
        const id = feedbackPlanId(planId), data = await application.queries.planFeedback(roleId, id, readOptions);
        return data ? ok({ count: data.records.length, latest: data.records[0], records: data.records }, { etag: `"${data.planRevision}"` }) : missing(`Plan not found: ${id}`);
      }
      case "feedback-submit": {
        const id = feedbackPlanId(planId), actor = await this.context.planHistoryContext(input.request, { messageSource: body.source === "webgui" && body.author !== "agent" ? { type: "user" } : undefined }, command); a.assertCurrent();
        const value = Object.fromEntries(feedbackFields.map(key => [key, body[key]])) as Parameters<RoleStorageApplication["commands"]["submitPlanFeedback"]>[2];
        const receipt = await application.commands.submitPlanFeedback(roleId, id, value, { ...actor, authorize: a.assertCurrent });
        a.committedId = receipt.operationId; a.assertCurrent();
        const { record, created, plan } = receipt.commit;
        try {
          withoutNativeStorageWork(() => this.context.scheduleFeedbackPostCommit(roleDir, roleId, String(body.gatewayId || record.gatewayId || "").trim(), plan, record, application));
          if (created) this.context.publish("plan_feedback_changed", { roleId, planId: id, feedbackId: record.id });
        } catch (error) { this.context.reportFeedbackScheduleError(roleId, id, record.id, error); }
        return this.commit(a, 202, receipt, record, receipt.projection.planRevision);
      }
      case "memory-overview": {
        if (query.get("counts") === "1") return ok(await this.pools.knowledge.queryRoleMemoryCounts(roleDir, readOptions));
        if (query.has("limit")) {
          const kind = query.get("kind")?.trim() || "recent";
          if (kind !== "recent" && kind !== "consolidated" && kind !== "archived") invalid("Invalid memory page kind.");
          return ok(await this.pools.knowledge.queryRoleMemoryPage(roleDir, { kind: kind as "recent" | "consolidated" | "archived", cursor: query.get("cursor")?.trim() || "", limit: normalizeRoleMemoryPageLimit(query.get("limit")), query: query.get("query") || "" }, readOptions));
        }
        return ok(await this.pools.knowledge.queryRoleMemoryOverview(roleDir, readOptions));
      }
      case "recent-list": return ok(await this.pools.read.queryRoleMemoryCatalog(roleDir, "recent", "", readOptions));
      case "consolidated-list": return ok(await this.pools.read.queryRoleMemoryCatalog(roleDir, "consolidated", "", readOptions));
      case "consolidated-read": {
        const memory = await this.pools.read.queryRoleMemoryCatalog(roleDir, "consolidated", memoryId, readOptions);
        return memory ? ok(memory) : missing(`Consolidated memory not found: ${memoryId}`);
      }
      case "recent-read": {
        if (this.context.readOnly()) {
          try { const memory = await this.pools.read.queryRecentMemoryDetail(roleDir, memoryId, readOptions); return memory ? ok(memory) : missing(`Memory not found: ${memoryId}`); }
          catch (error) { return this.error({ ...spec, failure: "worker" }, error); }
        }
        const receipt = await application.commands.touchRecentMemory(roleId, memoryId, command);
        return this.commit(a, 200, receipt, receipt.projection.memory, receipt.projection.revision);
      }
      case "recent-create":
      case "recent-update": {
        const receipt = spec.action === "recent-create" ? await application.commands.createRecentMemory(roleId, body, command) : await application.commands.updateRecentMemory(roleId, memoryId, body, command);
        a.committedId = receipt.operationId; a.assertCurrent(); this.context.rescheduleMemory();
        return this.commit(a, spec.action === "recent-create" ? 201 : 200, receipt, receipt.projection.memory, receipt.projection.revision);
      }
      case "runs-list": return ok(await this.pools.catalog.run({ type: "role_consolidation_runs", roleDir }, readOptions));
      case "runs-read": {
        const data = await application.queries.consolidationRun(roleId, runId, readOptions);
        return data ? ok(data.run, { etag: `"${data.revision}"` }) : missing(`Consolidation run not found: ${runId}`);
      }
      case "consolidation-request": {
        const receipt = await application.commands.requestMemoryConsolidation(roleId, { triggerSource: body.triggerSource === "auto" ? "auto" : "api", includeOlderThanHours: typeof body.includeOlderThanHours === "number" ? body.includeOlderThanHours : undefined, triggerOlderThanHours: typeof body.triggerOlderThanHours === "number" ? body.triggerOlderThanHours : undefined, force: body.force === true }, command);
        return this.commit(a, 201, receipt, receipt.commit, receipt.projection?.revision);
      }
      case "consolidation-result": {
        const receipt = await application.commands.applyMemoryConsolidation(roleId, runId, body, command);
        a.committedId = receipt.operationId; a.assertCurrent();
        this.context.noteMemoryRunCompleted(runId); this.context.rescheduleMemory(); this.context.publish("memory_consolidation_changed", { roleId, runId, status: "completed" });
        return this.commit(a, 200, receipt, receipt.commit, receipt.projection?.revision);
      }
      default: throw new Error("Unknown native persona storage operation.");
    }
  }
}

const ignored = { type: "object" };
function querySchema(spec: Spec): Record<string, unknown> {
  const fields = spec.action === "plan-list" ? ["limit", "cursor", "view", "query", "sort", "status", "tag", "facets", "detail"] : spec.action === "plan-read" ? ["detail"] : spec.action === "memory-overview" ? ["counts", "limit", "kind", "cursor", "query"] : [];
  return { type: "object", properties: Object.fromEntries(fields.map(field => [field, { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: field === "status" || field === "tag" ? "Repeatable native filter; preserve all values in order." : "Native query value; preserve first-value, empty-value and coercion behavior." }])) };
}
const jsonResponse: ApiResponseContract = { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code"], properties: { code: { enum: [0, -1] }, data: true, message: { type: "string" }, state: { type: "string" }, reason: { type: "string" }, commitState: { enum: ["not_started", "unknown", "committed"] }, nextAction: { type: "string" } } } };

/** All native API and non-API aliases are exact executable definitions, never prefix handlers. */
export function createPersonaStorageOperations(owner: PersonaStorageOwner): readonly ApiOperationDefinition[] {
  return specs.flatMap(spec => ["/api/roles", "/roles"].map((prefix): ApiOperationDefinition => {
    const pathTemplate = prefix + "/:roleId/" + spec.suffix, keys = [...pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
    const contract: ApiOperationContract = {
      operationId: "manager.personas.storage." + spec.id + (prefix === "/roles" ? ".legacy-path" : ""), aliases: ["persona:" + spec.method + ":" + pathTemplate], contractVersion: "1.0.0", method: spec.method, pathTemplate, exposure: "public", transport: "http",
      description: "Invoke the original persona storage owner for " + spec.id + ". Native application, role directory, projections and worker lifecycle stay bound to the admitting request.",
      request: { path: { type: "object", required: keys, additionalProperties: false, properties: Object.fromEntries(keys.map(key => [key, { type: "string", minLength: 1 }])) }, query: querySchema(spec), headers: { ...ignored, properties: { "idempotency-key": true, "if-match": true, "x-rabiroute-expected-revision": true, ...(spec.action === "plan-read" ? { "if-plan-view-revision": true } : {}) } },
        body: spec.fields ? { kind: "json", schema: spec.action === "consolidation-result" ? { anyOf: [{ type: "object", properties: Object.fromEntries(spec.fields.map(field => [field, true])) }, { type: "array", items: true }] } : { type: "object", properties: Object.fromEntries(spec.fields.map(field => [field, true])) }, maxBytes: spec.maxBytes ?? 0, emptyValue: {}, allowAnyContentType: true } : { kind: "none", allowIgnoredBody: true } },
      responses: { "200": jsonResponse, default: jsonResponse },
      effects: { mode: spec.mutates ? spec.action === "recent-read" ? "native-recent-memory-touch-unless-read-only" : "native-role-storage-command" : "native-role-storage-read", description: "RoleStorageApplication retains operation IDs, strong ETag CAS, idempotency ledger, mutation queue, audits and projection publication. Feedback post-commit work and consolidation scheduling remain with their original owners; acceptance does not prove delivery or Agent execution. Recent memory detail GET touches viewedAt unless Manager is read-only." },
      recovery: { strategy: spec.mutates ? "native-receipt-and-readback" : "repeat-native-read", idempotencyHeader: "Idempotency-Key", description: "Capture current application, role directory, original connection and Manager generation before body decoding; recheck after awaited work, before writes and disclosure. Preserve If-Match or x-rabiroute-expected-revision and original native status/receipt headers. On uncertainty inspect the original resource and receipt; only replay the identical payload with the same key. HTTP timeout is not worker release." },
      validators: [{ id: "native-storage-business-owner", description: "Normal JSON is decoded once by the registry; native commands retain plan/workflow/memory/feedback schemas, actor resolution, source checks, immutable keys and CAS. Authenticated remote connections require no per-role or per-feature grant. Both /api/roles and /roles aliases retain their original behavior, including ignored counts item IDs." }, { id: "native-storage-resource-lifetime", description: "Join original worker release and quarantine cleanup independently of HTTP result/deadline; never replace the storage application, worker pool or feedback queue. New requests capture the current owner; in-flight requests never switch owners." }]
    };
    const bind = (input: Omit<ApiOperationInput, "body">) => {
      try {
        const admission = owner.capture(input, spec);
        return async (parsed: ApiOperationInput) => {
          try { return await owner.execute(spec, parsed, admission); }
          catch (error) { return owner.error(spec.action === "plan-list" && !parsed.url.searchParams.has("limit") ? { ...spec, failure: "worker" } : spec, error); }
        };
      } catch (error) { return owner.error(spec, error); }
    };
    return { contract, prepare: bind, handler: async input => { const bound = bind(input); return typeof bound === "function" ? bound(input) : bound; } };
  }));
}
