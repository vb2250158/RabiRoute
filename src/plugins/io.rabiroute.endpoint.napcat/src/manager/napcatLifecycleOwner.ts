import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { KeyedAsyncLock } from "@rabiroute/host-api/shared/keyedAsyncLock";
import { atomicWriteFileSync } from "@rabiroute/host-api/shared/filePersistence";
import { NapcatState, NapcatLifecycleError } from "@rabiroute/host-api/shared/napcatStateContract";

export type NapcatBinding = {
  gatewayId: string;
  instanceId: string;
  botUserId?: string;
  workingDir?: string;
  httpUrl: string;
  webuiUrl?: string;
};
export type NapcatProcessIdentity = { pid: number; parentPid: number; startedAt: string; executable: string; napcatRoot?: boolean };
export type NapcatLaunchScope = { commandPath: string; cwd: string };
export type NapcatStoppedProof = { checkedAt: string; commandPath: string };
export type NapcatPortInspection = NapcatStoppedProof & { instanceStopped: boolean;
  listeners: Array<{ port: number; process: NapcatProcessIdentity }> };
export type NapcatOwnedProcess = { binding: NapcatBinding; processes: NapcatProcessIdentity[]; launchPending?: boolean;
  recoveredEndpoints?: { previousHttpUrl: string; previousWebuiUrl?: string; httpUrl: string; webuiUrl: string };
  recoveredLaunch?: { archive: string; proof: NapcatStoppedProof };
  launchAttempt?: { id: string; requestedAt: string; pid?: number; spawnedAt?: string; closedAt?: string; exitCode?: number | null; signal?: string | null } };
export type NapcatProcessDriver = {
  snapshot(): Promise<NapcatProcessIdentity[]>;
  terminate(process: NapcatProcessIdentity): Promise<void>;
  requestExit?(binding: NapcatBinding, processes: NapcatProcessIdentity[]): Promise<void>;
  confirmBundledInstanceStopped?(binding: NapcatBinding, plan: NapcatLaunchScope): Promise<NapcatStoppedProof | undefined>;
  inspectBundledPorts?(binding: NapcatBinding, plan: NapcatLaunchScope): Promise<NapcatPortInspection | undefined>;
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
  private closing = false;
  private retirement?: Promise<void>;

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

  private updateRecordBinding(record: NapcatOwnedProcess, binding: NapcatBinding): void {
    const receipt = record.recoveredEndpoints;
    if (receipt && !((binding.httpUrl === receipt.previousHttpUrl && binding.webuiUrl === receipt.previousWebuiUrl)
      || (binding.httpUrl === receipt.httpUrl && binding.webuiUrl === receipt.webuiUrl))) delete record.recoveredEndpoints;
    record.binding = binding;
  }

  assertBound(request: { gatewayId?: string; instanceId?: string }): NapcatBinding {
    const key = napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" });
    const binding = this.bindings.get(key);
    if (this.closing || !this.initialized || !binding || this.revoked.has(key)) throw new NapcatLifecycleError(NapcatState.Unbound, "NapCat 未绑定到启用的 Rabi 消息端，不能启动或登录。");
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
    if (this.records.has(key) && (this.records.get(key)!.launchPending || (!this.records.get(key)!.processes.length && !this.records.get(key)!.recoveredLaunch))) {
      throw new NapcatLifecycleError(NapcatState.StartFailed, "上次 NapCat 启动的进程身份尚未确认；已保留原启动记录，不能重复启动。");
    }
    if (!this.records.has(key)) this.records.set(key, { binding, processes: [] });
    this.records.get(key)!.launchPending = true;
    this.records.get(key)!.launchAttempt = { id: randomUUID(), requestedAt: new Date().toISOString() };
    this.persist();
  }

  /** The original child handle proves whether spawn occurred and enables later PID capture. */
  async launch(request: { gatewayId?: string; instanceId?: string }, spawnChild: () => ChildProcess, plan?: NapcatLaunchScope): Promise<ChildProcess> {
    return this.run(request, () => this.launchBound(request, spawnChild, plan));
  }

  private async launchBound(request: { gatewayId?: string; instanceId?: string }, spawnChild: () => ChildProcess, plan?: NapcatLaunchScope): Promise<ChildProcess> {
    const binding = this.assertBound(request);
    const pendingKey = napcatBindingKey(binding), pending = this.records.get(pendingKey);
    const attemptIdBeforeProof = pending?.launchAttempt?.id;
    if (pending && (pending.launchPending || !pending.processes.length) && plan && this.options.driver.confirmBundledInstanceStopped) {
      const original = this.launchChildren.get(pendingKey);
      // A live original child must be captured, never replaced by a second launch.
      if (!original || original.exitCode !== null || original.signalCode !== null) {
        const proof = await this.options.driver.confirmBundledInstanceStopped(binding, plan);
        const currentBinding = this.assertBound(request);
        if (!sameBinding(currentBinding, binding) || currentBinding.httpUrl !== binding.httpUrl || currentBinding.webuiUrl !== binding.webuiUrl) {
          throw new NapcatLifecycleError(NapcatState.StartFailed, "NapCat 连接配置已变化，请重新检查当前实例。");
        }
        if (proof && this.records.get(pendingKey) === pending && pending.launchAttempt?.id === attemptIdBeforeProof) {
          const archive = path.join(`${this.options.statePath}.history`, `${randomUUID()}.json`);
          fs.mkdirSync(path.dirname(archive), { recursive: true });
          atomicWriteFileSync(archive, JSON.stringify({ schemaVersion: 1, resolution: "no-live-instance", proof, record: pending }));
          // Preserve the old attempt and its resolution. This does not claim that spawn never happened.
          const resolved = { ...pending, recoveredLaunch: { archive, proof }, launchPending: false };
          this.records.set(pendingKey, resolved);
          try { this.persist(); } catch (error) { this.records.set(pendingKey, pending); throw error; }
          this.options.log("napcat_pending_launch_resolved_absent", pendingKey);
        }
      }
    }
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
    const attemptId = this.records.get(key)!.launchAttempt!.id;
    this.launchChildren.set(key, child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        const record = this.records.get(key);
        if (record?.launchAttempt?.id === attemptId) {
          record.launchAttempt.pid = child.pid; record.launchAttempt.spawnedAt = new Date().toISOString();
          try { this.persist(); } catch (error) { reject(error); return; }
        }
        resolve();
      });
      child.on("error", error => {
        if (child.pid === undefined) unstarted();
        reject(error);
      });
      child.once("close", () => {
        if (this.launchChildren.get(key) === child) this.launchChildren.delete(key);
        const record = this.records.get(key);
        if (record?.launchAttempt?.id === attemptId) {
          Object.assign(record.launchAttempt, { closedAt: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode });
          try { this.persist(); } catch { this.options.log("napcat_launch_receipt_persist_failed", key); }
        }
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
    const roots = snapshot.filter(item => item.executable && item.startedAt
      && (item.pid === confirmedPid || record.processes.some(saved => sameProcess(saved, item))));
    const observed = descendants(snapshot, roots).filter(item => item.startedAt && item.executable);
    if (observed.length) record.processes = observed;
    if (confirmedPid !== undefined && roots.some(item => item.pid === confirmedPid)) delete record.launchPending;
    this.persist();
  }

  private async stopRecord(key: string, record: NapcatOwnedProcess): Promise<void> {
    if (record.launchPending || !record.processes.length) throw new NapcatLifecycleError(NapcatState.StopFailed,
      "NapCat 启动结果尚未确认，没有可核对的进程身份；原启动记录已保留。");
    const snapshot = await this.options.driver.snapshot();
    this.assertInspectable(record.processes, snapshot);
    const roots = snapshot.filter(item => record.processes.some(saved => sameProcess(saved, item)));
    const targets = descendants(snapshot, roots);
    this.assertInspectable(targets, snapshot);
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
    this.assertInspectable(targets, remaining);
    if (remaining.some(item => targets.some(target => sameProcess(item, target)))) {
      throw new NapcatLifecycleError(NapcatState.StopFailed, "NapCat 停止失败，已阻止重新启动；请重试解绑。");
    }
    this.records.delete(key); this.persist();
    this.options.log("napcat_instance_stopped", key);
  }

  private assertInspectable(owned: readonly NapcatProcessIdentity[], snapshot: readonly NapcatProcessIdentity[]): void {
    if (owned.some(saved => !saved.startedAt || !saved.executable
      || snapshot.some(current => current.pid === saved.pid && (!current.startedAt || !current.executable))))
      throw new NapcatLifecycleError(NapcatState.StopFailed, "NapCat 原进程仍存在但身份暂不可读，尚未确认停止；已保留原进程归属。");
  }

  /** Final endpoint retirement; replacements retain this same resource owner. */
  shutdown(): Promise<void> {
    this.closing = true;
    for (const key of this.bindings.keys()) this.revoked.add(key);
    return this.retirement ??= (async () => {
      await Promise.allSettled([...this.flights.values()].flatMap(values => [...values]));
      await this.changes.run("bindings", async () => {
        const failures: unknown[] = [];
        for (const [key, record] of [...this.records]) {
          try {
            if (record.launchPending) await this.recordLaunch(record.binding);
            await this.stopRecord(key, record);
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "NapCat endpoint process retirement remains unconfirmed.");
        this.bindings.clear(); this.initialized = false;
      });
    })();
  }

  /** Revoke first, drain existing operations, stop removed bindings, then admit the new snapshot. */
  reconcile(next: readonly NapcatBinding[]): Promise<void> {
    return this.changes.run("bindings", async () => {
      validateNapcatBindings(next);
      const desired = new Map(next.map(binding => [napcatBindingKey(binding), binding]));
      if (this.initialized && !this.revoked.size && desired.size === this.bindings.size
        && [...desired].every(([key, binding]) => this.bindings.has(key) && sameBinding(this.bindings.get(key)!, binding))) {
        this.bindings = desired;
        for (const [key, record] of this.records) if (desired.has(key)) this.updateRecordBinding(record, desired.get(key)!);
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
      for (const [key, record] of this.records) if (desired.has(key)) this.updateRecordBinding(record, desired.get(key)!);
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

  /** A foreign listener is a conflict, never a process that this owner may terminate. */
  async inspectPortRecovery(request: { gatewayId?: string; instanceId?: string }, plan: NapcatLaunchScope,
    endpoints?: { httpUrl: string; webuiUrl?: string }): Promise<NapcatPortInspection | undefined> {
    const binding = this.assertBound(request), key = napcatBindingKey(binding);
    if (this.leases.getStore() !== key) throw new Error("NapCat port recovery must hold its binding lease.");
    const inspection = await this.options.driver.inspectBundledPorts?.({ ...binding, ...endpoints }, plan);
    const current = this.assertBound(request);
    if (!sameBinding(current, binding) || current.httpUrl !== binding.httpUrl || current.webuiUrl !== binding.webuiUrl)
      throw new Error("NapCat binding changed during port inspection.");
    return inspection;
  }

  async confirmPortRecoveryStopped(request: { gatewayId?: string; instanceId?: string }, plan: NapcatLaunchScope): Promise<NapcatPortInspection | undefined> {
    const binding = this.assertBound(request), key = napcatBindingKey(binding);
    const inspection = await this.inspectPortRecovery(request, plan);
    if (!inspection?.instanceStopped) return;
    const child = this.launchChildren.get(key);
    if (child && child.exitCode === null && child.signalCode === null) return;
    const record = this.records.get(key);
    const snapshot = await this.options.driver.snapshot();
    this.assertInspectable(record?.processes ?? [], snapshot);
    if (record?.processes.some(saved => snapshot.some(live => sameProcess(saved, live)))) return;
    this.assertBound(request);
    if (record) {
      const archive = path.join(`${this.options.statePath}.history`, `${randomUUID()}.json`);
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      atomicWriteFileSync(archive, JSON.stringify({ schemaVersion: 1, resolution: "stopped-before-port-recovery", proof: inspection, record }));
      this.records.delete(key); this.persist();
    }
    return inspection;
  }

  async verifyRecoveredPorts(request: { gatewayId?: string; instanceId?: string }, plan: NapcatLaunchScope,
    endpoints: { httpUrl: string; webuiUrl: string }): Promise<{ httpReady: boolean } | undefined> {
    const binding = this.assertBound(request), record = this.records.get(napcatBindingKey(binding));
    if (!record || record.launchPending || !record.processes.length) return;
    const inspection = await this.inspectPortRecovery(request, plan, endpoints);
    if (!inspection || inspection.instanceStopped) return;
    const [httpPort, webuiPort] = [endpoints.httpUrl, endpoints.webuiUrl].map(value => Number(new URL(value).port));
    const owned = (port: number) => inspection.listeners.filter(listener => listener.port === port);
    const belongs = (listener: NapcatPortInspection["listeners"][number]) => record.processes.some(saved => sameProcess(saved, listener.process));
    if (!owned(webuiPort!).length || !owned(webuiPort!).every(belongs) || !owned(httpPort!).every(belongs)) return;
    return { httpReady: owned(httpPort!).length > 0 };
  }

  recordRecoveredEndpoints(request: { gatewayId?: string; instanceId?: string }, endpoints: { httpUrl: string; webuiUrl: string }): void {
    const binding = this.assertBound(request), key = napcatBindingKey(binding), record = this.records.get(key);
    if (this.leases.getStore() !== key || !record || record.launchPending || !record.processes.length)
      throw new Error("Recovered endpoints require the original confirmed process owner.");
    record.recoveredEndpoints = { previousHttpUrl: binding.httpUrl, previousWebuiUrl: binding.webuiUrl, ...endpoints };
    this.persist();
    this.options.log("napcat_external_ports_recovered", key);
  }

  async hasForeignPortConflict(request: { gatewayId?: string; instanceId?: string }, plan: NapcatLaunchScope,
    endpoints: { httpUrl: string; webuiUrl: string }): Promise<boolean> {
    const binding = this.assertBound(request), record = this.records.get(napcatBindingKey(binding));
    const inspection = await this.inspectPortRecovery(request, plan, endpoints);
    return Boolean(inspection?.listeners.some(listener => !record?.processes.some(saved => sameProcess(saved, listener.process))));
  }

  recoveredEndpoints(request: { gatewayId?: string; instanceId?: string }) {
    const key = napcatBindingKey({ gatewayId: request.gatewayId || "", instanceId: request.instanceId || "" });
    if (!this.initialized || this.closing || this.revoked.has(key) || !this.bindings.has(key)) return;
    const value = this.records.get(key)?.recoveredEndpoints;
    return value ? { ...value } : undefined;
  }

  acknowledgeRecoveredEndpoints(request: { gatewayId?: string; instanceId?: string }): void {
    const binding = this.assertBound(request), key = napcatBindingKey(binding), record = this.records.get(key);
    if (this.leases.getStore() !== key) throw new Error("NapCat endpoint commit must hold its binding lease.");
    if (record) { delete record.recoveredEndpoints; this.persist(); }
  }
}
