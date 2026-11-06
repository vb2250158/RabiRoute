import type { PlanStorageStartupLifecycleSnapshot } from "./planStorageStartupLifecycle.js";

export function publicPlanStorageStartupSnapshot(snapshot: PlanStorageStartupLifecycleSnapshot): Record<string, unknown> {
  return Object.freeze({
    state: snapshot.state,
    attempt: snapshot.attempt,
    incidents: snapshot.incidents,
    lastTransitionAt: snapshot.lastTransitionAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    deadlineAt: snapshot.deadlineAt,
    nextRetryAt: snapshot.nextRetryAt,
    lastErrorCode: snapshot.lastError ? "PLAN_STORAGE_STARTUP_ATTEMPT_FAILED" : undefined,
    summary: snapshot.summary ? Object.freeze({
      roles: snapshot.summary.roles,
      migrated: snapshot.summary.migrated,
      reconciled: snapshot.summary.reconciled,
      failureCount: snapshot.summary.failures.length,
      ...(snapshot.summary.packageConflicts?.length ? { packageConflictCount: snapshot.summary.packageConflicts.length } : {}),
      skipped: snapshot.summary.skipped,
      readyRoles: snapshot.summary.readyRoleIds?.length ?? 0
    }) : undefined
  });
}
