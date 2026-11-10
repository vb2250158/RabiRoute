import type { DataUpgradeStatus, DataUpgradeStartRequest } from "../../src/shared/dataUpgradeContract";

export type DataUpgradeView = { status: DataUpgradeStatus | null; open: boolean; pending: boolean; error: string; uncertain: boolean };
export type DataUpgradeTransport = {
  read(signal: AbortSignal): Promise<DataUpgradeStatus>;
  start(request: DataUpgradeStartRequest, signal: AbortSignal): Promise<DataUpgradeStatus>;
};
class UpgradeRequestRejected extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request(path: string, init: RequestInit): Promise<DataUpgradeStatus> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    const message = body?.message || (response.status === 404
      ? "当前服务尚未提供数据升级，请更新服务后重新打开页面。"
      : response.status === 403 ? "当前连接只有读取权限，请使用有管理权限的连接升级数据。"
        : `数据升级请求失败（HTTP ${response.status}）。`);
    throw response.status < 500 ? new UpgradeRequestRejected(message, response.status) : new Error(message);
  }
  return response.json();
}

export const dataUpgradeTransport: DataUpgradeTransport = {
  read: signal => request("/api/data-upgrades", { signal }),
  start: (body, signal) => request("/api/data-upgrades/start", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
  })
};

/** Page-owned requests only; cancelling a request never cancels the Manager operation. */
export function createDataUpgradeController(
  view: DataUpgradeView, transport: DataUpgradeTransport = dataUpgradeTransport,
  newId: () => string = () => crypto.randomUUID()
) {
  const abort = new AbortController();
  const seen = new Set<number>();
  let disposed = false;
  let loaded = false;
  let eventVersion = 0;
  let uncertainOperationId = "";
  let hiddenOperationId = "";
  function accept(status: DataUpgradeStatus) {
    if (disposed) return;
    view.status = status;
    if (uncertainOperationId && status.operation?.operationId === uncertainOperationId) {
      uncertainOperationId = "";
      view.uncertain = false;
      view.error = "";
    }
    const actionable = status.items.some(item => item.state === "pending" || item.state === "failed");
    const operationHidden = Boolean(hiddenOperationId && status.operation?.operationId === hiddenOperationId);
    if (loaded && !operationHidden && !seen.has(status.revision) && (actionable || status.state === "running" || status.state === "interrupted" || status.state === "awaiting-restart")) {
      seen.add(status.revision);
      view.open = true;
    }
  }
  return {
    async ready() {
      if (loaded || disposed) return;
      loaded = true;
      const version = eventVersion;
      try { const status = await transport.read(abort.signal); if (version === eventVersion) accept(status); }
      catch (error) { if (!disposed) view.error = error instanceof Error ? error.message : String(error); }
    },
    event(status: DataUpgradeStatus) { eventVersion++; accept(status); },
    close() { hiddenOperationId = view.status?.operation?.operationId || ""; view.open = false; },
    async confirm() {
      if (disposed || view.pending || view.uncertain || !view.status || view.status.state === "running") return;
      view.pending = true;
      view.error = "";
      // Explicitly resume the accepted receipt; never mint a replacement for awaiting work.
      const operationId = view.status.state === "awaiting-restart" && view.status.operation
        ? view.status.operation.operationId : newId();
      const expectedRevision = view.status.revision;
      const version = eventVersion;
      try {
        const status = await transport.start({ operationId, expectedRevision }, abort.signal);
        if (version === eventVersion) accept(status);
      }
      catch (error) {
        if (disposed) return;
        if (error instanceof UpgradeRequestRejected) {
          view.error = error.message;
          if (error.status === 409) {
            try { accept(await transport.read(abort.signal)); } catch { /* Preserve the rejection reason. */ }
          }
          return;
        }
        view.uncertain = true;
        uncertainOperationId = operationId;
        view.error = error instanceof Error ? error.message : String(error);
        // A lost response may already have started work. Read once, never repeat the write.
        try {
          const status = await transport.read(abort.signal);
          accept(status);
          if (!disposed && status.operation?.operationId === operationId) {
            view.uncertain = false;
            view.error = "";
          }
        } catch { /* Keep the original error and uncertain outcome visible. */ }
      } finally { if (!disposed) view.pending = false; }
    },
    dispose() { disposed = true; abort.abort(); }
  };
}

export function upgradeQuantity(value: number | undefined, bytes = false): string {
  if (value === undefined) return "未知";
  if (!bytes) return String(value);
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1048576).toFixed(1)} MiB`;
}
