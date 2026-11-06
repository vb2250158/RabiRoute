import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

let native, hub;
function bindings() {
  if (process.platform !== "win32") throw new Error("Windows Job Objects require Windows.");
  if (native) return native;
  const koffi = createRequire(import.meta.url)("koffi");
  const library = koffi.load("kernel32.dll");
  const fn = prototype => library.func(prototype);
  native = {
    pointerBytes: koffi.sizeof("void *"),
    create: fn("void * __stdcall CreateJobObjectW(void *attributes, str16 name)"),
    open: fn("void * __stdcall OpenJobObjectW(uint32_t access, int inherit, str16 name)"),
    assign: fn("int __stdcall AssignProcessToJobObject(void *job, void *process)"),
    currentProcess: fn("void * __stdcall GetCurrentProcess()"),
    openProcess: fn("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t id)"),
    processId: fn("uint32_t __stdcall GetProcessId(void *process)"),
    processTimes: fn("int __stdcall GetProcessTimes(void *process, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)"),
    processInJob: fn("int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)"),
    waitProcess: fn("uint32_t __stdcall WaitForSingleObject(void *process, uint32_t timeout)"),
    set: fn("int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t length)"),
    query: fn("int __stdcall QueryInformationJobObject(void *job, int kind, _Out_ void *data, uint32_t length, void *returned)"),
    terminate: fn("int __stdcall TerminateJobObject(void *job, uint32_t exitCode)"),
    close: fn("int __stdcall CloseHandle(void *handle)"),
    port: fn("void * __stdcall CreateIoCompletionPort(void *file, void *existing, uintptr_t key, uint32_t concurrency)"),
    wait: fn("int __stdcall GetQueuedCompletionStatus(void *port, _Out_ uint32_t *message, _Out_ uintptr_t *key, _Out_ void **overlapped, uint32_t timeout)"),
    post: fn("int __stdcall PostQueuedCompletionStatus(void *port, uint32_t message, uintptr_t key, void *overlapped)"),
    error: fn("uint32_t __stdcall GetLastError()")
  };
  return native;
}
function checked(result, operation, api = bindings()) {
  if (!result) throw new Error(`${operation} failed (Windows error ${api.error()}).`);
  return result;
}

class CompletionHub {
  entries = new Map();
  nextKey = 1;
  waiting = false;
  closed = false;
  constructor(api) {
    this.api = api;
    const invalid = BigInt.asUintN(api.pointerBytes * 8, -1n);
    this.handle = checked(api.port(invalid, null, 0, 1), "CreateIoCompletionPort", api);
  }
  add(owner) {
    const key = this.nextKey++;
    const information = Buffer.alloc(this.api.pointerBytes * 2);
    if (this.api.pointerBytes === 8) {
      information.writeBigUInt64LE(BigInt(key), 0);
      information.writeBigUInt64LE(BigInt(this.handle), 8);
    } else {
      information.writeUInt32LE(key, 0);
      information.writeUInt32LE(Number(this.handle), 4);
    }
    checked(this.api.set(owner.handle, 7, information, information.length), "Associate Job completion port", this.api);
    this.entries.set(key, owner);
    this.wait();
    return key;
  }
  remove(key) {
    this.entries.delete(key);
    if (!this.entries.size && !this.closed) this.api.post(this.handle, 0, 0, null);
  }
  wait() {
    if (this.waiting || this.closed) return;
    if (!this.entries.size) {
      this.closed = true;
      checked(this.api.close(this.handle), "Close completion port", this.api);
      if (hub === this) hub = undefined;
      return;
    }
    this.waiting = true;
    const message = [0], key = [0], overlapped = [null];
    this.api.wait.async(this.handle, message, key, overlapped, 0xffffffff, (error, success) => {
      this.waiting = false;
      if (error || !success) {
        const failure = error ?? new Error("Windows Job completion wait failed; tree exit remains unconfirmed.");
        for (const owner of this.entries.values()) owner.noteFailure(failure);
        return;
      }
      this.entries.get(Number(key[0]))?.refresh();
      this.wait();
    });
  }
}

/** The Manager retains the only long-lived Job handle, before any bootstrap exists. */
export class WindowsJobTree {
  name = `Local\\RabiRoute.ProcessLease.${randomUUID()}`;
  admitted = false;
  rootClosed = false;
  closed = false;
  failure;
  members = new Map();
  confirmedMembers = 0;
  waitingHandle;
  observationFailure;
  terminationSnapshot;
  captureFailures = new Map();
  constructor() {
    this.api = bindings();
    this.handle = checked(this.api.create(null, this.name), "CreateJobObjectW", this.api);
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
    try {
      const limits = Buffer.alloc(this.api.pointerBytes === 8 ? 144 : 112);
      limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway/UI restrictions.
      checked(this.api.set(this.handle, 9, limits, limits.length), "Set Job kill-on-close", this.api);
      this.hub = hub ??= new CompletionHub(this.api);
      this.key = this.hub.add(this);
    } catch (error) {
      this.api.close(this.handle);
      if (this.hub && !this.hub.entries.size) this.hub.wait();
      throw error;
    }
  }
  accounting() {
    const accounting = Buffer.alloc(48);
    checked(this.api.query(this.handle, 1, accounting, accounting.length, null), "Query Job process accounting", this.api);
    return { total: accounting.readUInt32LE(36), active: accounting.readUInt32LE(40) };
  }
  activeCount() { return this.closed ? 0 : this.accounting().active; }
  noteFailure(error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
  unconfirmed(error) { this.observationFailure ??= error instanceof Error ? error : new Error(String(error)); this.noteFailure(this.observationFailure); }
  memberIds() {
    let capacity = 16;
    for (;;) {
      const information = Buffer.alloc(8 + capacity * this.api.pointerBytes);
      const result = this.api.query(this.handle, 3, information, information.length, null);
      if (!result) {
        const error = this.api.error();
        if (error !== 234) throw new Error(`Query Job member identities failed (Windows error ${error}).`);
        capacity = Math.max(capacity * 2, information.readUInt32LE(0));
        continue;
      }
      const count = information.readUInt32LE(4), ids = [];
      for (let index = 0; index < count; index++) ids.push(this.api.pointerBytes === 8
        ? Number(information.readBigUInt64LE(8 + index * 8)) : information.readUInt32LE(8 + index * 4));
      return ids;
    }
  }
  captureMembers() {
    // Only a current exact-Job snapshot authorizes an acquisition. A historical
    // accounting total or completion-port PID is never a process identity.
    const before = this.accounting();
    const ids = new Set([...this.memberIds(), ...this.captureFailures.keys()]);
    for (const id of ids) {
      const handle = this.api.openProcess(0x100400, 0, id);
      if (!handle) {
        const error = this.api.error();
        // The snapshot-to-open exit race is terminal only when the PID no
        // longer exists and a fresh exact-Job snapshot also has no such member.
        if (error === 87 && !this.memberIds().includes(id)) { this.captureFailures.delete(id); continue; }
        const failure = new Error(`Original Job member handle could not be acquired (Windows error ${error}); exit remains unconfirmed.`);
        this.captureFailures.set(id, failure); this.noteFailure(failure); continue;
      }
      let retained = false;
      try {
        const member = [0], creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
        if (this.api.processId(handle) !== id) throw new Error("Job member identity changed before its original handle was acquired.");
        checked(this.api.processTimes(handle, creation, exit, kernel, user), "Read original process creation identity", this.api);
        const identity = `${id}:${creation.readBigUInt64LE()}`;
        checked(this.api.processInJob(handle, this.handle, member), "Verify original process Job", this.api);
        if (!member[0]) {
          // A known original identity remains governed by its held HANDLE even
          // after membership removal. A reused foreign handle is never retained
          // or waited on. Without a prior identity, only actual HANDLE signal is
          // terminal; absence from a fresh PID list alone is not exit evidence.
          const originalHeld = this.members.has(identity) || [...this.members.values()].some(original => original.id === id);
          if (originalHeld || (this.api.waitProcess(handle, 0) === 0 && !this.memberIds().includes(id))) {
            this.captureFailures.delete(id); continue;
          }
          throw new Error("Snapshot member no longer has a provable original Job identity; exit remains unconfirmed.");
        }
        if (!this.members.has(identity)) { this.members.set(identity, { handle, id, creation: creation.readBigUInt64LE().toString() }); retained = true; }
        this.captureFailures.delete(id);
      } catch (error) { this.captureFailures.set(id, error); this.noteFailure(error); }
      finally { if (!retained) checked(this.api.close(handle), "Close duplicate/unowned process handle", this.api); }
    }
    this.observationFailure = this.captureFailures.values().next().value;
    return { before, after: this.accounting() };
  }
  collectSignalledMembers() {
    let pending;
    for (const [identity, member] of this.members) {
      // Never close a handle while its original native wait is still outstanding.
      if (member.handle === this.waitingHandle) { pending ??= member; continue; }
      const result = this.api.waitProcess(member.handle, 0);
      if (result === 0) {
        checked(this.api.close(member.handle), "Close confirmed exited Job member", this.api);
        this.members.delete(identity); this.confirmedMembers++;
      } else if (result === 258) pending ??= member;
      else throw new Error(`Original process exit could not be confirmed (Windows wait ${result}).`);
    }
    return pending;
  }
  waitForOriginalMember(member) {
    if (this.waitingHandle || this.closed) return;
    this.waitingHandle = member.handle;
    try {
      // A single in-flight wait belongs to this Job. It does not poll, sleep or
      // extend the Registry's existing absolute termination deadline.
      this.api.waitProcess.async(member.handle, 0xffffffff, (error, result) => {
        this.waitingHandle = undefined;
        if (error || result !== 0) { this.unconfirmed(error ?? new Error(`Original process wait failed (${result}).`)); return; }
        this.refresh();
      });
    } catch (error) { this.waitingHandle = undefined; this.unconfirmed(error); }
  }
  admittedByBootstrap() { this.admitted = true; this.refresh(); }
  rootDidClose() { this.rootClosed = true; this.refresh(); }
  refresh() {
    if (this.closed || (!this.admitted && !this.rootClosed)) return;
    try {
      const snapshot = this.captureMembers();
      const pending = this.collectSignalledMembers();
      if (snapshot.after.active !== 0) return;
      // Current Job emptiness and all acquired original HANDLEs are separate
      // requirements. Historical totals are diagnostics, never a blanket gate
      // against already-exited short-lived members or proof of complete capture.
      if (this.observationFailure) return;
      if (pending) { this.waitForOriginalMember(pending); return; }
      checked(this.api.close(this.handle), "Close confirmed empty Job with signalled original members", this.api);
      this.closed = true;
      this.hub.remove(this.key);
      this.resolveSettled();
    } catch (error) { this.unconfirmed(error); }
  }
  terminate() {
    if (this.closed) return;
    try {
      const snapshot = this.captureMembers();
      this.terminationSnapshot = snapshot.after.total;
    } catch (error) { this.unconfirmed(error); }
    // A capture failure must still attempt cleanup, but never authorizes release.
    checked(this.api.terminate(this.handle, 1), "TerminateJobObject", this.api);
    this.refresh();
  }
  abandonUnstarted() { this.rootDidClose(); }
}

/** Uses the calling bootstrap's pseudo-handle, never a PID obtained from elsewhere. */
export function joinCurrentProcessToJob(name) {
  const api = bindings();
  const borrowed = checked(api.open(1, 0, name), "Open protected process Job", api);
  try { checked(api.assign(borrowed, api.currentProcess()), "Assign current bootstrap to Job", api); }
  finally { checked(api.close(borrowed), "Close borrowed Job handle", api); }
}
