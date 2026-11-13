import type { DataUpgradeStartRequest, DataUpgradeStatus } from "../shared/dataUpgradeContract.js";
import type { RuntimeLayout } from "../shared/runtimeLayout.js";
import { BoundedStorageStartup } from "./boundedStorageStartup.js";
import { discoverDataUpgrades, readDataUpgradeReceipt, writeDataUpgradeReceipt, type DataUpgradeReceipt } from "./dataUpgradeOperations.js";

export class DataUpgradeRequestError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export class DataUpgradeService {
  private status: DataUpgradeStatus = { revision: 0, state: "checking", items: [] };
  private receipt?: DataUpgradeReceipt;
  private readonly scope = new BoundedStorageStartup({ concurrency: 1, itemTimeoutMs: 120_000, batchTimeoutMs: 150_000 });
  private readonly listeners = new Set<(status: DataUpgradeStatus) => void>();
  private readonly restartRequests = new Set<string>();
  private initialization?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: Readonly<{
    layout: RuntimeLayout; rolesRoot: string | (() => string); readOnly?: boolean;
    requestRestart?: (operationId: string) => Promise<void>;
    discover?: () => Promise<DataUpgradeStatus["items"]>;
  }>) {}
  snapshot(): DataUpgradeStatus { return structuredClone(this.status); }
  subscribe(listener: (status: DataUpgradeStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Start once, after the application has opened its HTTP/UI entrance. */
  start(): Promise<void> {
    return this.initialization ??= this.initialize();
  }
  private publish(status: DataUpgradeStatus): void {
    this.status = status;
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Observer does not own the receipt. */ } }
  }
  private async initialize(): Promise<void> {
    try {
      this.receipt = await readDataUpgradeReceipt(this.options.layout);
      if (this.stopped) return;
      if (this.receipt) {
        const prior = this.receipt.status;
        if (prior.state === "running") {
          const updatedAt = new Date().toISOString();
          this.receipt.status = { ...prior, state: "interrupted", revision: prior.revision + 1,
            operation: prior.operation ? { ...prior.operation, state: "interrupted", updatedAt } : undefined };
          this.persist(this.receipt.status);
        }
        this.publish(this.receipt.status);
        if (this.receipt.status.state === "awaiting-restart") return;
      }
      const items = await (this.options.discover?.() ?? discoverDataUpgrades(this.options.layout, typeof this.options.rolesRoot === "function" ? this.options.rolesRoot() : this.options.rolesRoot, this.scope));
      if (this.stopped) return;
      // A completed receipt stays reviewable; new real metadata supersedes it only when another upgrade exists.
      if (!items.length && this.receipt?.status.state === "succeeded") return;
      this.publish({ revision: this.status.revision + 1, state: items.some(item => item.state === "failed") ? "failed" : items.length ? "available" : "current", items,
        ...(this.receipt?.status.operation ? { operation: this.receipt.status.operation } : {}),
        restartRequired: items.some(item => item.state === "pending") });
    } catch {
      if (!this.stopped) this.publish({ ...this.status, revision: this.status.revision + 1, state: "failed",
        items: [{ id: "discovery", title: "数据升级检查", description: "升级检查未完成，原数据保持不变。请查看运行日志后重新启动应用检查。", state: "failed" }] });
    }
  }
  private persist(status: DataUpgradeStatus, confirmedItemIds = this.receipt?.confirmedItemIds ?? []): void {
    const receipt: DataUpgradeReceipt = { schemaVersion: 1, status, confirmedItemIds,
      receipts: { ...(this.receipt?.receipts ?? {}), ...(status.operation ? { [status.operation.operationId]: status } : {}) } };
    writeDataUpgradeReceipt(this.options.layout, receipt);
    this.receipt = receipt;
  }
  accept(request: DataUpgradeStartRequest): DataUpgradeStatus {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(request.operationId) || !Number.isSafeInteger(request.expectedRevision)) throw new DataUpgradeRequestError(400, "无效的升级请求。");
    const previous = this.receipt?.receipts[request.operationId];
    if (previous) return structuredClone(previous);
    if (this.options.readOnly) throw new DataUpgradeRequestError(403, "当前应用为只读模式；请在正常运行的应用中确认升级。");
    if (this.status.state === "checking") throw new DataUpgradeRequestError(409, "正在检查待升级数据，请等待检查结果。");
    if (this.status.operation && ["running", "awaiting-restart"].includes(this.status.operation.state)) return this.snapshot();
    if (request.expectedRevision !== this.status.revision) throw new DataUpgradeRequestError(409, "升级列表已更新，请查看最新列表后确认。");
    if (!this.options.requestRestart) throw new DataUpgradeRequestError(409, "此启动方式不支持应用内重启。请通过正式 Host 启动应用后确认升级。");
    const pending = this.status.items.filter(item => ["pending", "failed"].includes(item.state) && item.id !== "discovery");
    if (!pending.length) throw new DataUpgradeRequestError(409, "当前没有可执行的数据升级。");
    const ids = pending.map(item => item.id), now = new Date().toISOString();
    const status: DataUpgradeStatus = { revision: this.status.revision + 1, state: "awaiting-restart", restartRequired: true,
      items: this.status.items.map(item => ids.includes(item.id) ? { ...item, state: "awaiting-restart", error: undefined } : item),
      operation: { operationId: request.operationId, state: "awaiting-restart", startedAt: now, updatedAt: now,
        completedItems: 0, totalItems: ids.length, requiresRestart: true } };
    this.persist(status, ids);
    this.publish(status);
    return this.snapshot();
  }
  /** HTTP owner calls after response finish. A GET never triggers lifecycle changes. */
  async requestRestart(operationId: string): Promise<void> {
    if (this.restartRequests.has(operationId) || this.status.operation?.operationId !== operationId || this.status.state !== "awaiting-restart") return;
    this.restartRequests.add(operationId);
    try { await this.options.requestRestart?.(operationId); }
    catch (error) { this.markRestartFailed(operationId, (error as { restartDispatched?: boolean })?.restartDispatched !== false); }
  }
  markRestartRequested(operationId: string): void { this.restartRequests.add(operationId); }
  markRestartFailed(operationId: string, uncertain = true): void {
    if (this.status.operation?.operationId !== operationId) return;
    const state = uncertain ? "awaiting-restart" as const : "interrupted" as const;
    const status: DataUpgradeStatus = { ...this.status, revision: this.status.revision + 1, state,
      items: uncertain ? this.status.items : this.status.items.map(item => item.state === "awaiting-restart" ? { ...item, state: "pending" } : item),
      operation: { ...this.status.operation, state, updatedAt: new Date().toISOString(),
        error: uncertain ? "Host 重启结果待确认；已确认的升级保持有效，应用下次正常启动将核对原回执继续。"
          : "Host 尚未接受重启。请确认 Host 状态后重新确认升级；原存档和迁移回执已保留。" } };
    this.persist(status); this.publish(status);
  }
  async stop(): Promise<void> { this.stopped = true; await this.scope.cancel(); this.listeners.clear(); }
}
