import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { runLocalAgentMessageProcess } from "./localAgentMessageProcess.js";

test("local message ownership drains actual stdout and stderr through close", { timeout: 15000 }, async () => {
  const logs: string[] = []; let exited = false, closed = false;
  const script = "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{process.stdout.write('input:'+text+'\\ntail\\n');process.stderr.write('diagnostic\\n')});";
  await runLocalAgentMessageProcess({ command: process.execPath, args: ["--eval", script], cwd: process.cwd(), env: process.env,
    text: "accepted", messageId: "fixture-message", label: "role panel", timeoutMs: 5000,
    onLog: line => { logs.push(line); }, spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options); child.once("exit", () => { exited = true; }); child.once("close", () => { closed = true; }); return child;
    } });
  assert.equal(exited, true); assert.equal(closed, true);
  assert.ok(logs.some(line => line.includes("input:accepted"))); assert.ok(logs.some(line => line.includes("tail")), JSON.stringify(logs));
  assert.ok(logs.some(line => line.includes("error: diagnostic")));
  assert.equal(logs.at(-1), "role panel completed: fixture-message");
});

test("local message timeout rejects only after the same child and its streams close", { timeout: 10000 }, async () => {
  let closed = false;
  await assert.rejects(runLocalAgentMessageProcess({ command: process.execPath, args: ["--eval", "process.stdin.resume();setInterval(()=>{},10000)"],
    cwd: process.cwd(), env: process.env, text: "accepted", messageId: "timeout-message", label: "role panel", timeoutMs: 100, killGraceMs: 100,
    onLog: () => {}, spawnProcess: (command, args, options) => { const child = spawn(command, args, options); child.once("close", () => { closed = true; }); return child; }
  }), /timed out: timeout-message/);
  assert.equal(closed, true);
});

test("accepted asynchronous log callbacks remain owned before completion", { timeout: 10000 }, async t => {
  let entered!: () => void, release!: () => void, exited!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), childExited = new Promise<void>(resolve => { exited = resolve; });
  t.after(() => release()); let finished = false;
  const work = runLocalAgentMessageProcess({ command: process.execPath, args: ["--eval", "process.stdout.write('owned-log\\n')"],
    cwd: process.cwd(), env: process.env, text: "", messageId: "log-message", label: "role panel", timeoutMs: 5000,
    onLog: async line => { if (line.includes("owned-log")) { entered(); await gate; } },
    spawnProcess: (command, args, options) => { const child = spawn(command, args, options); child.once("exit", exited); return child; }
  }).then(() => { finished = true; });
  await started; await childExited; await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release(); await work; assert.equal(finished, true);
});
