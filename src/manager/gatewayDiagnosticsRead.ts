import type { GatewayRuntime } from './runtimeRegistry.js';
import {
  memoryOnlyGatewayRuntimeStatus,
  type GatewayDiagnosticsSnapshotRead,
  type GatewayDiagnosticsSnapshotService
} from './gatewayDiagnosticsSnapshot.js';

export type GatewayDiagnosticsReadFailure = Readonly<{
  stage: 'refresh' | 'snapshot' | 'runtime';
  gatewayId?: string;
  error: unknown;
}>;

/** Read one owner snapshot per collection, then combine it with current runtime facts.
 * The ID comes from the runtime registry, so a broken projection remains identifiable.
 * This index lasts only for the read; it is not another cache or runtime owner.
 */
export function readGatewayDiagnosticsStatuses(
  rootDir: string,
  runtimes: Iterable<readonly [string, GatewayRuntime]>,
  snapshotOwner: Pick<GatewayDiagnosticsSnapshotService, 'requestRefresh' | 'read'>,
  onFailure?: (failure: GatewayDiagnosticsReadFailure) => void
): Record<string, unknown>[] {
  const report = (failure: GatewayDiagnosticsReadFailure) => {
    try { onFailure?.(failure); } catch { /* Optional diagnostics cannot fail the status read. */ }
  };
  let refreshFailed = false;
  try { snapshotOwner.requestRefresh(); }
  catch (error) { refreshFailed = true; report({ stage: 'refresh', error }); }

  let snapshot: GatewayDiagnosticsSnapshotRead | undefined;
  try { snapshot = snapshotOwner.read(true); }
  catch (error) { report({ stage: 'snapshot', error }); }
  const records = new Map<string, Record<string, unknown>>();
  // The owner has already cloned and frozen published records. Do not revalidate
  // or clone each row. First-match semantics preserve the previous find() behavior.
  for (const record of snapshot?.records ?? []) {
    if (typeof record.id === 'string' && !records.has(record.id)) records.set(record.id, record);
  }
  const unavailable = !snapshot
    ? { code: 'GATEWAY_DIAGNOSTICS_SNAPSHOT_UNAVAILABLE', scope: 'cached-diagnostics' }
    : refreshFailed || snapshot.refreshError
      ? { code: 'GATEWAY_DIAGNOSTICS_REFRESH_FAILED', scope: 'cached-diagnostics', revision: snapshot.revision, state: snapshot.state }
      : undefined;
  const results: Record<string, unknown>[] = [];
  for (const [id, runtime] of runtimes) {
    try {
      const status = memoryOnlyGatewayRuntimeStatus(rootDir, runtime, records.get(id));
      results.push({ ...status, id, ...(unavailable ? { diagnosticsUnavailable: unavailable } : {}) });
    } catch (error) {
      report({ stage: 'runtime', gatewayId: id, error });
      // Do not invent running=false, a PID, or a lifecycle state for a failed read.
      results.push({ id, diagnosticsUnavailable: { code: 'GATEWAY_DIAGNOSTICS_RUNTIME_UNAVAILABLE', scope: 'runtime-status' } });
    }
  }
  return results;
}
