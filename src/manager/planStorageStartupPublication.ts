import path from "node:path";
import { invalidatePlanReads } from "../planReadInvalidation.js";
import { publishRolePlanPackageRecoverySnapshot, publishedRolePlanPackageRecoverySnapshot } from "../roleKnowledge.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

/** Add proven startup conflicts before cached readers or background work can use the plan. */
export function publishStartupPlanConflicts(rolesRoot: string, summary?: PlanStorageStartupGateSummary): void {
  const byRole = new Map<string, NonNullable<PlanStorageStartupGateSummary["packageConflicts"]>>();
  for (const conflict of summary?.packageConflicts ?? []) {
    const values = byRole.get(conflict.roleId) ?? [];
    values.push(conflict);
    byRole.set(conflict.roleId, values);
  }
  for (const [roleId, conflicts] of byRole) {
    const roleDir = path.join(rolesRoot, roleId);
    const previous = publishedRolePlanPackageRecoverySnapshot(roleDir) ?? { conflicts: [], unknown: [] };
    const merged = new Map(previous.conflicts.map(item => [item.transactionPath, item]));
    for (const { planId, transactionPath, message } of conflicts) merged.set(transactionPath, { planId, transactionPath, message });
    const next = { conflicts: [...merged.values()].sort((a, b) => a.transactionPath.localeCompare(b.transactionPath)), unknown: previous.unknown };
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    publishRolePlanPackageRecoverySnapshot(roleDir, next);
    invalidatePlanReads(roleDir);
  }
  // Progress and empty summaries cannot prove repair; only a fresh storage capture clears a fence.
}
