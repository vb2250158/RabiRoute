import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
  const registry = new ProcessLeaseRegistry();

  assert.throws(
    () => registry.launch(owner("spawn-error"), "worker", () => child),
    /did not publish a PID/
  );
  assert.equal(registry.list().length, 0);
  assert.doesNotThrow(() => child.emit("error", new Error("spawn EACCES")));
  await new Promise(resolve => setImmediate(resolve));
});

test("a real missing executable reports a pidless spawn failure without an unhandled error", async () => {
  const registry = new ProcessLeaseRegistry();
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
