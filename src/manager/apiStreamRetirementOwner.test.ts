import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { ApiStreamRetirementOwner } from "./apiStreamRetirementOwner.js";
import type { ApiOperationStream } from "./apiOperationContract.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Owned fixture timed out.")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("separate cancellation rejection and EOF proof settle without skipping yielding cleanup", { timeout: 5_000 }, async t => {
  const entered = deferred(), finish = deferred(); t.after(finish.resolve);
  let stopped = false, cleaned = false;
  const source: ApiOperationStream = { frames: (async function* () { try { if (!stopped) yield Buffer.from("data"); }
    finally { entered.resolve(); yield Buffer.from("cleanup"); await finish.promise; cleaned = true; } })(),
    cancel() { stopped = true; throw Error("Completed cancellation rejection."); } };
  const owner = new ApiStreamRetirementOwner(source, { instanceId: "fixture", operationId: "fixture.cleanup" });
  const completion = owner.retire(Error("Request failed.")); void completion.catch(() => undefined);
  await bounded(entered.promise);
  assert.equal(owner.snapshot().state, "retiring"); assert.equal(owner.snapshot().cancellation, "rejected");
  assert.equal(owner.snapshot().iteration, "pending"); assert.equal(cleaned, false);
  finish.resolve(); await assert.rejects(completion, /Completed cancellation rejection/);
  assert.equal(cleaned, true); assert.equal(owner.snapshot().state, "retired"); assert.equal(owner.snapshot().iteration, "eof");
});

async function fixture(t: TestContext, mode: string) {
  const source = import.meta.url.endsWith(".ts");
  const filename = fileURLToPath(new URL(source ? "./fixtures/apiStreamRetirementFault.ts" : "./fixtures/apiStreamRetirementFault.js", import.meta.url));
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "temp", "tmp", "comspec", "systemdrive"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  const child = fork(filename, [mode], { cwd: path.dirname(filename), env, ...{ windowsHide: true }, execArgv: source ? ["--import", "tsx"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const messages: Array<Record<string, any>> = [];
  child.on("message", message => messages.push(message as Record<string, any>));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let spawnError: Error | undefined; child.on("error", error => { spawnError = error; });
  let didClose = false; child.once("close", () => { didClose = true; });
  t.after(async () => {
    if (child.connected) child.send({ type: "close-fixture" }, () => undefined);
    try { await bounded(closed, 3_000); }
    catch { if (!didClose) child.kill(); await bounded(closed); }
    const contained = messages.find(message => message.type === "closing-fixture");
    if (contained && mode !== "cancel-throw") assert.equal(contained.registryRetirementConfirmed, false,
      "Fault containment must not be reported as a confirmed resource retirement.");
  });
  const wait = async (kind: string) => {
    const deadline = performance.now() + 5_000;
    while (!messages.some(message => message.type === kind)) {
      if (spawnError) throw spawnError;
      assert.equal(didClose, false); assert.ok(performance.now() < deadline); await delay(5);
    }
    return messages.find(message => message.type === kind)!;
  };
  // Process startup is governed by this test's outer deadline. The five-second
  // fault-observation budget starts only after the child has actually loaded.
  const ready = messages.find(message => message.type === "ready") ?? await new Promise<Record<string, any>>((resolve, reject) => {
    const message = (value: unknown) => { if ((value as {type?:string})?.type === "ready") { clean(); resolve(value as Record<string, any>); } };
    const close = () => { clean(); reject(Error("Owned fixture closed before ready.")); };
    const error = (cause: Error) => { clean(); reject(cause); };
    const clean = () => { child.off("message", message); child.off("close", close); child.off("error", error); };
    if (spawnError) { reject(spawnError); return; } if (didClose) { close(); return; }
    child.on("message", message); child.once("close", close); child.once("error", error);
  }); assert.equal(ready.pid, child.pid);
  const get = async (route: string) => { const response = await fetch(ready.url + route, { signal: AbortSignal.timeout(2_000) }); return { status: response.status, body: await response.json() }; };
  const snapshot = async () => {
    const count = messages.filter(message => message.type === "snapshot").length;
    child.send({ type: "snapshot" });
    const deadline = performance.now() + 5_000;
    while (messages.filter(message => message.type === "snapshot").length === count) {
      if (spawnError) throw spawnError;
      assert.equal(didClose, false); assert.ok(performance.now() < deadline); await delay(5);
    }
    return messages.filter(message => message.type === "snapshot").at(-1)!;
  };
  return { child, get, wait, snapshot };
}

for (const mode of ["capture-loop"] as const) {
  test(mode + " retains one truthful endpoint quarantine while unrelated API remains available", { timeout: 12_000 }, async t => {
    const owner = await fixture(t, mode);
    assert.equal((await owner.get("/feature")).status, 408);
    owner.child.send({ type: "release" });
    await owner.wait("getter");
    let current = await owner.snapshot();
    const end = performance.now() + 2_000;
    while (!current.diagnostics.length) { assert.ok(performance.now() < end); await delay(5); current = await owner.snapshot(); }
    assert.equal(current.active, 1); assert.equal(current.diagnostics[0].state, "unconfirmed");
    assert.equal((await owner.get("/health")).status, 200);
    const denied = await owner.get("/feature"); assert.equal(denied.status, 409); assert.equal(denied.body.mutationOutcome, "not_started");
    assert.equal((await owner.snapshot()).handlerCalls, 1);
  });
}

test("trusted slow cancellation and iterator cleanup finish their original finally blocks", async () => {
  let cancelFinally = 0, iteratorFinally = 0, factories = 0;
  const slow = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); };
  const source: ApiOperationStream = {
    frames: { [Symbol.asyncIterator]() {
      factories++;
      return { next() { try { slow(); return Promise.resolve({ done: true as const, value: undefined }); }
        finally { iteratorFinally++; } } };
    } },
    cancel() { try { slow(); } finally { cancelFinally++; } }
  };
  const owner = new ApiStreamRetirementOwner(source, { instanceId: "slow-owner", operationId: "slow.cleanup" }, { synchronousTimeoutMs: 25 });
  const completion = owner.retire(Error("Request expired."));
  assert.equal(owner.retire(Error("Repeated cancellation.")), completion);
  await completion;
  assert.deepEqual({ factories, cancelFinally, iteratorFinally }, { factories: 1, cancelFinally: 1, iteratorFinally: 1 });
  assert.equal(owner.snapshot().state, "retired");
  assert.equal(owner.snapshot().cancellation, "fulfilled");
  assert.equal(owner.snapshot().iteration, "eof");
});

test("an expired result establishes HTTP408 before invoking its faulty cleanup getter", { timeout: 12_000 }, async t => {
  const owner = await fixture(t, "expired-getter");
  const response = owner.get("/feature"); void response.catch(() => undefined);
  const getter = await owner.wait("getter"); assert.equal(getter.responseEnded, true);
  assert.equal((await response).status, 408); assert.equal((await owner.get("/health")).status, 200);
});

test("a live result getter receives only its remaining original deadline budget", { timeout: 12_000 }, async t => {
  const owner = await fixture(t, "live-getter-budget");
  const response = owner.get("/feature"); void response.catch(() => undefined);
  const getter = await owner.wait("getter");
  assert.equal(getter.responseEnded, false, "Fixture missed the live budget window; it does not establish this branch's coverage.");
  assert.equal(typeof getter.budget, "number"); assert.ok(getter.budget > 0 && getter.budget < 50, String(getter.budget));
  assert.equal((await response).status, 408); assert.equal((await owner.get("/health")).status, 200);
});

test("a normal synchronous cancel failure still drains EOF before releasing actual ownership", { timeout: 12_000 }, async t => {
  const owner = await fixture(t, "cancel-throw");
  assert.equal((await owner.get("/feature")).status, 408); owner.child.send({ type: "release" }); await owner.wait("getter");
  let current = await owner.snapshot(); const end = performance.now() + 2_000;
  while (current.active !== 0) { assert.ok(performance.now() < end); await delay(5); current = await owner.snapshot(); }
  assert.equal(current.cancelCalls, 1); assert.equal(current.drained, true); assert.equal(current.diagnostics.length, 0);
});
