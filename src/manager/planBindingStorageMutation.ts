import type { PlanItem, PlanSecretaryBinding, PlanTaskBinding } from "../roleKnowledge.js";
import type { CodexPlanAssistantSession } from "../shared/codexPlanAssistantSessions.js";
import { replacementPlanTaskBinding, type ResolvedPlanTask } from "./planTaskBindingDelivery.js";
import { resolvePlanSecretaryAssignment, type PlanSecretaryTarget } from "./planSecretaryAssignment.js";
import {
  RoleStorageApplicationError,
  roleStorageOperationKey,
  type RoleStorageApplication,
  type RoleStoragePlanProjection
} from "./roleStorageApplication.js";

type PlanBindingStorage = Pick<RoleStorageApplication, "queries" | "commands">;

const QUERY_TIMEOUT_MS = 30_000;
const MAX_CAS_ATTEMPTS = 3;

function bindingJson(value: PlanTaskBinding | PlanSecretaryBinding | null | undefined): string {
  return JSON.stringify(value ?? null);
}

function sameBinding(
  left: PlanTaskBinding | PlanSecretaryBinding | null | undefined,
  right: PlanTaskBinding | PlanSecretaryBinding | null | undefined
): boolean {
  return bindingJson(left) === bindingJson(right);
}

async function exactPlan(
  storage: PlanBindingStorage,
  roleId: string,
  planId: string
): Promise<RoleStoragePlanProjection> {
  const projection = await storage.queries.plan(roleId, planId, { timeoutMs: QUERY_TIMEOUT_MS });
  if (!projection) throw new Error(`Role plan was not found: ${planId}`);
  return projection;
}

function shouldReplaySameOperation(error: unknown): boolean {
  return error instanceof RoleStorageApplicationError
    && (error.code === "indeterminate"
      || error.code === "projection_unavailable"
      || error.commitState === "unknown"
      || error.commitState === "committed");
}

async function replayLostResponse<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!shouldReplaySameOperation(error)) throw error;
    return await operation();
  }
}

export async function replacePlanTaskBindingForDelivery(
  storage: PlanBindingStorage,
  input: Readonly<{
    roleId: string;
    planId: string;
    deliveryId: string;
    oldSessionId: string;
    resolved: ResolvedPlanTask;
  }>
): Promise<PlanItem> {
  const operationKey = roleStorageOperationKey(
    "plan-task-binding-replace",
    input.deliveryId,
    input.oldSessionId,
    input.resolved.id,
    input.planId
  );
  let desiredBinding: PlanTaskBinding | null = null;
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const projection = await exactPlan(storage, input.roleId, input.planId);
    const currentSessionId = String(projection.plan.taskBinding?.sessionId || "");
    if (currentSessionId === input.resolved.id) return projection.plan;
    if (currentSessionId !== input.oldSessionId) return projection.plan;
    desiredBinding ??= replacementPlanTaskBinding(projection.plan, input.resolved);
    if (!desiredBinding) return projection.plan;
    try {
      const committed = await replayLostResponse(() => storage.commands.updatePlanTaskBinding(
        input.roleId,
        input.planId,
        desiredBinding,
        {
          idempotencyKey: operationKey,
          expectedRevision: projection.revision,
          timeoutMs: QUERY_TIMEOUT_MS
        }
      ));
      return committed.projection.plan;
    } catch (error) {
      if (!(error instanceof RoleStorageApplicationError) || error.code !== "revision_conflict") throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
}

export async function ensurePlanSecretaryBindingForEvent(
  storage: PlanBindingStorage,
  input: Readonly<{
    roleId: string;
    planId: string;
    eventId: string;
    sessions: readonly CodexPlanAssistantSession[] | undefined;
  }>
): Promise<{ plan: PlanItem; target?: PlanSecretaryTarget }> {
  let desiredBinding: PlanSecretaryBinding | null = null;
  let target: PlanSecretaryTarget | undefined;
  let oldSessionId = "unassigned";
  let operationKey = "";
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const projection = await exactPlan(storage, input.roleId, input.planId);
    if (!target) {
      const assignment = resolvePlanSecretaryAssignment(projection.plan, input.sessions);
      if (!assignment) return { plan: projection.plan };
      target = assignment.target;
      if (!assignment.changed) return { plan: projection.plan, target };
      oldSessionId = String(projection.plan.secretaryBinding?.sessionId || "unassigned");
      desiredBinding = { ...assignment.binding };
      if (!projection.plan.secretaryBinding?.assignedAt) delete desiredBinding.assignedAt;
      operationKey = roleStorageOperationKey(
        "plan-secretary-assignment",
        input.eventId,
        oldSessionId,
        target.threadId,
        input.planId
      );
    }
    if (sameBinding(projection.plan.secretaryBinding, desiredBinding)
      || projection.plan.secretaryBinding?.sessionId === target.threadId) {
      return { plan: projection.plan, target };
    }
    if (String(projection.plan.secretaryBinding?.sessionId || "unassigned") !== oldSessionId) {
      const current = resolvePlanSecretaryAssignment(projection.plan, input.sessions);
      return { plan: projection.plan, target: current?.target };
    }
    try {
      const committed = await replayLostResponse(() => storage.commands.updatePlanSecretaryBinding(
        input.roleId,
        input.planId,
        desiredBinding,
        {
          idempotencyKey: operationKey,
          expectedRevision: projection.revision,
          timeoutMs: QUERY_TIMEOUT_MS
        }
      ));
      return { plan: committed.projection.plan, target };
    } catch (error) {
      if (!(error instanceof RoleStorageApplicationError) || error.code !== "revision_conflict") throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
}

export async function replacePlanSecretaryBindingForEvent(
  storage: PlanBindingStorage,
  input: Readonly<{
    roleId: string;
    planId: string;
    eventId: string;
    oldSessionId: string;
    binding: PlanSecretaryBinding;
  }>
): Promise<PlanItem> {
  const operationKey = roleStorageOperationKey(
    "plan-secretary-resolution",
    input.eventId,
    input.oldSessionId,
    input.binding.sessionId,
    input.planId
  );
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const projection = await exactPlan(storage, input.roleId, input.planId);
    if (sameBinding(projection.plan.secretaryBinding, input.binding)
      || projection.plan.secretaryBinding?.sessionId === input.binding.sessionId) return projection.plan;
    if (projection.plan.secretaryBinding?.sessionId !== input.oldSessionId) return projection.plan;
    try {
      const committed = await replayLostResponse(() => storage.commands.updatePlanSecretaryBinding(
        input.roleId,
        input.planId,
        input.binding,
        {
          idempotencyKey: operationKey,
          expectedRevision: projection.revision,
          timeoutMs: QUERY_TIMEOUT_MS
        }
      ));
      return committed.projection.plan;
    } catch (error) {
      if (!(error instanceof RoleStorageApplicationError) || error.code !== "revision_conflict") throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
}
