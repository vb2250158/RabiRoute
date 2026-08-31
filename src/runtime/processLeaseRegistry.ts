import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stopChildProcessTree } from "./windowsProcessTree.js";

export type ProcessLeaseOwner = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
  activationId: string;
  instanceId: string;
  revision: string;
}>;

export type ProcessLease = Readonly<{
  id: string;
  key: string;
  owner: ProcessLeaseOwner;
  child: ChildProcess;
  settled: Promise<void>;
}>;

type LeaseState = {
  lease: ProcessLease;
  settle(): void;
  stopPromise?: Promise<void>;
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

export function processLeaseOwnerKey(owner: ProcessLeaseOwner): string {
  return [
    required(owner.applicationGenerationId, "applicationGenerationId"),
    required(owner.managerInstanceId, "managerInstanceId"),
    required(owner.activationId, "activationId"),
    required(owner.instanceId, "instanceId"),
    required(owner.revision, "revision")
  ].join("\0");
}

export class ProcessLeaseRegistry {
  readonly #leases = new Map<string, LeaseState>();
  readonly #quiescingOwners = new Set<string>();
  #stoppingAll = false;
  readonly #terminationTimeoutMs: number;

  constructor(
    private readonly stopProcess: (child: ChildProcess) => Promise<void> = child => stopChildProcessTree(child),
    options: Readonly<{ terminationTimeoutMs?: number }> = {}
  ) {
    this.#terminationTimeoutMs = Math.max(1, Math.floor(options.terminationTimeoutMs ?? 5_000));
  }

  launch(
    owner: ProcessLeaseOwner,
    key: string,
    start: () => ChildProcess,
    options: Readonly<{ maxChildProcesses?: number; exclusiveAcrossOwners?: boolean }> = {}
  ): ProcessLease {
    const ownerKey = processLeaseOwnerKey(owner);
    const processKey = required(key, "Process lease key");
    if (this.#stoppingAll || this.#quiescingOwners.has(ownerKey)) {
      throw new Error(`Process lease owner is quiescing: ${owner.instanceId}.`);
    }
    const maximum = options.maxChildProcesses ?? Number.MAX_SAFE_INTEGER;
    const activeForOwner = [...this.#leases.keys()].filter(item => item.startsWith(`${ownerKey}\0`)).length;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || activeForOwner >= maximum) {
      throw new Error(`Process lease owner reached its child-process limit: ${owner.instanceId}.`);
    }
    if (options.exclusiveAcrossOwners && [...this.#leases.values()].some(state => (
      state.lease.key === processKey && state.lease.child.exitCode === null
    ))) {
      throw new Error(`Exclusive process lease is already owned: ${processKey}.`);
    }
    const registryKey = `${ownerKey}\0${processKey}`;
    const current = this.#leases.get(registryKey);
    if (current?.lease.child.exitCode === null) throw new Error(`Process lease already exists: ${processKey}.`);
    if (current) this.#complete(registryKey, current);

    const child = start();
    let state: LeaseState | undefined;
    let complete = (): void => {};
    child.on("error", () => {
      if (state && child.exitCode !== null) complete();
    });
    if (!child.pid) {
      try { child.kill(); } catch { /* the observer above owns a later asynchronous spawn error */ }
      throw new Error(`Process lease child did not publish a PID: ${processKey}.`);
    }
    let settle = (): void => {};
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const lease = Object.freeze({ id: randomUUID(), key: processKey, owner: Object.freeze({ ...owner }), child, settled });
    const activeState: LeaseState = { lease, settle };
    state = activeState;
    this.#leases.set(registryKey, activeState);
    complete = (): void => this.#complete(registryKey, activeState);
    child.once("exit", complete);
    child.once("close", complete);
    if (child.exitCode !== null) complete();
    return lease;
  }

  list(owner?: ProcessLeaseOwner): readonly ProcessLease[] {
    const ownerKey = owner ? processLeaseOwnerKey(owner) : undefined;
    return Object.freeze([...this.#leases.entries()]
      .filter(([key]) => !ownerKey || key.startsWith(`${ownerKey}\0`))
      .map(([, state]) => state.lease));
  }

  quiesceOwner(owner: ProcessLeaseOwner): void {
    this.#quiescingOwners.add(processLeaseOwnerKey(owner));
  }

  async drainOwner(owner: ProcessLeaseOwner, timeoutMs: number): Promise<boolean> {
    this.quiesceOwner(owner);
    const leases = this.list(owner);
    if (!leases.length) return true;
    const completed = await Promise.race([
      Promise.all(leases.map(lease => lease.settled)).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), Math.max(1, timeoutMs)))
    ]);
    return completed;
  }

  async terminateOwner(owner: ProcessLeaseOwner): Promise<void> {
    this.quiesceOwner(owner);
    const ownerKey = processLeaseOwnerKey(owner);
    await Promise.all([...this.#leases.entries()]
      .filter(([key]) => key.startsWith(`${ownerKey}\0`))
      .map(([registryKey, state]) => this.#stop(registryKey, state)));
  }

  async terminate(lease: ProcessLease): Promise<void> {
    const entry = [...this.#leases.entries()].find(([, state]) => state.lease.id === lease.id);
    if (!entry) return;
    await this.#stop(entry[0], entry[1]);
  }

  releaseOwner(owner: ProcessLeaseOwner): void {
    const ownerKey = processLeaseOwnerKey(owner);
    if ([...this.#leases.keys()].some(key => key.startsWith(`${ownerKey}\0`))) {
      throw new Error(`Process lease owner still has active children: ${owner.instanceId}.`);
    }
    this.#quiescingOwners.delete(ownerKey);
  }

  async disposeAll(): Promise<void> {
    this.#stoppingAll = true;
    try {
      await Promise.all([...this.#leases.entries()].map(([key, state]) => this.#stop(key, state)));
    } finally {
      this.#quiescingOwners.clear();
    }
  }

  #complete(key: string, state: LeaseState): void {
    if (this.#leases.get(key) === state) this.#leases.delete(key);
    state.settle();
  }

  #stop(key: string, state: LeaseState): Promise<void> {
    if (state.stopPromise) return state.stopPromise;
    const attempt = (async () => {
      const deadline = Date.now() + this.#terminationTimeoutMs;
      if (state.lease.child.exitCode === null) {
        const gracefulDeadline = Date.now() + Math.max(1, Math.floor(this.#terminationTimeoutMs / 2));
        await this.#withinDeadline(
          this.stopProcess(state.lease.child).catch(() => undefined),
          gracefulDeadline,
          undefined
        );
        const gracefullyExited = state.lease.child.exitCode !== null || await this.#withinDeadline(
          state.lease.settled.then(() => true),
          gracefulDeadline,
          false
        );
        if (!gracefullyExited && state.lease.child.exitCode === null) {
          try { state.lease.child.kill("SIGKILL"); } catch { /* report through the bounded exit check */ }
        }
      }
      if (state.lease.child.exitCode !== null) this.#complete(key, state);
      const exited = await this.#withinDeadline(state.lease.settled.then(() => true), deadline, false);
      if (!exited) {
        throw new Error(
          `Process lease did not exit within ${this.#terminationTimeoutMs}ms: ${state.lease.key}.`
        );
      }
    })();
    state.stopPromise = attempt;
    void attempt.catch(() => {
      if (state.stopPromise === attempt && this.#leases.get(key) === state) {
        state.stopPromise = undefined;
      }
    });
    return attempt;
  }

  async #withinDeadline<T>(operation: Promise<T>, deadline: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>(resolve => {
          timer = setTimeout(() => resolve(fallback), Math.max(1, deadline - Date.now()));
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
