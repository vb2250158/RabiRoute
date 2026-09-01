import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
  ManualTriggerProcessRegistry,
  ManualTriggerTerminationUnconfirmedError
} from "./manualTriggerProcess.js";

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

test("child error without exit does not release the process lease", async () => {
  const events: string[] = [];
  const child = fakeChild();
  const registry = new ManualTriggerProcessRegistry(
    async () => { events.push("graceful"); },
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    {
      terminateTimeoutMs: 5,
      forceKillTimeoutMs: 5,
      forceStopProcess: async () => { events.push("force-tree"); }
    }
  );
  registry.launch("route:error-without-exit", () => child as unknown as ChildProcess, {
    onError: error => events.push(`error:${error.message}`)
  });

  child.emit("error", new Error("kill failed"));

  assert.equal(registry.isRunning("route:error-without-exit"), true);
  await assert.rejects(registry.stopAll(), ManualTriggerTerminationUnconfirmedError);
  assert.deepEqual(events, ["error:kill failed", "graceful", "force-tree"]);
  assert.equal(registry.isRunning("route:error-without-exit"), true);
  assert.throws(
    () => registry.launch("route:new", () => fakeChild() as unknown as ChildProcess),
    /fenced by an unconfirmed child termination/
  );

  exitChild(child, 1);
  assert.equal(registry.isRunning("route:error-without-exit"), false);
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

test("unconfirmed forced termination rejects stop and fences every later launch until exit is observed", async () => {
  const registry = new ManualTriggerProcessRegistry(
    async () => {},
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    { terminateTimeoutMs: 5, forceKillTimeoutMs: 5 }
  );
  const child = fakeChild();
  registry.launch("route:hung", () => child as unknown as ChildProcess);

  await assert.rejects(
    registry.stopAll(),
    (error: unknown) => (error as { code?: string }).code === "manual_trigger_termination_unconfirmed"
  );
  assert.equal(registry.isRunning("route:hung"), true);
  assert.throws(
    () => registry.launch("route:new", () => fakeChild() as unknown as ChildProcess),
    /fenced by an unconfirmed child termination/
  );

  exitChild(child, 1);
  const replacement = fakeChild();
  assert.deepEqual(
    registry.launch("route:new", () => replacement as unknown as ChildProcess),
    { accepted: true, alreadyRunning: false }
  );
  exitChild(replacement);
});

test("registry and entry share one bounded graceful-to-force termination flight", async () => {
  const events: string[] = [];
  const child = fakeChild();
  const registry = new ManualTriggerProcessRegistry(
    async () => { events.push("graceful"); },
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    {
      terminateTimeoutMs: 5,
      forceKillTimeoutMs: 20,
      forceStopProcess: async () => {
        events.push("force-tree");
        exitChild(child, 1);
      }
    }
  );
  registry.launch("route:bounded", () => child as unknown as ChildProcess);

  const first = registry.stopAll();
  const second = registry.stopAll();
  assert.strictEqual(second, first);
  assert.throws(
    () => registry.launch("route:new", () => fakeChild() as unknown as ChildProcess),
    /stopping all processes/
  );
  await first;

  assert.deepEqual(events, ["graceful", "force-tree"]);
  assert.equal(registry.isRunning("route:bounded"), false);
});

test("concurrent owner stops share a flight and unconfirmed termination remains stable", async () => {
  const child = fakeChild();
  const registry = new ManualTriggerProcessRegistry(
    async () => {},
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    {
      terminateTimeoutMs: 5,
      forceKillTimeoutMs: 5,
      forceStopProcess: async () => {}
    }
  );
  registry.launch("route:hung-owner", () => child as unknown as ChildProcess);

  const first = registry.stopOwner(DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER);
  const second = registry.stopOwner(DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER);
  assert.strictEqual(second, first);
  let firstError: unknown;
  await first.catch(error => { firstError = error; });
  assert(firstError instanceof ManualTriggerTerminationUnconfirmedError);

  let repeatedError: unknown;
  await registry.stopOwner(DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER).catch(error => { repeatedError = error; });
  assert.strictEqual(repeatedError, firstError);
  assert.throws(
    () => registry.launch("route:new", () => fakeChild() as unknown as ChildProcess),
    /fenced by an unconfirmed child termination/
  );

  exitChild(child, 1);
  const replacement = fakeChild();
  registry.launch("route:new", () => replacement as unknown as ChildProcess);
  exitChild(replacement);
});

test("child error without confirmed exit stays owned through bounded force termination", async () => {
  const events: string[] = [];
  const child = fakeChild();
  const registry = new ManualTriggerProcessRegistry(
    async () => { events.push("graceful"); },
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    {
      terminateTimeoutMs: 5,
      forceKillTimeoutMs: 20,
      forceStopProcess: async () => {
        events.push("force-tree");
        exitChild(child, 1);
      }
    }
  );
  registry.launch("route:error-without-exit", () => child as unknown as ChildProcess, {
    onError: error => events.push(`error:${error.message}`)
  });

  child.emit("error", new Error("spawn channel failed"));
  assert.equal(registry.isRunning("route:error-without-exit"), true);
  assert.deepEqual(
    registry.launch("route:error-without-exit", () => fakeChild() as unknown as ChildProcess),
    { accepted: true, alreadyRunning: true }
  );
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(events, ["error:spawn channel failed", "graceful", "force-tree"]);
  assert.equal(registry.isRunning("route:error-without-exit"), false);
});

test("child error without exit remains fenced when force termination is unconfirmed", async () => {
  const child = fakeChild();
  const registry = new ManualTriggerProcessRegistry(
    async () => {},
    DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    { terminateTimeoutMs: 5, forceKillTimeoutMs: 5, forceStopProcess: async () => {} }
  );
  registry.launch("route:error-hung", () => child as unknown as ChildProcess);
  child.emit("error", new Error("spawn channel failed"));
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.equal(registry.isRunning("route:error-hung"), true);
  await assert.rejects(
    registry.stopAll(),
    (error: unknown) => error instanceof ManualTriggerTerminationUnconfirmedError
  );
  assert.throws(
    () => registry.launch("route:new", () => fakeChild() as unknown as ChildProcess),
    /fenced by an unconfirmed child termination/
  );
  exitChild(child, 1);
});
