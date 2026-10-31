import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedAsyncLock } from "../shared/keyedAsyncLock.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { NapcatState, NapcatLifecycleError } from "../shared/napcatStateContract.js";

export type NapcatBinding = {
  gatewayId: string;
  instanceId: string;
  botUserId?: string;
  workingDir?: string;
  httpUrl: string;
  webuiUrl?: string;
};
export type NapcatProcessIdentity = { pid: number; parentPid: number; startedAt: string; executable: string; napcatRoot?: boolean };
export type NapcatOwnedProcess = { binding: NapcatBinding; processes: NapcatProcessIdentity[]; launchPending?: boolean };
export type NapcatProcessDriver = {
  snapshot(): Promise<NapcatProcessIdentity[]>;
  terminate(process: NapcatProcessIdentity): Promise<void>;
  requestExit?(binding: NapcatBinding, processes: NapcatProcessIdentity[]): Promise<void>;
};

export const napcatBindingKey = (binding: Pick<NapcatBinding, "gatewayId" | "instanceId">): string =>
  JSON.stringify([binding.gatewayId, binding.instanceId]);
const normalizedPath = (value: string): string => process.platform === "win32" ? path.resolve(value).replaceAll("\\", "/").toLowerCase() : path.resolve(value);
const sameProcess = (left: NapcatProcessIdentity, right: NapcatProcessIdentity): boolean =>
  left.pid === right.pid && left.startedAt === right.startedAt && normalizedPath(left.executable) === normalizedPath(right.executable);
function sameBinding(left: NapcatBinding, right: NapcatBinding): boolean {
  return napcatBindingKey(left) === napcatBindingKey(right)
    && (left.workingDir ? normalizedPath(left.workingDir) : "") === (right.workingDir ? normalizedPath(right.workingDir) : "")
    && (!left.botUserId || left.botUserId === right.botUserId);
}

export function validateNapcatBindings(bindings: readonly NapcatBinding[]): void {
  const routes = new Set<string>();
  const directories = new Set<string>();
  for (const binding of bindings) {
    if (routes.has(binding.gatewayId)) throw new Error("一条路由只能绑定一个 QQ，请为另一个 QQ 新建路由。");
    routes.add(binding.gatewayId);
    if (!binding.workingDir) continue;
    const directory = normalizedPath(binding.workingDir);
    if ([...directories].some(existing => existing === directory || existing.startsWith(`${directory}/`) || directory.startsWith(`${existing}/`))) {
      throw new Error("多个 Rabi 消息端共用了同一个 NapCat 目录，请分别绑定独立实例。");
    }
    directories.add(directory);
  }
}
function descendants(snapshot: NapcatProcessIdentity[], roots: NapcatProcessIdentity[]): NapcatProcessIdentity[] {
  const found = new Map(roots.map(item => [item.pid, item]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      const parent = found.get(item.parentPid);
      if (!found.has(item.pid) && parent && !(Date.parse(item.startedAt) < Date.parse(parent.startedAt))) {
        found.set(item.pid, item); changed = true;
      }
    }
  }
  return [...found.values()];
}

/** Route configuration owns bindings; this service owns only the processes created for them. */
export class NapcatLifecycleOwner {
  private bindings = new Map<string, NapcatBinding>();
  private records = new Map<string, NapcatOwnedProcess>();
  private revoked = new Set<string>();
  private removals = new Set<string>();
  private flights = new Map<string, Set<Promise<unknown>>>();
  private leases = new AsyncLocalStorage<string>();
  private changes = new KeyedAsyncLock();
  private operations = new KeyedAsyncLock();
  private initialized = false;
  private launchChildren = new Map<string, ChildProcess>();

  constructor(private readonly options: {
    statePath: string;
    driver: NapcatProcessDriver;
    log(event: string, detail: string): void;
  }) {
    if (fs.existsSync(options.statePath)) {
      const saved = JSON.parse(fs.readFileSync(options.statePath, "utf8")) as { schemaVersion: number; records: NapcatOwnedProcess[]; removals?: string[] };
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.records)) throw new Error("Invalid NapCat process ownership record.");
      for (const record of saved.records) this.records.set(napcatBindingKey(record.binding), record);
      this.removals = new Set(saved.removals ?? []);
      this.revoked = new Set(this.removals);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
    atomicWriteFileSync(this.options.statePath, JSON.stringify({ schemaVersion: 1, records: [...this.records.values()], removals: [...this.removals] }));
  }

  assertBound(request: { gatewayId?: string; instanceId?: string }): NapcatBinding {
    const key = napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" });
    const binding = this.bindings.get(key);
    if (!this.initialized || !binding || this.revoked.has(key)) throw new NapcatLifecycleError(NapcatState.Unbound, "NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
    return binding;
  }

  async run<T>(request: { gatewayId?: string; instanceId?: string }, operation: () => Promise<T>): Promise<T> {
    const binding = this.assertBound(request);
    const key = napcatBindingKey(binding);
    if (this.leases.getStore() === key) return operation();
    const flight = this.operations.run(key, () => this.leases.run(key, async () => { this.assertBound(request); return operation(); }));
    const active = this.flights.get(key) ?? new Set();
    active.add(flight); this.flights.set(key, active);
    try { return await flight; } finally { active.delete(flight); if (!active.size) this.flights.delete(key); }
  }

  /** Persist intent before spawn, so a crash between spawn and PID capture is recoverable. */
  prepareLaunch(request: { gatewayId?: string; instanceId?: string }): void {
    const binding = this.assertBound(request);
    const key = napcatBindingKey(binding);
    if (this.records.has(key) && (this.records.get(key)!.launchPending || !this.records.get(key)!.processes.length)) {
      throw new NapcatLifecycleError(NapcatState.StartFailed, "上次 NapCat 启动的进程身份尚未确认；已保留原启动记录，不能重复启动。");
    }
    if (!this.records.has(key)) this.records.set(key, { binding, processes: [] });
    this.records.get(key)!.launchPending = true;
    this.persist();
  }

  /** The original child handle proves whether spawn occurred and enables later PID capture. */
  async launch(request: { gatewayId?: string; instanceId?: string }, spawnChild: () => ChildProcess): Promise<ChildProcess> {
    this.prepareLaunch(request);
    const key = napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" });
    const unstarted = () => {
      const record = this.records.get(key);
      if (!record) return;
      delete record.launchPending;
      if (!record.processes.length) this.records.delete(key);
      this.persist();
    };
    let child: ChildProcess;
    try { child = spawnChild(); } catch (error) { unstarted(); throw error; }
    this.launchChildren.set(key, child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.on("error", error => {
        if (child.pid === undefined) unstarted();
        reject(error);
      });
      child.once("close", () => {
        if (this.launchChildren.get(key) === child) this.launchChildren.delete(key);
      });
    });
    await this.recordLaunch(request);
    return child;
  }

  async recordLaunch(request: { gatewayId?: string; instanceId?: string }, rootPid?: number): Promise<void> {
    const key = napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" });
    const record = this.records.get(key);
    if (!record) throw new Error("NapCat launch was not registered before spawn.");
    const child = this.launchChildren.get(key);
    const launchPid = rootPid ?? (child?.exitCode === null && child.signalCode === null ? child.pid : undefined);
    const snapshot = await this.options.driver.snapshot();
    const confirmedPid = child && (child.exitCode !== null || child.signalCode !== null) ? undefined : launchPid;
    // Only the original launch callback or already recorded identities establish ownership.
    const roots = snapshot.filter(item => item.pid === confirmedPid || record.processes.some(saved => sameProcess(saved, item)));
    const observed = descendants(snapshot, roots);
    if (observed.length) record.processes = observed;
    if (confirmedPid !== undefined && roots.some(item => item.pid === confirmedPid)) delete record.launchPending;
    this.persist();
  }

  private async stopRecord(key: string, record: NapcatOwnedProcess): Promise<void> {
    if (record.launchPending || !record.processes.length) throw new NapcatLifecycleError(NapcatState.StopFailed,
      "NapCat 启动结果尚未确认，没有可核对的进程身份；原启动记录已保留。");
    const snapshot = await this.options.driver.snapshot();
    const roots = snapshot.filter(item => record.processes.some(saved => sameProcess(saved, item)));
    const targets = descendants(snapshot, roots);
    record.processes = targets; this.persist();
    // Only ask a verified instance to exit. A stale HTTP port can belong to another account.
    if (targets.length) await this.options.driver.requestExit?.(record.binding, targets).catch(() => undefined);
    for (const target of targets) {
      const current = (await this.options.driver.snapshot()).find(item => sameProcess(item, target));
      if (current) {
        try { await this.options.driver.terminate(current); }
        catch (cause) {
          this.options.log("napcat_instance_stop_failed", key);
          throw new NapcatLifecycleError(NapcatState.StopFailed, "NapCat 停止失败，已阻止重新启动；请重试解绑。", { cause });
        }
      }
    }
    const remaining = await this.options.driver.snapshot();
    if (remaining.some(item => targets.some(target => sameProcess(item, target)))) {
      throw new NapcatLifecycleError(NapcatState.StopFailed, "NapCat 停止失败，已阻止重新启动；请重试解绑。");
    }
    this.records.delete(key); this.persist();
    this.options.log("napcat_instance_stopped", key);
  }

  /** Revoke first, drain existing operations, stop removed bindings, then admit the new snapshot. */
  reconcile(next: readonly NapcatBinding[]): Promise<void> {
    return this.changes.run("bindings", async () => {
      validateNapcatBindings(next);
      const desired = new Map(next.map(binding => [napcatBindingKey(binding), binding]));
      if (this.initialized && !this.revoked.size && desired.size === this.bindings.size
        && [...desired].every(([key, binding]) => this.bindings.has(key) && sameBinding(this.bindings.get(key)!, binding))) {
        this.bindings = desired;
        for (const [key, record] of this.records) if (desired.has(key)) record.binding = desired.get(key)!;
        this.persist();
        return;
      }
      for (const [key, binding] of this.bindings) {
        if (!desired.has(key) || !sameBinding(binding, desired.get(key)!)) this.revoked.add(key);
      }
      for (const [key, record] of this.records) {
        if (!desired.has(key) || !sameBinding(record.binding, desired.get(key)!)) this.revoked.add(key);
      }
      for (const key of this.revoked) await Promise.allSettled([...(this.flights.get(key) ?? [])]);
      // Discovery is not ownership. Configuring a directory must not adopt another
      // Manager's signed-in process; only this store's launch records may be stopped.
      for (const [key, record] of [...this.records]) {
        if (record.launchPending || !record.processes.length) {
          this.options.log("napcat_launch_identity_unconfirmed", key);
          continue;
        }
        if (!desired.has(key) || !sameBinding(record.binding, desired.get(key)!) || this.removals.has(key)) await this.stopRecord(key, record);
      }
      this.bindings = desired;
      for (const [key, record] of this.records) if (desired.has(key)) record.binding = desired.get(key)!;
      for (const key of this.removals) if (!desired.has(key)) this.removals.delete(key);
      this.persist();
      this.revoked = new Set(this.removals);
      this.initialized = true;
      this.options.log("napcat_bindings_reconciled", `bound=${desired.size}; owned=${this.records.size}`);
    });
  }

  /** Explicit removal blocks commands until a later committed snapshot restores the binding. */
  async remove(request: { gatewayId?: string; instanceId?: string }): Promise<void> {
    const binding = this.bindings.get(napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" }));
    if (!binding) throw new NapcatLifecycleError(NapcatState.Unbound, "NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
    const key = napcatBindingKey(binding);
    this.removals.add(key);
    this.revoked.add(key);
    this.persist();
    await Promise.allSettled([...(this.flights.get(key) ?? [])]);
    await this.changes.run("bindings", async () => {
      const record = this.records.get(key);
      if (record) await this.stopRecord(key, record);
    });
  }

  async stopForRestart(request: { gatewayId?: string; instanceId?: string }): Promise<void> {
    const binding = this.assertBound(request);
    const key = napcatBindingKey(binding);
    if (this.leases.getStore() !== key) throw new Error("NapCat restart must hold its binding lease.");
    const record = this.records.get(key);
    if (record) await this.stopRecord(key, record);
  }
}
