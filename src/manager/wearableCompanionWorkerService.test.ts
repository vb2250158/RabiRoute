import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { PluginIdentity } from "../plugin-kernel/index.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import type { WearableCompanionRuntimeIdentity } from "./wearableCompanionRuntimeIdentity.js";
import { WearableCompanionWorkerService } from "./wearableCompanionWorkerService.js";

class FakeChild extends EventEmitter {
  constructor(readonly pid = 43120) { super(); }
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeScheduler() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  const observedDelays: number[] = [];
  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number) {
      const id = ++sequence;
      timers.set(id, { callback, delayMs });
      observedDelays.push(delayMs);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer as unknown as number);
    },
    runNext() {
      const next = timers.entries().next().value as [number, Readonly<{ callback: () => void; delayMs: number }>] | undefined;
      assert.ok(next, "a retry timer must be pending");
      timers.delete(next[0]);
      now += next[1].delayMs;
      next[1].callback();
    },
    pending: () => timers.size,
    observedDelays
  };
}

const identity: PluginIdentity = Object.freeze({
  applicationGenerationId: "app-generation-7",
  managerInstanceId: "manager-instance-4",
  activationId: "activation-3",
  instanceId: "manager:wearable-companion",
  pluginId: "io.rabiroute.manager.wearable-companion",
  version: "1.0.0",
  revision: "revision-2",
  host: "manager"
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-wearable-worker-"));
  const pwshPath = path.join(root, "pwsh.exe");
  const resourceRoot = path.join(root, "package", "resources");
  fs.mkdirSync(resourceRoot, { recursive: true });
  fs.writeFileSync(pwshPath, "fixture");
  fs.writeFileSync(path.join(resourceRoot, "Start-RabiLinkWearableCompanion.ps1"), "# fixture");
  const runtime: WearableCompanionRuntimeIdentity = Object.freeze({
    schemaVersion: 1,
    hostOwned: true,
    managerBaseUrl: "http://127.0.0.1:13486",
    applicationGenerationId: identity.applicationGenerationId,
    managerInstanceId: identity.managerInstanceId,
    runtimeRoot: root,
    stateRoot: path.join(root, "data", "wearable-companion"),
    logRoot: path.join(root, "logs", "wearable-companion"),
    pwshPath,
    environment: Object.freeze({ SystemRoot: "C:\\Windows", PATH: "C:\\Program Files\\PowerShell\\7" })
  });
  return { root, resourceRoot, runtime };
}

function deferredReady() {
  let resolve = (): void => {};
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

test("Manager directly owns the wearable worker lease and dispose removes it", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const child = new FakeChild();
    let launched: Readonly<{ file: string; args: readonly string[]; options: SpawnOptions }> | undefined;
    const registry = new ProcessLeaseRegistry(async candidate => {
      const fake = candidate as unknown as FakeChild;
      fake.exitCode = 0;
      fake.emit("exit", 0);
    });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn(file, args, options) {
        launched = { file, args: [...args], options };
        return child as unknown as ChildProcess;
      }
    });

    const handle = service.launch(identity, pathToFileURL(`${resourceRoot}${path.sep}`).href, { roleId: "YeYu", serial: "device-7" });
    assert.equal(handle.state, "managed");
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.owner.activationId, identity.activationId);
    assert.equal(launched?.file, runtime.pwshPath);
    assert.equal(launched?.options.detached, false);
    assert.equal(launched?.options.cwd, runtime.runtimeRoot);
    assert.deepEqual((launched?.options.env as Record<string, string>)?.RABIROUTE_PLUGIN_APP_GENERATION_ID, identity.applicationGenerationId);
    const commandLine = launched?.args.join(" ") ?? "";
    assert.match(commandLine, /http:\/\/127\.0\.0\.1:13486/);
    assert.match(commandLine, /app-generation-7/);
    assert.match(commandLine, /manager-instance-4/);
    assert.doesNotMatch(commandLine, /879[0-9]/);

    await handle.dispose();
    assert.equal(registry.list().length, 0);
    assert.equal(await handle.failure, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent dispose calls share one termination attempt", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const child = new FakeChild(43121);
    let stopAttempts = 0;
    const registry = new ProcessLeaseRegistry(async candidate => {
      stopAttempts += 1;
      await new Promise(resolve => setImmediate(resolve));
      const fake = candidate as unknown as FakeChild;
      fake.exitCode = 0;
      fake.emit("exit", 0);
    });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => child as unknown as ChildProcess
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    const firstDispose = handle.dispose();
    const concurrentDispose = handle.dispose();

    assert.strictEqual(concurrentDispose, firstDispose);
    await Promise.all([firstDispose, concurrentDispose]);
    assert.equal(stopAttempts, 1);
    assert.equal(registry.list().length, 0);
    assert.equal(await handle.failure, undefined);
    assert.strictEqual(handle.dispose(), firstDispose);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected worker crashes respawn with bounded backoff and keep terminal failure one-shot", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const scheduler = fakeScheduler();
    const children: FakeChild[] = [];
    const registry = new ProcessLeaseRegistry();
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(43120 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    for (let crash = 0; crash < 4; crash += 1) {
      const child = children.at(-1)!;
      child.exitCode = 21;
      child.emit("exit", 21);
      assert.equal(registry.list().length, 0);
      if (crash < 3) {
        assert.equal(scheduler.pending(), 1);
        scheduler.runNext();
        assert.equal(registry.list().length, 1);
      }
    }

    const terminalFailure = await handle.failure;
    assert.deepEqual(scheduler.observedDelays, [5_000, 10_000, 20_000]);
    assert.match(terminalFailure?.message ?? "", /exhausted 3 retries.*code 21/);
    assert.equal(children.length, 4);
    assert.equal(registry.list().length, 0);

    await handle.dispose();
    const terminalChild = children.at(-1)!;
    assert.doesNotThrow(() => terminalChild.emit("error", new Error("late worker error")));
    terminalChild.emit("exit", 21);
    terminalChild.emit("close", 21);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(await handle.failure, terminalFailure);
    assert.equal(scheduler.pending(), 0);
    assert.equal(children.length, 4);
    assert.equal(registry.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dispose during retry backoff cancels respawn", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const scheduler = fakeScheduler();
    const children: FakeChild[] = [];
    const registry = new ProcessLeaseRegistry();
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(44120 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });
    children[0]!.exitCode = 21;
    children[0]!.emit("exit", 21);
    assert.equal(scheduler.pending(), 1);

    await handle.dispose();

    assert.equal(scheduler.pending(), 0);
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 0);
    assert.equal(await handle.failure, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing pwsh degrades without spawning or acquiring a lease", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const registry = new ProcessLeaseRegistry();
    let spawned = false;
    const service = new WearableCompanionWorkerService(Object.freeze({
      ...runtime,
      pwshPath: undefined,
      unavailableReason: "PowerShell 7 is unavailable."
    }), registry, {
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      }
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    assert.equal(handle.state, "degraded");
    assert.equal(spawned, false);
    assert.equal(registry.list().length, 0);
    await handle.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Host READY gate prevents any worker lease before publication", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const ready = deferredReady();
    const registry = new ProcessLeaseRegistry(async candidate => {
      const child = candidate as unknown as FakeChild;
      child.exitCode = 0;
      child.emit("exit", 0);
    });
    let spawnCount = 0;
    const service = new WearableCompanionWorkerService(runtime, registry, {
      startupReady: ready.promise,
      spawn: () => {
        spawnCount += 1;
        return new FakeChild() as unknown as ChildProcess;
      }
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    assert.equal(handle.state, "managed");
    assert.equal(spawnCount, 0);
    assert.equal(registry.list().length, 0);
    ready.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(spawnCount, 1);
    assert.equal(registry.list().length, 1);
    await handle.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disposing before Host READY permanently cancels the pending worker", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const ready = deferredReady();
    const registry = new ProcessLeaseRegistry();
    let spawned = false;
    const service = new WearableCompanionWorkerService(runtime, registry, {
      startupReady: ready.promise,
      spawn: () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      }
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    await handle.dispose();
    ready.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(spawned, false);
    assert.equal(registry.list().length, 0);
    assert.equal(await handle.failure, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin generation handoff never overlaps wearable worker leases", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const children: FakeChild[] = [];
    const registry = new ProcessLeaseRegistry(async candidate => {
      const child = candidate as unknown as FakeChild;
      child.exitCode = 0;
      child.emit("exit", 0);
    });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(45120 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      }
    });
    const replacementIdentity = Object.freeze({
      ...identity,
      activationId: "activation-4",
      revision: "revision-3"
    });
    const oldHandle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });
    const newHandle = service.launch(replacementIdentity, resourceRoot, { roleId: "YeYu", serial: "" });

    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    await oldHandle.dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.owner.activationId, replacementIdentity.activationId);
    await newHandle.dispose();
    assert.equal(registry.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live-child error cannot release the wearable lease or start a replacement", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const scheduler = fakeScheduler();
    const children: FakeChild[] = [];
    const registry = new ProcessLeaseRegistry(async () => {}, { terminationTimeoutMs: 10 });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(45620 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      handoffTimeoutMs: 20,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });
    const replacementIdentity = Object.freeze({
      ...identity,
      activationId: "activation-error-replacement",
      revision: "revision-error-replacement"
    });
    const oldHandle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    children[0]!.emit("error", new Error("kill EPERM"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(registry.list().length, 1);
    assert.equal(children.length, 1);
    assert.equal(scheduler.pending(), 0);

    const newHandle = service.launch(replacementIdentity, resourceRoot, { roleId: "YeYu", serial: "" });
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    await assert.rejects(oldHandle.dispose(), /did not exit within 10ms/);
    scheduler.runNext();
    assert.match((await newHandle.failure)?.message ?? "", /predecessor did not release/);
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);

    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0);
    assert.equal(registry.list().length, 0);
    await newHandle.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed handle dispose retains its lease and retries the same child", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const child = new FakeChild(45820);
    let stopAttempts = 0;
    const registry = new ProcessLeaseRegistry(async candidate => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("first process-tree stop failed");
      const fake = candidate as unknown as FakeChild;
      fake.exitCode = 0;
      fake.emit("exit", 0);
    }, { terminationTimeoutMs: 10 });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => child as unknown as ChildProcess
    });
    const handle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });

    await assert.rejects(handle.dispose(), /did not exit within 10ms/);
    assert.equal(stopAttempts, 1);
    assert.equal(registry.list().length, 1);

    await handle.dispose();
    assert.equal(stopAttempts, 2);
    assert.equal(registry.list().length, 0);
    assert.equal(await handle.failure, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a retried dispose releases a waiting replacement before the handoff deadline", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const scheduler = fakeScheduler();
    const children: FakeChild[] = [];
    let stopAttempts = 0;
    const registry = new ProcessLeaseRegistry(async candidate => {
      stopAttempts += 1;
      const fake = candidate as unknown as FakeChild;
      if (fake === children[0] && stopAttempts === 1) {
        throw new Error("first process-tree stop failed");
      }
      fake.exitCode = 0;
      fake.emit("exit", 0);
    }, { terminationTimeoutMs: 10 });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(45920 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      handoffTimeoutMs: 20,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });
    const replacementIdentity = Object.freeze({
      ...identity,
      activationId: "activation-retry-replacement",
      revision: "revision-retry-replacement"
    });
    const oldHandle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });
    const newHandle = service.launch(replacementIdentity, resourceRoot, { roleId: "YeYu", serial: "" });

    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    assert.equal(scheduler.pending(), 1);
    await assert.rejects(oldHandle.dispose(), /did not exit within 10ms/);
    assert.equal(stopAttempts, 1);
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    assert.equal(scheduler.pending(), 1);

    await oldHandle.dispose();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(stopAttempts, 2);
    assert.equal(await oldHandle.failure, undefined);
    assert.equal(children.length, 2);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.owner.activationId, replacementIdentity.activationId);
    assert.equal(scheduler.pending(), 0);

    await newHandle.dispose();
    assert.equal(stopAttempts, 3);
    assert.equal(registry.list().length, 0);
    assert.equal(await newHandle.failure, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed predecessor termination never publishes a second wearable worker", async () => {
  const { root, resourceRoot, runtime } = fixture();
  try {
    const scheduler = fakeScheduler();
    const children: FakeChild[] = [];
    const registry = new ProcessLeaseRegistry(async () => {}, { terminationTimeoutMs: 10 });
    const service = new WearableCompanionWorkerService(runtime, registry, {
      spawn: () => {
        const child = new FakeChild(46120 + children.length);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      handoffTimeoutMs: 20,
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer
    });
    const replacementIdentity = Object.freeze({
      ...identity,
      activationId: "activation-5",
      revision: "revision-4"
    });
    const oldHandle = service.launch(identity, resourceRoot, { roleId: "YeYu", serial: "" });
    const newHandle = service.launch(replacementIdentity, resourceRoot, { roleId: "YeYu", serial: "" });

    await assert.rejects(oldHandle.dispose(), /did not exit within 10ms/);
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    scheduler.runNext();
    assert.match((await newHandle.failure)?.message ?? "", /predecessor did not release/);
    assert.equal(children.length, 1);
    assert.equal(registry.list().length, 1);
    await newHandle.dispose();
    children[0]!.exitCode = 0;
    children[0]!.emit("exit", 0);
    assert.equal(registry.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
