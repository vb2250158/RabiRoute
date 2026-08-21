import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManualTriggerProcessRegistry } from "./manualTriggerProcess.js";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: () => boolean;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null as number | null,
    kill: () => true
  });
}

function exitChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit("exit", code, null);
}

test("manual trigger acceptance does not wait for the delivery child to exit", () => {
  const registry = new ManualTriggerProcessRegistry();
  const child = fakeChild();
  let starts = 0;

  const first = registry.launch("route:heartbeat", () => {
    starts += 1;
    return child as unknown as ChildProcess;
  });

  assert.deepEqual(first, { accepted: true, alreadyRunning: false });
  assert.equal(registry.isRunning("route:heartbeat"), true);
  assert.equal(starts, 1);

  const duplicate = registry.launch("route:heartbeat", () => {
    starts += 1;
    return fakeChild() as unknown as ChildProcess;
  });
  assert.deepEqual(duplicate, { accepted: true, alreadyRunning: true });
  assert.equal(starts, 1);

  exitChild(child);
  assert.equal(registry.isRunning("route:heartbeat"), false);
});

test("manual trigger child output and terminal failure remain observable after acceptance", () => {
  const registry = new ManualTriggerProcessRegistry();
  const child = fakeChild();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: Array<[number | null, NodeJS.Signals | null]> = [];

  registry.launch("route:manual", () => child as unknown as ChildProcess, {
    onStdout: (text) => stdout.push(text),
    onStderr: (text) => stderr.push(text),
    onExit: (code, signal) => exits.push([code, signal])
  });

  child.stdout.emit("data", Buffer.from("accepted\n"));
  child.stderr.emit("data", Buffer.from("delivery failed\n"));
  exitChild(child, 1);

  assert.deepEqual(stdout, ["accepted\n"]);
  assert.deepEqual(stderr, ["delivery failed\n"]);
  assert.deepEqual(exits, [[1, null]]);
  assert.equal(registry.isRunning("route:manual"), false);
});

test("stopping gateway runtime waits for its children and preserves memory consolidation", async () => {
  const stopped: FakeChild[] = [];
  const registry = new ManualTriggerProcessRegistry(async child => {
    stopped.push(child as unknown as FakeChild);
  });
  const gateway = fakeChild();
  const memory = fakeChild();
  registry.launch("route:manual", () => gateway as unknown as ChildProcess);
  registry.launchOwned("manager:memory-consolidation", "route:memory", () => memory as unknown as ChildProcess);

  let stopSettled = false;
  const stopping = registry.stopOwner("manager:gateway-runtime").then(() => { stopSettled = true; });
  await Promise.resolve();

  assert.deepEqual(stopped, [gateway]);
  assert.equal(stopSettled, false);
  assert.equal(registry.isRunning("route:manual"), true);
  assert.equal(registry.isRunning("route:memory"), true);

  exitChild(gateway);
  await stopping;

  assert.equal(registry.isRunning("route:manual"), false);
  assert.equal(registry.isRunning("route:memory"), true);
  exitChild(memory);
});

test("draining one owner waits for natural exits without stopping either owner", async () => {
  const stopped: FakeChild[] = [];
  const registry = new ManualTriggerProcessRegistry(async child => {
    stopped.push(child as unknown as FakeChild);
  });
  const gateway = fakeChild();
  const memory = fakeChild();
  registry.launch("route:manual", () => gateway as unknown as ChildProcess);
  registry.launchOwned("manager:memory-consolidation", "route:memory", () => memory as unknown as ChildProcess);

  let drainSettled = false;
  const draining = registry.drainOwner("manager:gateway-runtime").then(() => { drainSettled = true; });
  await Promise.resolve();

  assert.equal(drainSettled, false);
  assert.deepEqual(stopped, []);
  assert.equal(registry.isRunning("route:memory"), true);

  exitChild(gateway);
  await draining;

  assert.equal(drainSettled, true);
  assert.deepEqual(stopped, []);
  assert.equal(registry.isRunning("route:memory"), true);
  exitChild(memory);
});

test("an owner cannot launch new children while its stop is draining", async () => {
  const registry = new ManualTriggerProcessRegistry(async () => {});
  const gateway = fakeChild();
  const memory = fakeChild();
  registry.launch("route:manual", () => gateway as unknown as ChildProcess);

  const stopping = registry.stopOwner("manager:gateway-runtime");
  await Promise.resolve();

  assert.throws(
    () => registry.launchOwned(
      "manager:gateway-runtime",
      "route:other",
      () => fakeChild() as unknown as ChildProcess
    ),
    /manager:gateway-runtime.*stopping or draining/
  );
  assert.deepEqual(
    registry.launchOwned(
      "manager:memory-consolidation",
      "route:memory",
      () => memory as unknown as ChildProcess
    ),
    { accepted: true, alreadyRunning: false }
  );

  exitChild(gateway);
  await stopping;

  const replacement = fakeChild();
  assert.deepEqual(
    registry.launchOwned(
      "manager:gateway-runtime",
      "route:other",
      () => replacement as unknown as ChildProcess
    ),
    { accepted: true, alreadyRunning: false }
  );
  exitChild(replacement);
  exitChild(memory);
});

test("a process key cannot silently transfer between plugin owners", () => {
  const registry = new ManualTriggerProcessRegistry();
  const gateway = fakeChild();
  let memoryStarts = 0;
  registry.launchOwned("manager:gateway-runtime", "route:shared", () => gateway as unknown as ChildProcess);

  assert.throws(
    () => registry.launchOwned("manager:memory-consolidation", "route:shared", () => {
      memoryStarts += 1;
      return fakeChild() as unknown as ChildProcess;
    }),
    /already owned by 'manager:gateway-runtime'/
  );
  assert.equal(memoryStarts, 0);
  assert.equal(registry.isRunning("route:shared"), true);

  exitChild(gateway);
});

test("owned launch rejects a blank owner", () => {
  const registry = new ManualTriggerProcessRegistry();
  assert.throws(
    () => registry.launchOwned("  ", "route:manual", () => fakeChild() as unknown as ChildProcess),
    /owner is required/
  );
});
