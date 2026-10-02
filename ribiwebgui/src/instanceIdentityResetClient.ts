export const INSTANCE_IDENTITY_RESET_WAIT_MS = 45_000;
const operationPath = "/api/rabi/identity/reset-instance-id";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumOperationWaits = 5;
const pendingMessage = "实例 ID 重置结果仍待确认。页面连接可能已切换，请从托盘重新打开 RabiLink 配置查看结果。";

export type InstanceIdentityResetState = "idle" | "confirming" | "submitting" | "pending" | "committed" | "rolled_back" | "failed";
export type ResetIdentity = { guid: string; canResetInstanceId: boolean };
type ResetClientOptions = {
  request?: typeof fetch;
  now?: () => number;
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  operationId?: () => string;
};

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason); }
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

async function resetIdentity(request: typeof fetch, signal: AbortSignal): Promise<ResetIdentity> {
  const response = await request("/api/rabi/identity", { method: "GET", cache: "no-store", redirect: "error", signal });
  const body = await response.json();
  if (!response.ok || body.code !== 0 || typeof body.data?.guid !== "string" || !body.data.guid.trim()) {
    throw new Error(body.message || "无法核对本机实例标识，请刷新重试。");
  }
  return { guid: body.data.guid, canResetInstanceId: body.data.canResetInstanceId === true };
}

export function readResetIdentity(signal: AbortSignal, request: typeof fetch = fetch): Promise<ResetIdentity> {
  return resetIdentity(request, signal);
}

/** One confirmed operation. Uncertain responses never create a second operation or discover another port. */
export class InstanceIdentityResetClient {
  state: InstanceIdentityResetState = "idle";
  dialogOpen = false;
  expectedGuid = "";
  operationId = "";
  newGuid = "";
  message = "";
  private controller?: AbortController;
  private disposed = false;
  private request: typeof fetch;
  private now: () => number;
  private pause: NonNullable<ResetClientOptions["pause"]>;
  private createOperationId: () => string;

  constructor(options: ResetClientOptions = {}) {
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.pause = options.pause ?? pause;
    this.createOperationId = options.operationId ?? (() => crypto.randomUUID());
  }

  open(guid: string): void {
    if (this.disposed || ["submitting", "pending"].includes(this.state) || !guid) return;
    this.expectedGuid = guid;
    this.message = "";
    this.newGuid = "";
    this.state = "confirming";
    this.dialogOpen = true;
  }

  cancel(): void {
    if (this.state !== "confirming") return;
    this.dialogOpen = false;
    this.state = "idle";
  }

  async confirm(): Promise<void> {
    if (this.disposed || !this.dialogOpen || this.state !== "confirming") return;
    this.dialogOpen = false;
    this.state = "submitting";
    this.message = "正在提交实例 ID 重置请求…";
    try { this.operationId = this.createOperationId(); }
    catch {
      this.state = "failed";
      this.message = "当前浏览器无法生成安全操作标识，请从托盘重新打开页面。";
      return;
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(INSTANCE_IDENTITY_RESET_WAIT_MS)]);
    const deadline = this.now() + INSTANCE_IDENTITY_RESET_WAIT_MS;
    let readRetryAvailable = true;
    const readOperation = async () => {
      const read = async () => {
        const response = await this.request(`${operationPath}/${encodeURIComponent(this.operationId)}`, {
          method: "GET", cache: "no-store", redirect: "error", signal
        });
        if ([404, 408, 425, 429].includes(response.status) || response.status >= 500) throw new Error("Operation read unavailable");
        const body = await response.json().catch(() => null);
        return response.ok && body?.code === 0 ? body.data : null;
      };
      try { return await read(); }
      catch (reason) {
        if (!readRetryAvailable || signal.aborted || this.now() >= deadline) throw reason;
        readRetryAvailable = false;
        await this.pause(Math.min(500, deadline - this.now()), signal);
        return read();
      }
    };
    try {
      const response = await this.request(operationPath, {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", redirect: "error", signal,
        body: JSON.stringify({ operationId: this.operationId, expectedGuid: this.expectedGuid, confirmed: true })
      }).catch(() => undefined);
      const body = await response?.json().catch(() => undefined);
      if (this.disposed) return;
      if (signal.aborted) { this.pending(); return; }
      if (response && !response.ok) {
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
          this.state = "failed";
          this.message = body?.message || "实例 ID 重置请求被拒绝，请核对当前实例和 Host 状态。";
          return;
        }
      }
      if (response?.ok && (response.status !== 202 || (body && (body.code !== 0 || body.data?.operationId !== this.operationId || body.data.state !== "queued")))) {
        this.pending();
        return;
      }
      this.state = "pending";
      this.message = "实例 ID 重置处理中，正在等待 Host 确认…";
      // The Manager holds each queued GET on operation-file events for up to ten seconds.
      // The request count also bounds a server that unexpectedly returns queued immediately.
      for (let wait = 0; wait < maximumOperationWaits && !signal.aborted && this.now() < deadline; ++wait) {
        const status = await readOperation();
        if (this.disposed) return;
        if (signal.aborted || this.now() >= deadline) { this.pending(); return; }
        if (!status || status.operationId !== this.operationId) {
          this.pending();
          return;
        }
        if (status.state === "committed") {
          if (typeof status.newGuid !== "string" || !uuid.test(status.newGuid)) { this.pending(); return; }
          const identity = await resetIdentity(this.request, signal);
          if (this.disposed) return;
          if (signal.aborted || this.now() >= deadline) { this.pending(); return; }
          if (identity.guid.toLowerCase() === this.expectedGuid.toLowerCase() || status.newGuid !== identity.guid) {
            this.pending();
            return;
          }
          this.newGuid = identity.guid;
          this.state = "committed";
          this.message = "实例 ID 已重置并确认。旧连接可能需要重新建立。";
          return;
        }
        if (status.state === "rolled_back" || status.state === "failed") {
          this.state = status.state;
          this.message = status.message || (this.state === "rolled_back"
            ? "重置已回滚，原实例 ID 已保留。" : "实例 ID 重置失败，请检查 Host 日志。");
          return;
        }
        if (status.state !== "queued") {
          this.pending();
          return;
        }
      }
      this.pending();
    } catch {
      if (!this.disposed) this.pending();
    } finally { this.controller = undefined; }
  }

  private pending(): void {
    this.state = "pending";
    this.message = pendingMessage;
  }

  stopWaiting(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.pending();
  }

  dispose(): void { this.disposed = true; this.controller?.abort(); }
}
