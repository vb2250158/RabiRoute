import path from "node:path";
import type {
  PlanFeedbackDeliveryStatus,
  PlanFeedbackPostCommit,
  PlanFeedbackRecord,
  PlanQaFeedbackHandling
} from "../planFeedback.js";
import type { SubmitPlanFeedbackInput } from "../planFeedbackSubmission.js";
import type {
  CreateMemoryConsolidationRequestOptions,
  PlanTaskBinding,
  PlanSecretaryBinding
} from "../roleKnowledge.js";
import { canonicalLogicalPlanId } from "../planStorageIdentity.js";
import type { RolePanelTimelineMessage } from "../rolePanelTimeline.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { storageRevisionToken } from "../shared/storageRevision.js";

export const MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION = 1 as const;

/**
 * Durable mutation receipt ledger contract.
 *
 * `requestId` is the stable upstream idempotency key. The storage child is the
 * only writer and both replacement children and explicit recovery tooling are
 * consumers. Receipts live below
 * `<roleDir>/runtime/data/storage-mutation-idempotency/`, are addressed by the
 * direct hash lookup implemented by durableDeliveryIdempotency, and MUST NOT be
 * enumerated during ordinary startup. `completed` and `uncertain` receipts are
 * durable audit/idempotency truth, not cache; deletion requires a separately
 * authorized retention operation.
 */
export const MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE = "storage-mutation-idempotency" as const;

export const storageMutationRevisionToken = storageRevisionToken;

export type ManagerStorageMutationFence = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
  storageGenerationLease: string;
  roleId: string;
  planId?: string;
}>;

export type ManagerStorageMutationTask =
  | Readonly<{
      type: "plan_create";
      input: Record<string, unknown>;
    }>
  | Readonly<{
      type: "plan_update";
      patch: Record<string, unknown>;
    }>
  | Readonly<{
      type: "plan_secretary_binding_update";
      binding: PlanSecretaryBinding | null;
    }>
  | Readonly<{
      type: "plan_task_binding_update";
      binding: PlanTaskBinding | null;
    }>
  | Readonly<{
      type: "recent_memory_create";
      input: Record<string, unknown>;
    }>
  | Readonly<{
      type: "recent_memory_update";
      memoryId: string;
      patch: Record<string, unknown>;
    }>
  | Readonly<{
      type: "recent_memory_touch";
      memoryId: string;
    }>
  | Readonly<{
      type: "memory_consolidation_request";
      options: CreateMemoryConsolidationRequestOptions;
    }>
  | Readonly<{
      type: "memory_consolidation_mark_delivered";
      runId: string;
      deliveredAt?: string;
    }>
  | Readonly<{
      type: "memory_consolidation_apply";
      runId: string;
      body: Record<string, unknown>;
    }>
  | Readonly<{
      type: "plan_feedback_submit";
      input: Omit<SubmitPlanFeedbackInput, "roleDir" | "roleId" | "planId" | "expectedRevision">;
    }>
  | Readonly<{
      type: "plan_feedback_delivery_update";
      record: PlanFeedbackRecord;
      deliveryStatus: Exclude<PlanFeedbackDeliveryStatus, "record_only">;
      deliveryMessage?: string;
    }>
  | Readonly<{
      type: "plan_feedback_qa_update";
      record: PlanFeedbackRecord;
      qaHandling: PlanQaFeedbackHandling;
    }>
  | Readonly<{
      type: "plan_feedback_post_commit_update";
      record: PlanFeedbackRecord;
      status: PlanFeedbackPostCommit["status"];
      message?: string;
    }>
  | Readonly<{
      type: "role_panel_timeline_append";
      message: RolePanelTimelineMessage;
    }>;

export type ManagerStorageMutationRequest = Readonly<{
  protocolVersion: typeof MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION;
  requestId: string;
  fence: ManagerStorageMutationFence;
  expectedRevision: string | null;
  task: ManagerStorageMutationTask;
}>;

export type ManagerStorageMutationResponse = Readonly<{
  protocolVersion: typeof MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION;
  requestId: string;
  fence: ManagerStorageMutationFence;
}> & (
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; message: string; stack?: string }>
);

export type ManagerStorageMutationChildIdentity = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
  storageGenerationLease: string;
  rolesRoot: string;
}>;

export function canonicalStorageMutationRoleId(value: unknown): string {
  const text = String(value ?? "").trim();
  const roleId = sanitizeRoleId(text);
  if (!roleId || roleId !== text) throw new Error(`Storage mutation roleId is invalid: ${text || "<empty>"}`);
  return roleId;
}

export function storageMutationRoleDirectory(rolesRoot: string, roleIdValue: unknown): string {
  const root = path.resolve(String(rolesRoot || ""));
  const roleId = canonicalStorageMutationRoleId(roleIdValue);
  const roleDir = path.resolve(root, roleId);
  const relative = path.relative(root, roleDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Storage mutation role directory is outside rolesRoot: ${roleId}`);
  }
  return roleDir;
}

export function canonicalStorageMutationPlanId(value: unknown): string {
  return canonicalLogicalPlanId(value);
}

export function taskRequiresPlanFence(task: ManagerStorageMutationTask): boolean {
  return task.type === "plan_create"
    || task.type === "plan_update"
    || task.type === "plan_secretary_binding_update"
    || task.type === "plan_task_binding_update"
    || task.type === "plan_feedback_submit"
    || task.type === "plan_feedback_delivery_update"
    || task.type === "plan_feedback_qa_update"
    || task.type === "plan_feedback_post_commit_update";
}

export function validateManagerStorageMutationRequest(
  request: ManagerStorageMutationRequest,
  identity: ManagerStorageMutationChildIdentity
): ManagerStorageMutationRequest {
  if (request?.protocolVersion !== MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION) {
    throw new Error("Storage mutation protocol version is invalid.");
  }
  if (!/^[A-Za-z0-9:._-]{1,256}$/.test(String(request.requestId || ""))) {
    throw new Error("Storage mutation requestId is invalid.");
  }
  if (request.fence?.applicationGenerationId !== identity.applicationGenerationId
    || request.fence?.managerInstanceId !== identity.managerInstanceId
    || request.fence?.storageGenerationLease !== identity.storageGenerationLease) {
    throw new Error("Storage mutation generation fence does not match the child identity.");
  }
  const roleId = canonicalStorageMutationRoleId(request.fence.roleId);
  storageMutationRoleDirectory(identity.rolesRoot, roleId);
  if (request.expectedRevision !== null
    && (typeof request.expectedRevision !== "string"
      || !request.expectedRevision.trim()
      || request.expectedRevision.length > 256)) {
    throw new Error("Storage mutation expectedRevision is invalid.");
  }
  const requiresPlan = taskRequiresPlanFence(request.task);
  const planId = request.fence.planId == null
    ? undefined
    : canonicalStorageMutationPlanId(request.fence.planId);
  if (requiresPlan && !planId) throw new Error(`Storage mutation ${request.task.type} requires a plan fence.`);
  if (!requiresPlan && planId) throw new Error(`Storage mutation ${request.task.type} must not carry a plan fence.`);
  if (request.task.type === "plan_create" && canonicalStorageMutationPlanId(request.task.input.id) !== planId) {
    throw new Error("Plan creation input id does not match its plan fence.");
  }
  const task = request.task;
  if (task.type === "recent_memory_touch") {
    if (!String(task.memoryId || "").trim() || String(task.memoryId).length > 256) {
      throw new Error("Recent-memory touch memoryId is invalid.");
    }
    if (request.expectedRevision === null) {
      throw new Error("Recent-memory touch requires an exact expectedRevision.");
    }
  }
  if (task.type === "role_panel_timeline_append") {
    if (request.expectedRevision !== null) {
      throw new Error("Role panel timeline append expectedRevision must be null.");
    }
    if (task.message.roleId !== roleId) {
      throw new Error("Role panel timeline message identity does not match its role fence.");
    }
    if (!String(task.message.id || "").trim() || String(task.message.id).length > 256) {
      throw new Error("Role panel timeline messageId is invalid.");
    }
  }
  if (task.type === "plan_feedback_delivery_update"
    || task.type === "plan_feedback_qa_update"
    || task.type === "plan_feedback_post_commit_update") {
    if (task.record.roleId !== roleId || canonicalStorageMutationPlanId(task.record.planId) !== planId) {
      throw new Error("Plan feedback record identity does not match its role/plan fence.");
    }
  }
  return request;
}

export function sameManagerStorageMutationFence(
  left: ManagerStorageMutationFence,
  right: ManagerStorageMutationFence
): boolean {
  return left.applicationGenerationId === right.applicationGenerationId
    && left.managerInstanceId === right.managerInstanceId
    && left.storageGenerationLease === right.storageGenerationLease
    && left.roleId === right.roleId
    && left.planId === right.planId;
}
