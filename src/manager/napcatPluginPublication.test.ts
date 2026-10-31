import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginManifest, PluginModule } from "../plugin-kernel/types.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createNapcatControlOperations } from "./napcatControlRoutes.js";
import { NapcatSupervisorService } from "./napcatSupervisorService.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(t: test.TestContext) {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const contexts: Array<{ revision: number; assertCurrent(): void }> = [];
  const runs: Array<{ context: unknown; signal: AbortSignal; stopped: boolean }> = [];
  const events: string[] = [];
  let guardianGate: Promise<void> | undefined;
  let action: (context: unknown, body: unknown) => Promise<unknown> = async () => ({ ok: true });
  let kernel!: GenerationRuntime;
  let onNextPublished: (() => void) | undefined;
  const registry = new ManagerPluginRouteRegistry(() => new Set(kernel.current().records.filter(r => r.status === "active").map(r => r.identity.activationId)));
  const runtime = {
    createNapcatControlOperations, managerPluginRoutes: registry, NapcatSupervisorService,
    managerReadOnly: false, managerShouldAutostart: true, managerListenerReady: true, routeCatalogReady: true,
    activeNapcatControlContext: undefined as unknown,
    startActiveNapcatSupervisor: () => {}, stopActiveNapcatSupervisor: async () => {},
    napcatManagerCtx(assertCurrent: () => void) { const context = { revision: contexts.length + 1, assertCurrent }; contexts.push(context); return context; },
    autoLoginNapcatInstancesOnRabiStart: async () => { events.push("login"); },
    napcatGuardianDepsFor: (context: unknown) => ({ context }),
    napcatGuardianInstances: () => [], observeNapcatGuardianInstance: async () => ({}), relaunchNapcatGuardianInstance: async () => ({}),
    async runNapcatGuardianLoop(deps: { context: unknown }, signal: AbortSignal) {
      const run = { context: deps.context, signal, stopped: false }; runs.push(run);
      assert.equal(runs.filter(item => !item.stopped).length, 1, "only one guardian driver may run");
      const gate = guardianGate;
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (gate) await gate;
      run.stopped = true; events.push("guardian-closed");
    },
    launchNapcatInstanceEndpoint: (context: unknown, body: unknown) => action(context, body),
    testNapcatHealth: async (context: unknown) => ({ ok: true, revision: (context as { revision: number }).revision })
  };
  kernel = new GenerationRuntime({ host: "manager", onPublished() { const notify = onNextPublished; onNextPublished = undefined; notify?.(); }, hostServices: [
    { capability: "host.manager.napcat-control@1", value: runtime },
    { capability: "host.manager.napcat-supervisor@1", value: runtime }
  ], executor: { async prepare(candidate) { return modules.get(candidate)!; } } });
  const manifest = (id: string, provides: string[] = [], requires: string[] = []): PluginManifest => ({ schemaVersion: 2, id, version: "1.0.0", provides, requires, optional: [], permissions: [], entries: { manager: { execution: "in_process", module: "./manager.mjs" } } });
  const candidate = (id: string, revision: string, m: PluginManifest, module: PluginModule): PluginCandidate => {
    const result: PluginCandidate = { instanceId: id, revision, manifest: m, config: {}, entry: { execution: "in_process", path: "fixture.mjs" } }; modules.set(result, module); return result;
  };
  const control = await import(new URL("../../plugins/builtin/io.rabiroute.manager.napcat-control/1.0.0/manager.mjs", import.meta.url).href);
  const supervisor = await import(new URL("../../plugins/builtin/io.rabiroute.manager.napcat-supervisor/1.0.0/manager.mjs", import.meta.url).href);
  const candidates = (revision: string, extra?: PluginModule, independentFailure = false) => [
    candidate("control", revision, manifest("io.test.control", ["manager.napcat-control@1"], ["host.manager.napcat-control@1"]), extra && !independentFailure ? { async activate(context) { await control.activate(context); await extra.activate(context); } } : control),
    candidate("supervisor", revision, manifest("io.test.supervisor", ["manager.napcat-supervisor@1"], ["host.manager.napcat-supervisor@1", "manager.napcat-control@1"]), supervisor),
    ...(extra && independentFailure ? [candidate("failure", revision, manifest("io.test.failure", [], ["manager.napcat-supervisor@1"]), extra)] : [])
  ];
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (operation: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(`${base}/api/message/napcat-${operation}`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json", connection: "close" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.end("{}");
  });
  t.after(async () => { await kernel.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { kernel, runtime, contexts, runs, events, candidates, send, nextPublication: () => new Promise<void>(resolve => { onNextPublished = resolve; }), setGuardianGate: (gate: Promise<void>) => { guardianGate = gate; }, setAction: (next: typeof action) => { action = next; } };
}

test("NapCat candidate preparation and failed effects preserve the published context, commands and guardian", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.kernel.switch(f.candidates("old")); await turn();
  const current = f.runtime.activeNapcatControlContext, start = f.runtime.startActiveNapcatSupervisor, stop = f.runtime.stopActiveNapcatSupervisor;
  const entered = deferred(), gate = deferred();
  const switching = f.kernel.switch(f.candidates("failed", { activate(context) { context.effects.add(async () => { entered.resolve(); await gate.promise; throw new Error("controlled candidate failure"); }); } }));
  await entered.promise;
  try {
    assert.equal(f.runtime.activeNapcatControlContext, current);
    assert.equal(f.runtime.startActiveNapcatSupervisor, start); assert.equal(f.runtime.stopActiveNapcatSupervisor, stop);
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0].signal.aborted, false);
    assert.deepEqual(await f.send("health"), { status: 200, body: { ok: true, revision: 1 } });
  } finally { gate.resolve(); await switching; }
  assert.equal(f.runtime.activeNapcatControlContext, current);
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0].signal.aborted, false);
  assert.deepEqual(await f.send("health"), { status: 200, body: { ok: true, revision: 1 } });
});

test("NapCat replacement and rollback join the previous guardian before starting the next driver", { timeout: 15_000 }, async t => {
  const f = await fixture(t), stopped = deferred(); f.setGuardianGate(stopped.promise);
  await f.kernel.switch(f.candidates("old")); await turn();
  const firstContext = f.runtime.activeNapcatControlContext, firstGeneration = f.kernel.current();
  const aborted = new Promise<void>(resolve => f.runs[0].signal.addEventListener("abort", () => resolve(), { once: true }));
  const switching = f.kernel.switch(f.candidates("new")); await aborted;
  try {
    assert.equal(f.runs[0].signal.aborted, true); assert.equal(f.runs.length, 1);
  } finally { stopped.resolve(); await switching; }
  await turn();
  assert.equal(f.kernel.current().managerInstanceId, firstGeneration.managerInstanceId);
  assert.notEqual(f.runtime.activeNapcatControlContext, firstContext);
  assert.equal(f.runs.length, 2); assert.equal(f.runs[0].stopped, true); assert.equal(f.runs[1].signal.aborted, false);
  assert.equal((await f.send("health")).body.revision, 2);
  await f.kernel.switch(f.candidates("old")); await turn();
  assert.equal(f.kernel.current().managerInstanceId, firstGeneration.managerInstanceId);
  assert.equal(f.runs.length, 3); assert.equal(f.runs[1].stopped, true); assert.equal(f.runs[2].signal.aborted, false);
  assert.equal((await f.send("health")).body.revision, 3);
});

test("NapCat synchronous publication failure restores the old context and supervisor without starting a candidate driver", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.kernel.switch(f.candidates("old")); await turn();
  const current = f.runtime.activeNapcatControlContext, start = f.runtime.startActiveNapcatSupervisor, stop = f.runtime.stopActiveNapcatSupervisor;
  const originalManager = f.kernel.current().managerInstanceId;
  let rolledBack = false;
  await assert.rejects(f.kernel.switch(f.candidates("failed-publication", { activate(context) {
    context.publication.add({ publish() { throw new Error("controlled publication failure"); }, rollback() { rolledBack = true; } });
  } })), /controlled publication failure/);
  await turn();
  assert.equal(rolledBack, true);
  assert.equal(f.kernel.current().managerInstanceId, originalManager);
  assert.equal(f.runtime.activeNapcatControlContext, current);
  assert.equal(f.runtime.startActiveNapcatSupervisor, start); assert.equal(f.runtime.stopActiveNapcatSupervisor, stop);
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0].signal.aborted, false);
  assert.equal(f.events.filter(event => event === "login").length, 1);
  assert.deepEqual(await f.send("health"), { status: 200, body: { ok: true, revision: 1 } });
});

test("NapCat retirement waits for an accepted command's real child close and stdout/stderr drain", { timeout: 15_000 }, async t => {
  const entered = deferred();
  let child: ReturnType<typeof spawn> | undefined, output = "", errors = "", closed = false;
  let nativeClosed: Promise<void> | undefined;
  t.after(async () => { if (child && !closed) child.kill(); await nativeClosed; });
  const f = await fixture(t);
  f.setAction(async () => {
    child = spawn(process.execPath, ["-e", String.raw`process.stdout.write('ready\n'); process.stdin.once('data',()=>{process.stdout.write('drained\n');process.stderr.write('cleaned\n');process.stdin.destroy();});`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    nativeClosed = new Promise<void>(resolve => child!.once("close", () => resolve()));
    const closing = once(child, "close").then(([code]) => { assert.equal(code, 0); closed = true; });
    child.stdout!.setEncoding("utf8").on("data", chunk => { output += chunk; if (output.includes("ready")) entered.resolve(); });
    child.stderr!.setEncoding("utf8").on("data", chunk => { errors += chunk; });
    await closing;
    assert.equal(child.stdout!.readableEnded, true); assert.equal(child.stderr!.readableEnded, true);
    return { ok: true };
  });
  await f.kernel.switch(f.candidates("old")); await turn();
  const pending = f.send("launch");
  await Promise.race([entered.promise, pending.then(reply => assert.fail(`Native child readiness was not reached before HTTP ${reply.status}.`))]);
  let retired = false;
  const published = f.nextPublication();
  const switching = f.kernel.switch(f.candidates("new")).then(() => { retired = true; });
  await published;
  try {
    assert.equal(retired, false); assert.equal(closed, false);
    assert.equal((await f.send("health")).body.revision, 2);
  } finally { child!.stdin!.end("finish"); await pending; await switching; }
  assert.equal(closed, true); assert.equal(output, "ready\ndrained\n"); assert.equal(errors, "cleaned\n");
  assert.equal((f.runtime.activeNapcatControlContext as { revision: number }).revision, 2);
  assert.equal(f.runs.at(-1)!.signal.aborted, false);
});


test("an unrelated candidate failure does not roll back healthy NapCat owners", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.kernel.switch(f.candidates("old"));
  const result = await f.kernel.switch(f.candidates("new", { activate(context) {
    context.effects.add(() => { throw new Error("unrelated candidate failure"); });
  } }, true));
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "failure")?.status, "failed");
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "control")?.status, "active");
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "supervisor")?.status, "active");
  assert.deepEqual(await f.send("health"), { status: 200, body: { ok: true, revision: 2 } });
  assert.equal(f.runs.length, 2); assert.equal(f.runs[0].stopped, true); assert.equal(f.runs[1].signal.aborted, false);
});
