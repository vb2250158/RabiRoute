import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import test from "node:test";
import { ProcessLeaseRegistry, type ProcessLeaseOwner } from "./processLeaseRegistry.js";

function owner(instanceId: string): ProcessLeaseOwner {
  return {
    applicationGenerationId: "app-one",
    managerInstanceId: "manager-one",
    activationId: `activation-${instanceId}`,
    instanceId,
    revision: "one"
  };
}

function longRunningChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

test("ProcessLeaseRegistry isolates owners and blocks launches while quiescing", async t => {
  const registry = new ProcessLeaseRegistry(async child => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  t.after(() => registry.disposeAll());
  const left = owner("left");
  const right = owner("right");
  registry.launch(left, "worker", longRunningChild);
  registry.launch(right, "worker", longRunningChild);
  assert.equal(registry.list().length, 2);
  await registry.terminateOwner(left);
  assert.equal(registry.list(left).length, 0);
  assert.equal(registry.list(right).length, 1);
  assert.throws(() => registry.launch(left, "again", longRunningChild), /quiescing/);
  registry.releaseOwner(left);
  const relaunched = registry.launch(left, "again", longRunningChild);
  assert.equal(relaunched.owner.instanceId, "left");
});

test("ProcessLeaseRegistry drain reports timeout without killing a child", async t => {
  const registry = new ProcessLeaseRegistry(async child => { if (child.exitCode === null) child.kill("SIGKILL"); });
  t.after(() => registry.disposeAll());
  const target = owner("drain");
  registry.launch(target, "worker", longRunningChild);
  assert.equal(await registry.drainOwner(target, 20), false);
  assert.equal(registry.list(target).length, 1);
});

test("ProcessLeaseRegistry bounds termination when force-kill never produces an exit event", async () => {
  const child = new EventEmitter() as ReturnType<typeof longRunningChild>;
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true
  });
  const registry = new ProcessLeaseRegistry(async () => { throw new Error("taskkill failed"); }, {
    terminationTimeoutMs: 20
  });
  const target = owner("no-exit");
  registry.launch(target, "worker", () => child);

  await assert.rejects(registry.terminateOwner(target), /did not exit within 20ms/);
  assert.equal(registry.list(target).length, 1);
});

test("a child error without a confirmed exit keeps its exclusive lease", async () => {
  const child = new EventEmitter() as ReturnType<typeof longRunningChild>;
  Object.assign(child, {
    pid: 4244,
    exitCode: null,
    signalCode: null,
    kill: () => true
  });
  const registry = new ProcessLeaseRegistry(async () => {}, { terminationTimeoutMs: 20 });
  const first = owner("wearable-error-old");
  const second = owner("wearable-error-new");
  const lease = registry.launch(first, "wearable-companion-worker", () => child, {
    exclusiveAcrossOwners: true
  });
  let settled = false;
  void lease.settled.then(() => { settled = true; });

  child.emit("error", new Error("kill EPERM"));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(registry.list().length, 1);
  assert.throws(
    () => registry.launch(second, "wearable-companion-worker", longRunningChild, {
      exclusiveAcrossOwners: true
    }),
    /Exclusive process lease is already owned/
  );

  Object.assign(child, { exitCode: 0 });
  child.emit("exit", 0);
  await lease.settled;
  assert.equal(registry.list().length, 0);
});

test("a pidless asynchronous spawn error is observed without crashing Manager", async () => {
  const child = new EventEmitter() as ReturnType<typeof longRunningChild>;
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => false
  });
  const registry = new ProcessLeaseRegistry(async child => { child.kill(); });

  assert.throws(
    () => registry.launch(owner("spawn-error"), "worker", () => child),
    /did not publish a PID/
  );
  assert.equal(registry.list().length, 0);
  assert.doesNotThrow(() => child.emit("error", new Error("spawn EACCES")));
  await new Promise(resolve => setImmediate(resolve));
});

test("a real missing executable reports a pidless spawn failure without an unhandled error", async () => {
  const registry = new ProcessLeaseRegistry(async child => { child.kill(); });
  let child: ReturnType<typeof spawn> | undefined;

  assert.throws(() => registry.launch(owner("real-spawn-error"), "worker", () => {
    child = spawn(path.join(process.cwd(), "missing-rabiroute-worker", "worker.exe"), [], { stdio: "ignore" });
    return child;
  }), /did not publish a PID/);
  assert.ok(child);
  await new Promise<void>(resolve => child!.once("close", () => resolve()));
  assert.equal(registry.list().length, 0);
});

test("exclusive process keys cannot overlap across plugin activations", async () => {
  const registry = new ProcessLeaseRegistry(async child => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const first = owner("wearable-old");
  const second = owner("wearable-new");
  registry.launch(first, "wearable-companion-worker", longRunningChild, { exclusiveAcrossOwners: true });
  assert.throws(
    () => registry.launch(second, "wearable-companion-worker", longRunningChild, { exclusiveAcrossOwners: true }),
    /Exclusive process lease is already owned/
  );
  assert.equal(registry.list().length, 1);
  await registry.disposeAll();
});

test("a rejected stop can be retried by final Manager disposal", async () => {
  const child = new EventEmitter() as ReturnType<typeof longRunningChild>;
  Object.assign(child, {
    pid: 4243,
    exitCode: null,
    signalCode: null,
    kill: () => true
  });
  let stopAttempts = 0;
  const registry = new ProcessLeaseRegistry(async candidate => {
    stopAttempts += 1;
    if (stopAttempts === 1) throw new Error("first process-tree stop failed");
    Object.assign(candidate, { exitCode: 0 });
    candidate.emit("exit", 0);
  }, { terminationTimeoutMs: 20 });
  const target = owner("retry-stop");
  registry.launch(target, "worker", () => child);

  await assert.rejects(registry.terminateOwner(target), /did not exit within 20ms/);
  await registry.disposeAll();

  assert.equal(stopAttempts, 2);
  assert.equal(registry.list().length, 0);
});


test("Windows Job retirement confirms the original descendant HANDLE before releasing its lease", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const fs = await import("node:fs/promises"), os = await import("node:os"), { createRequire } = await import("node:module");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "process-lease-native-handle-"));
  const entry = path.join(directory, "business.mjs"), registry = new ProcessLeaseRegistry(), target = owner("original-handle");
  const kernel = createRequire(import.meta.url)("koffi").load("kernel32.dll");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)");
  const openJob = kernel.func("void * __stdcall OpenJobObjectW(uint32_t, int, str16)");
  const inJob = kernel.func("int __stdcall IsProcessInJob(void *, void *, _Out_ int *)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)");
  const close = kernel.func("int __stdcall CloseHandle(void *)");
  let leafHandle: unknown, jobHandle: unknown;
  t.after(async () => { await registry.disposeAll(); if (leafHandle) { assert.equal(wait(leafHandle, 5000), 0); close(leafHandle); } if (jobHandle) close(jobHandle); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(entry, "import {spawn} from 'node:child_process';const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});leaf.unref();process.send({leaf:leaf.pid});process.on('message',m=>{if(m==='exit-root')process.exit(0)});");
  const lease = registry.launch(target, "native-descendant", { kind: "fork", entry, options: { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] } }, { exclusiveAcrossOwners: true });
  const [ready] = await once(lease.child, "message");
  leafHandle = open(0x100400, 0, ready.leaf); assert.ok(leafHandle); assert.ok(lease.tree);
  jobHandle = openJob(4, 0, lease.tree.name); assert.ok(jobHandle); const member = [0]; assert.ok(inJob(leafHandle, jobHandle, member)); assert.equal(member[0], 1);
  const closed = once(lease.child, "close"); lease.child.send!("exit-root"); await closed;
  assert.equal(wait(leafHandle, 0), 258); assert.equal(registry.list().length, 1);
  const terminate = lease.tree.terminate;
  lease.tree.terminate = () => { throw new Error("controlled original Job stop failure"); };
  try { await assert.rejects(registry.terminateOwner(target), /controlled original Job stop failure/); assert.equal(registry.list().length, 1); assert.throws(() => registry.releaseOwner(target), /still has active children/); }
  finally { lease.tree.terminate = terminate; }
  await registry.disposeAll();
  assert.equal(wait(leafHandle, 0), 0, "Accounting zero or a later five-second wait is not the release-time process-exit barrier.");
  assert.equal(registry.list().length, 0); assert.equal(lease.tree.closed, true); assert.equal(lease.tree.activeCount(), 0);
});

test("Windows leases preserve fast natural exits and multiple short-lived descendants", { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const fs = await import("node:fs/promises"), os = await import("node:os");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "process-lease-short-lived-"));
  const registry = new ProcessLeaseRegistry();
  t.after(async () => { await registry.disposeAll(); await fs.rm(directory, { recursive: true, force: true }); });
  const fast = path.join(directory, "fast.mjs"); await fs.writeFile(fast, "export const done=true;");
  for (let index = 0; index < 3; index++) {
    const lease = registry.launch(owner("short-fork-" + index), "fast", { kind: "fork", entry: fast, options: { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] } });
    await lease.settled; assert.equal(registry.list().length, 0);
  }
  for (let index = 0; index < 3; index++) {
    const lease = registry.launch(owner("short-spawn-" + index), "fast", { kind: "spawn", command: process.execPath, args: ["-e", "process.exit(0)"], options: { stdio: "ignore", windowsHide: true } });
    await lease.settled; assert.equal(registry.list().length, 0);
  }
  const many = path.join(directory, "many.mjs");
  await fs.writeFile(many, "import {spawn} from 'node:child_process';import {once} from 'node:events';await Promise.all(Array.from({length:12},async()=>{const c=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});await once(c,'close')}));");
  const lease = registry.launch(owner("short-descendants"), "many", { kind: "fork", entry: many, options: { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] } });
  await lease.settled; assert.equal(registry.list().length, 0);
});
