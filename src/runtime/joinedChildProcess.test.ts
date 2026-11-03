import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { joinChildProcess } from "./joinedChildProcess.js";

test("deadline requests termination but cannot release the original work before close", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { killed = true; return true; } });
  let killed = false, completed = false;
  const result = joinChildProcess(child as unknown as ChildProcessWithoutNullStreams, { timeoutMs: 5, timeoutError: () => new Error("deadline") });
  void result.then(() => { completed = true; }, () => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(killed, true); assert.equal(completed, false);
  child.emit("close", null, "SIGTERM");
  await assert.rejects(result, /deadline/);
});

test("a real child is joined through its output and failed-spawn close", async () => {
  let stdout = "";
  const child = spawn(process.execPath, ["-e", "process.stdout.write('accepted');"], { windowsHide: true });
  assert.deepEqual(await joinChildProcess(child, { timeoutMs: 10_000, timeoutError: () => new Error("deadline"), stdout: text => { stdout += text; } }), { code: 0, signal: null });
  assert.equal(stdout, "accepted");
  const missing = spawn("missing-rabiroute-speech-test-executable", [], { windowsHide: true });
  await assert.rejects(joinChildProcess(missing, { timeoutMs: 10_000, timeoutError: () => new Error("deadline") }), /ENOENT/);
});

test("a real timed-out child is closed before its owner's promise rejects", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {},1000)"], { windowsHide: true });
  let closed = false;
  child.once("close", () => { closed = true; });
  await assert.rejects(joinChildProcess(child, { timeoutMs: 100, timeoutError: () => new Error("deadline") }), /deadline/);
  assert.equal(closed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
