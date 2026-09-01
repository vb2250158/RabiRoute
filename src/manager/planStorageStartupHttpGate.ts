import type { PlanStorageStartupLifecycleSnapshot } from "./planStorageStartupLifecycle.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
      skipped: snapshot.summary.skipped
    }) : undefined
  });
}

export function isPlanStorageMutationRequest(method: string | undefined, pathname: string): boolean {
  const normalizedMethod = String(method || "").toUpperCase();
  if (READ_METHODS.has(normalizedMethod)) return false;
  if (/^\/(?:api\/)?roles\/[^/]+\/plans(?:\/|$)/.test(pathname)) return true;
  if (normalizedMethod === "POST" && /^\/api\/roles\/[^/]+\/plan-agents\/[^/]+\/open$/.test(pathname)) return true;
  if (normalizedMethod !== "POST") return false;
  return new Set([
    "/api/persona-sync/sync",
    "/api/persona-sync/conflicts/resolve",
    "/api/persona-sync/plan-packages/active",
    "/api/persona-sync/plan-packages/archive"
  ]).has(pathname);
}

export function planStorageStartupUnavailable(
  method: string | undefined,
  pathname: string,
  snapshot: PlanStorageStartupLifecycleSnapshot | undefined
): Readonly<{ statusCode: 503; retryAfterSeconds: number; body: Record<string, unknown> }> | null {
  if (!isPlanStorageMutationRequest(method, pathname) || snapshot?.state === "ready") return null;
  const retryAfterSeconds = snapshot?.nextRetryAt
    ? Math.max(1, Math.ceil((Date.parse(snapshot.nextRetryAt) - Date.now()) / 1_000))
    : 1;
  return Object.freeze({
    statusCode: 503,
    retryAfterSeconds,
    body: Object.freeze({
      code: -1,
      error: "PLAN_STORAGE_STARTUP_UNAVAILABLE",
      message: "Plan storage recovery is not ready. Retry after the current startup recovery attempt completes.",
      planStorageStartup: snapshot
        ? publicPlanStorageStartupSnapshot(snapshot)
        : { state: "idle", attempt: 0, incidents: 0 }
    })
  });
}
