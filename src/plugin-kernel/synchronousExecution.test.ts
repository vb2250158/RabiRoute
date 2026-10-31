import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { once } from "node:events";
import { Script } from "node:vm";
import test from "node:test";
import {
  DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS,
  PluginSynchronousExecutionTimeoutError,
  runPluginSynchronousWork
} from "./synchronousExecution.js";

test("synchronous plugin work preserves closures, reference identity, nesting and original errors", () => {
  const owned = { value: 41 };
  assert.equal(runPluginSynchronousWork(() => owned, "owned"), owned);
  assert.equal(runPluginSynchronousWork(() => runPluginSynchronousWork(() => ++owned.value, "nested"), "outer"), 42);
  const expected = new Error("original business failure");
  assert.throws(() => runPluginSynchronousWork(() => { throw expected; }, "business"), error => error === expected);
  const nestedTimeout = Object.assign(new Error("original nested VM failure"), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });
  assert.throws(() => runPluginSynchronousWork(() => { throw nestedTimeout; }, "nested-business-error"), error => error === nestedTimeout);
  for (const timeout of [0, -1, NaN, 0.5, 2_147_483_648]) {
    assert.throws(() => runPluginSynchronousWork(() => {}, "invalid", timeout), RangeError);
  }
});

test("synchronous plugin work preserves the caller's AsyncLocalStorage and asynchronous ownership", async () => {
  const storage = new AsyncLocalStorage<{ id: string }>();
  const owner = { id: "original-activation" };
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  await storage.run(owner, async () => {
    assert.equal(runPluginSynchronousWork(() => storage.getStore(), "read-context"), owner);
    const result = runPluginSynchronousWork(async () => {
      assert.equal(storage.getStore(), owner);
      await completion;
      assert.equal(storage.getStore(), owner);
      return owner;
    }, "asynchronous-owner");
    let completed = false;
    void result.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    finish();
    assert.equal(await result, owner);
  });
  assert.equal(storage.getStore(), undefined);
});

test("repeated requests reuse invocation contexts without leaking another caller's callback", () => {
  let calls = 0;
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(runPluginSynchronousWork(function (this: void) {
      assert.equal(this, undefined);
      calls += 1;
      return index;
    }, "repeated-request"), index);
  }
  assert.equal(calls, 1_000);
});

test("a delayed watchdog result cannot replace completed work or repeat its mutation", () => {
  const original = Script.prototype.runInContext;
  let committed = 0;
  const result = { receipt: "original-operation" };
  Script.prototype.runInContext = function (this: Script, ...arguments_: Parameters<Script["runInContext"]>) {
    Reflect.apply(original, this, arguments_);
    // Deterministically reproduce a watchdog reported at the VM return boundary
    // after the external callback has completed under OS scheduling pressure.
    throw Object.assign(new Error("Script execution timed out after completed work"), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });
  };
  try {
    assert.equal(runPluginSynchronousWork(() => { committed += 1; return result; }, "committed-operation"), result);
    assert.equal(committed, 1);
  } finally {
    Script.prototype.runInContext = original;
  }
});

test("a finite 250ms plugin loop is interrupted before it reaches its trailing mutation", { timeout: 5_000 }, () => {
  let trailingMutation = false;
  const startedAt = performance.now();
  assert.throws(() => runPluginSynchronousWork(() => {
    const finishAt = performance.now() + 250;
    while (performance.now() < finishAt) { /* A finite fault fixture, not production work. */ }
    trailingMutation = true;
  }, "finite-cpu-loop", 25), (error: unknown) => error instanceof PluginSynchronousExecutionTimeoutError
    && error.operation === "finite-cpu-loop" && error.timeoutMs === 25);
  assert.equal(trailingMutation, false);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("a synchronous infinite loop in an async callback is interrupted before returning a Promise", { timeout: 5_000 }, () => {
  assert.throws(() => runPluginSynchronousWork(async () => {
    while (true) { /* V8 must terminate this JavaScript stack. */ }
  }, "async-prefix-loop", 25), PluginSynchronousExecutionTimeoutError);
});

test("a blocked plugin callback fails locally and a separate HTTP health request remains bounded", { timeout: 5_000 }, async t => {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.writeHead(200).end("fixture live"); return; }
    try {
      runPluginSynchronousWork(() => {
        while (true) { /* Only this trusted fixture callback is interrupted. */ }
      }, "fixture-feature");
      response.writeHead(200).end("unexpected completion");
    } catch (error) {
      assert.ok(error instanceof PluginSynchronousExecutionTimeoutError);
      response.writeHead(503).end(error.code);
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const startedAt = performance.now();
  const feature = fetch(`${base}/feature`, { signal: AbortSignal.timeout(2_000) });
  const health = fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
  const [failed, live] = await Promise.all([feature, health]);
  assert.equal(failed.status, 503); assert.equal(live.status, 200);
  assert.equal(await failed.text(), "PLUGIN_SYNCHRONOUS_EXECUTION_TIMEOUT");
  assert.equal(await live.text(), "fixture live");
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `Health completed after ${elapsedMs}ms.`);
  t.diagnostic(`default synchronous budget=${DEFAULT_PLUGIN_SYNCHRONOUS_TIMEOUT_MS}ms; fixture health completed after ${elapsedMs.toFixed(1)}ms`);
});
