import type { RouteCatalogStartupLifecycleSnapshot } from "./routeCatalogStartupLifecycle.js";

export type RouteCatalogHttpDependency = "snapshot" | "mutation";

type RouteCatalogStartupRejection = Readonly<{
  statusCode: 503;
  retryAfterSeconds: number;
  body: Record<string, unknown>;
}>;

const CATALOG_HASH = /^[a-f0-9]{64}$/;
const USABLE_SNAPSHOT_STATES = new Set(["ready", "running", "degraded"]);

export function isRouteCatalogSnapshotInstalled(
  snapshot: RouteCatalogStartupLifecycleSnapshot | undefined
): boolean {
  return Boolean(
    snapshot
    && Number.isSafeInteger(snapshot.revision)
    && Number(snapshot.revision) >= 1
    && CATALOG_HASH.test(snapshot.contentHash ?? "")
    && CATALOG_HASH.test(snapshot.routeConfigHash ?? "")
    && CATALOG_HASH.test(snapshot.presentationHash ?? "")
  );
}

export function publicRouteCatalogStartupSnapshot(
  snapshot: RouteCatalogStartupLifecycleSnapshot
): Record<string, unknown> {
  return Object.freeze({
    state: snapshot.state,
    attempt: snapshot.attempt,
    incidents: snapshot.incidents,
    lastTransitionAt: snapshot.lastTransitionAt,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    deadlineAt: snapshot.deadlineAt,
    nextRetryAt: snapshot.nextRetryAt,
    lastErrorCode: snapshot.lastErrorCode,
    revision: snapshot.revision,
    snapshotInstalled: isRouteCatalogSnapshotInstalled(snapshot)
  });
}

export function routeCatalogHttpDependency(
  method: string | undefined,
  pathname: string
): RouteCatalogHttpDependency | null {
  const normalizedMethod = String(method || "").toUpperCase();

  if (normalizedMethod === "GET" && pathname === "/gateways") return "snapshot";
  if (normalizedMethod === "POST" && pathname === "/gateways") return "mutation";
  if (normalizedMethod === "POST" && /^\/gateways\/[^/]+\/delete$/.test(pathname)) return "mutation";
  if (normalizedMethod === "POST" && /^\/gateways\/[^/]+\/(?:start|stop|restart|weixin-login|manual-trigger|agent-delivery-test|delivery-replay)$/.test(pathname)) {
    return "snapshot";
  }
  if (normalizedMethod === "POST" && pathname === "/reload") return "mutation";

  if (normalizedMethod === "GET" && pathname === "/api/personas") return "snapshot";
  if (normalizedMethod === "GET" && /^\/api\/personas\/messages\/receipts\/[^/]+$/.test(pathname)) return null;
  if (normalizedMethod === "GET" && /^\/api\/personas\/[^/]+$/.test(pathname)) return "snapshot";
  if (normalizedMethod === "POST" && /^\/api\/personas\/[^/]+\/messages$/.test(pathname)) return "snapshot";

  if (normalizedMethod === "GET" && pathname === "/api/rabi/instances") return "snapshot";
  if (/^\/api\/rabi\/instances\/[^/]+\/routes(?:\/|$)/.test(pathname)) {
    if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return "snapshot";
    if (["POST", "PATCH", "PUT", "DELETE"].includes(normalizedMethod)) return "mutation";
  }

  if (normalizedMethod === "POST" && pathname === "/manager-config") return "mutation";
  if (normalizedMethod === "POST" && pathname === "/open-config-file") return "mutation";
  return null;
}

export function routeCatalogStartupUnavailable(
  method: string | undefined,
  pathname: string,
  snapshot: RouteCatalogStartupLifecycleSnapshot | undefined
): RouteCatalogStartupRejection | null {
  const dependency = routeCatalogHttpDependency(method, pathname);
  if (!dependency) return null;

  const snapshotInstalled = isRouteCatalogSnapshotInstalled(snapshot);
  const snapshotUsable = snapshotInstalled && USABLE_SNAPSHOT_STATES.has(snapshot?.state ?? "idle");
  if (snapshotUsable && (dependency === "snapshot" || snapshot?.state === "ready")) return null;

  const retryAfterSeconds = snapshot?.nextRetryAt
    ? Math.max(1, Math.ceil((Date.parse(snapshot.nextRetryAt) - Date.now()) / 1_000))
    : 1;
  const mutationUnavailable = snapshotUsable && dependency === "mutation";
  return Object.freeze({
    statusCode: 503,
    retryAfterSeconds,
    body: Object.freeze({
      code: -1,
      error: mutationUnavailable
        ? "ROUTE_CATALOG_MUTATION_UNAVAILABLE"
        : "ROUTE_CATALOG_SNAPSHOT_UNAVAILABLE",
      message: mutationUnavailable
        ? "A route catalog mutation is already running. Retry without queueing another HTTP mutation."
        : "The initial route catalog snapshot is not installed. Retry after startup recovery completes.",
      requestClass: dependency,
      routeCatalogStartup: snapshot
        ? publicRouteCatalogStartupSnapshot(snapshot)
        : { state: "idle", attempt: 0, incidents: 0, snapshotInstalled: false }
    })
  });
}
