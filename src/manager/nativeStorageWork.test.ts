import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureNativeStorageWork, withoutNativeStorageWork } from "./nativeStorageWork.js";
import { ManagerReadWorkerPool, type ManagerReadWorkerChild } from "./managerReadWorkerPool.js";
import { ManagerStorageMutationPool, type ManagerStorageMutationChild } from "./managerStorageMutationPool.js";
import { PlanPageCatalogLifecycle } from "./planPageCatalogLifecycle.js";

class ControlledChild extends EventEmitter implements ManagerReadWorkerChild, ManagerStorageMutationChild {
  readonly pid = 58_271;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly channel = { unref() {} };
  sent?: any;
  onSend?: (message: any) => void;
  constructor(private readonly autoReady = true) { super(); }
  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "message" && this.autoReady) queueMicrotask(() => this.emit("message", { type: "ready" }));
    return this;
  }
  send(message: unknown, callback?: (error: Error | null) => void): boolean { this.sent = message; this.onSend?.(message); callback?.(null); return true; }
  kill(): boolean { return true; }
  disconnect(): void { this.connected = false; }
  unref(): void {}
  close(): void { if (this.exitCode !== null) return; this.exitCode = 0; this.connected = false; this.emit("close", 0, null); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function readPool(child: ControlledChild) {
  return new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 100, terminationTimeoutMs: 5, forceTerminationTimeoutMs: 5, workerFactory: () => child, setWorkerPriority: () => {} });
}

test("read result deadline is independent of actual native worker release", async t => {
  const child = new ControlledChild(), pool = readPool(child);
  t.after(async () => { child.close(); await pool.stop(); });
  const work = captureNativeStorageWork(() => pool.run({ type: "role_directories", rolesRoot: os.tmpdir() }));
  let closed = false; void work.closed.then(() => { closed = true; });
  await assert.rejects(work.result, /termination|exceeded/i); await turn(); assert.equal(closed, false);
  child.close(); await work.closed; assert.equal(closed, true);
});

test("each shared read subscriber joins the same actual worker even after timeout", async t => {
  const child = new ControlledChild(), pool = readPool(child);
  t.after(async () => { child.close(); await pool.stop(); });
  const first = captureNativeStorageWork(() => pool.queryRoleFileCounts(os.tmpdir()));
  const second = captureNativeStorageWork(() => pool.queryRoleFileCounts(os.tmpdir()));
  let closures = 0; void first.closed.then(() => closures++); void second.closed.then(() => closures++);
  await Promise.all([assert.rejects(first.result), assert.rejects(second.result)]); await turn(); assert.equal(closures, 0);
  child.close(); await Promise.all([first.closed, second.closed]); assert.equal(closures, 2);
});

test("resident catalog cancellation joins the actual query job without waiting for idle process close", async t => {
  const child = new ControlledChild(), pool = readPool(child);
  let started!: () => void; const active = new Promise<void>(resolve => { started = resolve; }); child.onSend = () => started();
  const service = new PlanPageCatalogLifecycle<{}, unknown>({ maxRoles: 1, buildTimeoutMs: 1000, create: () => ({ prepare: async () => {}, query: () => pool.run({ type: "role_directories", rolesRoot: os.tmpdir() }), stop: async () => { child.close(); await pool.stop(); } }) });
  t.after(() => service.stop()); await service.prepare(os.tmpdir());
  const abort = new AbortController(), work = captureNativeStorageWork(() => service.query(os.tmpdir(), {}, abort.signal));
  let closed = false; void work.closed.then(() => { closed = true; }); await active; abort.abort();
  await assert.rejects(work.result, /ABORTED/); await turn(); assert.equal(closed, false);
  child.emit("message", { requestId: child.sent.requestId, ok: true, value: { fixture: true } });
  await work.closed; assert.equal(closed, true); assert.equal(child.exitCode, null);
});

test("native mutation quarantine keeps its resource lease until original child close", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-mutation-lifetime-")), child = new ControlledChild(false);
  const pool = new ManagerStorageMutationPool({ rolesRoot: root, applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", storageGenerationLeaseFactory: () => "fixture-lease", timeoutMs: 100, terminationTimeoutMs: 5, forceTerminationTimeoutMs: 5, childFactory: () => child });
  t.after(async () => { child.close(); await pool.stop(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  // Native mutation timers are deliberately unreferenced; this controlled observer keeps the test alive.
  const observer = setInterval(() => {}, 1000); t.after(() => clearInterval(observer));
  const work = captureNativeStorageWork(() => pool.createPlan("Fixture", "plan-one", { title: "Fixture" }, { idempotencyKey: "fixture-create", expectedRevision: null }));
  let closed = false; void work.closed.then(() => { closed = true; });
  await assert.rejects(work.result, /exceeded/i); await turn(); assert.equal(closed, false);
  child.close(); await work.closed; assert.equal(closed, true);
});

test("queued abort releases only its own work and background preparation stays service-owned", async t => {
  const child = new ControlledChild(), pool = readPool(child); t.after(async () => { child.close(); await pool.stop(); });
  const background = withoutNativeStorageWork(() => pool.run({ type: "role_directories", rolesRoot: os.tmpdir() })); void background.catch(() => {});
  const abort = new AbortController(), work = captureNativeStorageWork(() => pool.run({ type: "role_directories", rolesRoot: os.tmpdir() }, { signal: abort.signal }));
  await turn(); abort.abort(); await assert.rejects(work.result); await work.closed;
  assert.equal(child.exitCode, null); child.close(); await background.catch(() => {});
});
