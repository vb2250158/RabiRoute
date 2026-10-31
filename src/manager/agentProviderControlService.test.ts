import assert from "node:assert/strict";
import { execFile, spawn, ChildProcess } from "node:child_process";
import test from "node:test";
import { AgentProviderProcessScope, CopilotControlService } from "./agentProviderControlService.js";

const node = (script: string) => spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

test("native install owner joins controlled Node output and process close", { timeout: 10000 }, async t => {
  let child!: ChildProcess, closed = false;
  const service = new CopilotControlService({ execInstall: callback => {
    child = execFile(process.execPath, ["-e", "process.stdout.write('installed');process.stderr.write('detail')"], { windowsHide: true }, callback);
    child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  assert.deepEqual(await service.install(), { stdout: "installed", stderr: "detail" }); assert.equal(closed, true);
});

test("native install failure joins the same controlled process before rejecting", { timeout: 10000 }, async t => {
  let closed = false;
  const service = new CopilotControlService({ execInstall: callback => {
    const child = execFile(process.execPath, ["-e", "process.stderr.write('controlled failure');process.exit(2)"], { windowsHide: true }, callback);
    child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  await assert.rejects(service.install(), error => { assert.equal(closed, true); assert.equal((error as { stderr: string }).stderr, "controlled failure"); return true; });
});

test("native device-code acknowledgement keeps the original owned Node alive until service retirement", { timeout: 10000 }, async t => {
  let child!: ChildProcess, closed = false; const statuses: unknown[] = [];
  const service = new CopilotControlService({ locateCopilot: async () => "controlled-node", spawnLogin: () => {
    child = node("process.stdout.write('code ABCD-EFGH https://github.com/login/device\\n');setInterval(()=>{},1000)"); child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  const result = await service.login({ onExit: status => statuses.push(status) });
  assert.equal(result.kind, "device-code"); assert.equal(closed, false); assert.equal(child.exitCode, null);
  await service.stop(); assert.equal(closed, true); assert.deepEqual(statuses, []);
});

test("native device-code timeout returns only after controlled Node close", { timeout: 10000 }, async t => {
  let closed = false;
  const service = new CopilotControlService({ locateCopilot: async () => "controlled-node", loginTimeoutMs: 80, spawnLogin: () => {
    const child = node("setInterval(()=>{},1000)"); child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  assert.equal((await service.login({ onExit: () => {} })).kind, "timeout"); assert.equal(closed, true);
});

test("native completed login publishes only after full process and stdio close", { timeout: 10000 }, async t => {
  let closed = false; const statuses: unknown[] = [];
  const service = new CopilotControlService({ locateCopilot: async () => "controlled-node", spawnLogin: () => {
    const child = node("process.exit(0)"); child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  assert.deepEqual(await service.login({ onExit: status => { assert.equal(closed, true); statuses.push(status); } }), { kind: "completed" });
  assert.deepEqual(statuses, [{ done: true, exitCode: 0, error: "" }]);
});

test("native failed login joins controlled Node stderr before returning failure", { timeout: 10000 }, async t => {
  let closed = false; const statuses: unknown[] = [];
  const service = new CopilotControlService({ locateCopilot: async () => "controlled-node", spawnLogin: () => {
    const child = node("process.stderr.write('controlled login failed');process.exit(2)"); child.once("close", () => { closed = true; }); return child;
  } }); t.after(() => service.stop());
  assert.deepEqual(await service.login({ onExit: status => { assert.equal(closed, true); statuses.push(status); } }), { kind: "failed", error: "controlled login failed" });
  assert.deepEqual(statuses, [{ done: false, exitCode: 2, error: "controlled login failed" }]);
});

test("scope retains the original child after exit until its close acknowledgement", async () => {
  // Isolate event ordering deterministically; the five preceding tests use real local Node processes.
  const child = new ChildProcess(), scope = new AgentProviderProcessScope(); scope.track(child);
  Object.defineProperty(child, "exitCode", { value: 0 }); child.emit("exit", 0, null);
  let retired = false; const retirement = scope.stop().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  child.emit("close", 0, null); await retirement; assert.equal(retired, true);
});

test("scope joins healthy process cleanup before reporting another process failure and preserves the original stop", async () => {
  const broken = new ChildProcess(), healthy = new ChildProcess();
  broken.kill = () => false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const scope = new AgentProviderProcessScope(async child => {
    if (child === broken) throw undefined;
    await pending; healthy.emit("close", 0, null);
  });
  scope.track(broken); scope.track(healthy);
  let done = false;
  const stop = scope.stop();
  const observed = stop.then(() => { done = true; }, error => { done = true; assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [undefined]); });
  assert.equal(scope.stop(), stop);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(done, false);
  release(); await observed;
  assert.equal(scope.stop(), stop);
  broken.emit("close", 1, null);
});
