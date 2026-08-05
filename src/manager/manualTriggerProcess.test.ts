import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { ManualTriggerProcessRegistry } from "./manualTriggerProcess.js";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
};

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null as number | null
  });
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

  child.exitCode = 0;
  child.emit("exit", 0, null);
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
  child.exitCode = 1;
  child.emit("exit", 1, null);

  assert.deepEqual(stdout, ["accepted\n"]);
  assert.deepEqual(stderr, ["delivery failed\n"]);
  assert.deepEqual(exits, [[1, null]]);
  assert.equal(registry.isRunning("route:manual"), false);
});
