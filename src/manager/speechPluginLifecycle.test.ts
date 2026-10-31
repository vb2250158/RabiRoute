import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginContext, PluginManifest, PluginModule, PluginPublication } from "../plugin-kernel/types.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { SpeechEventStreamOwner } from "./speechEventOperation.js";
import type { ApiOperationDefinition, ApiOperationRegistration } from "./apiOperationContract.js";
import { SpeechModelManager } from "./speechModelManager.js";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";

const plugin = await import(new URL("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/manager.mjs", import.meta.url).href);
const lifecycleModule = await import(new URL("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/lifecycle.mjs", import.meta.url).href);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type SpeechReconcile = (() => void) & { readonly retired?: Promise<void> };

test("kernel speech shutdown confirms an uninstalled runtime without starting optional speech", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let ownerInspected = false;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false,
    inspect: async () => ({ state: "offline", checkedAt: new Date().toISOString(),
      configuredUrl: "http://127.0.0.1:8781", defaults: {}, providers: { tts: [], asr: [] } }),
    inspectOwner: async () => { ownerInspected = true; return null; },
    spawnRuntime: () => { assert.fail("shutdown must not launch optional speech"); },
    killProcessTree: async () => { assert.fail("shutdown must not kill an absent runtime"); }
  });
  f.nativeStops.runtime = async () => { await control.stop(); };
  f.nativeStops.microphone = async () => { assert.fail("an absent optional runtime must not receive a microphone stop request"); };
  f.nativeStops.playback = async () => { assert.fail("an absent optional runtime must not receive a playback stop request"); };
  await f.kernel.switch([f.candidate("uninstalled")]);
  await f.kernel.dispose();
  assert.equal(ownerInspected, true);
  assert.deepEqual(f.kernel.current().cleanupDiagnostics, []);
});

test("speech preparation passes its lifecycle signal to async registration and cleans a cancelled candidate", async () => {
  const controller = new AbortController(), entered = deferred(), release = deferred();
  let eventStops = 0;
  const host = {
    SpeechApiOwner: class { events = { stop: async () => { eventStops++; } }; }, speechApiContext: {},
    createSpeechApiOperations: () => ({ operations: [], proxies: [] }),
    managerPluginRoutes: {
      registerOperationsAsync: async (_instance: string, _definitions: unknown, signal: AbortSignal) => {
        assert.equal(signal, controller.signal); entered.resolve(); await release.promise; signal.throwIfAborted();
        return { dispose: async () => {} };
      },
      registerHttpProxies: () => { assert.fail("cancelled preparation must not register proxies"); }
    },
    speechRuntimeControl: { stop: async () => { assert.fail("an unpublished candidate must not stop the shared runtime"); } },
    speechModelManager: { stop: async () => { assert.fail("an unpublished candidate must not stop the shared installer"); } }
  };
  const lifecycle = lifecycleModule.createSpeechPluginLifecycle(host, { instanceId: "speech" }, controller.signal);
  const preparing = lifecycle.prepare(); await entered.promise;
  controller.abort(new Error("Controlled registration cancellation.")); release.resolve();
  await assert.rejects(preparing, /Controlled registration cancellation/);
  await lifecycle.publication.retire();
  assert.equal(eventStops, 1);
});

async function fixture(t: test.TestContext) {
  const modules = new WeakMap<PluginCandidate, PluginModule>();
  const events: string[] = [], guards: Array<() => boolean> = [];
  const owners: Owner[] = [];
  const publications: Array<() => void> = [];
  let kernel!: GenerationRuntime;
  let ready = true, readyWrites = 0, reconcile: (() => void) | undefined;
  let failProxy = false;
  let work = async (_owner: Owner) => {};
  let extraOperations = (_owner: Owner): ApiOperationDefinition[] => [];
  const nativeStops = {
    microphone: async () => { events.push("microphone-stop"); },
    playback: async () => { events.push("playback-stop"); },
    runtime: async () => { events.push("runtime-stop"); },
    installer: async () => { events.push("installer-stop"); }
  };
  class Owner {
    readonly value = owners.length + 1;
    readonly events = new SpeechEventStreamOwner();
    constructor() {
      owners.push(this);
      const stop = this.events.stop.bind(this.events);
      this.events.stop = async () => { events.push(`events-stop:${this.value}`); await stop(); };
    }
  }
  const routes = new ManagerPluginRouteRegistry(() => new Set(kernel.current().records.filter(record => record.status === "active").map(record => record.identity.activationId)));
  const host = {
    SpeechApiOwner: Owner, speechApiContext: {}, managerReadOnly: false,
    get managerServicesReady() { return ready; },
    set managerServicesReady(value: boolean) { readyWrites++; ready = value; },
    get reconcileActiveSpeech() { return reconcile; },
    set reconcileActiveSpeech(value: (() => void) | undefined) { reconcile = value; },
    reconcileSpeechMicrophone: (_reason: string, guard: () => boolean) => { guards.push(guard); },
    speechControl: { stopMicrophone: () => nativeStops.microphone(), stopPlayback: () => nativeStops.playback() },
    speechRuntimeControl: { stop: () => nativeStops.runtime() }, speechModelManager: { stop: () => nativeStops.installer() },
    createSpeechApiOperations: (owner: Owner) => ({ operations: [{ contract: fixtureApiContract(), handler: async () => {
      await work(owner); return { status: 200, body: { ok: true, value: owner.value } };
    } }, ...extraOperations(owner)], proxies: [] }),
    managerPluginRoutes: {
      registerOperationsAsync: routes.registerOperationsAsync.bind(routes),
      registerHttpProxies: (...args: Parameters<ManagerPluginRouteRegistry["registerHttpProxies"]>) => {
        if (failProxy) throw new Error("Controlled candidate proxy registration failure.");
        return routes.registerHttpProxies(...args);
      }
    }
  };
  kernel = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.manager.speech@1", value: host }],
    executor: { prepare: async candidate => modules.get(candidate)! },
    onPublished: () => { routes.refreshPublication(); for (const resolve of publications.splice(0)) resolve(); }
  });
  const manifest: PluginManifest = { schemaVersion: 2, id: "io.test.speech", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: ["manager.speech@1"], requires: ["host.manager.speech@1"], optional: [], permissions: [] };
  const candidate = (revision: string, afterPrepare?: () => Promise<void>, publication?: PluginPublication) => {
    const result: PluginCandidate = { instanceId: "manager:speech", revision, manifest, config: {}, entry: { execution: "in_process", path: "fixture.mjs" } };
    modules.set(result, { activate: async (context: PluginContext) => {
      await plugin.activate(context);
      if (afterPrepare) context.effects.add(async () => { await afterPrepare(); return () => {}; });
      if (publication) context.publication.add(publication);
    } });
    return result;
  };
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/example/records/one`;
  const send = (signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}', signal }).then(async response => ({ status: response.status, body: await response.json() as { value: number } }));
  t.after(async () => { await kernel.dispose().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { kernel, candidate, host, nativeStops, events, owners, guards, send, url,
    readyWrites: () => readyWrites, failProxy: () => { failProxy = true; }, work: (value: typeof work) => { work = value; },
    extraOperations: (value: typeof extraOperations) => { extraOperations = value; },
    nextPublication: () => new Promise<void>(resolve => publications.push(resolve)) };
}

test("speech candidates have no shared side effects before publication and effect failure retains callable old owner", { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  const f = await fixture(t);
  await f.kernel.switch([f.candidate("old")]);
  const original = f.host.reconcileActiveSpeech, guard = f.guards[0]!;
  const switching = f.kernel.switch([f.candidate("failed", async () => { entered.resolve(); await release.promise; throw new Error("Controlled later effect failure."); })]);
  await entered.promise;
  assert.equal(f.host.reconcileActiveSpeech, original); assert.equal(f.guards.length, 1); assert.equal(guard(), true);
  assert.equal((await f.send()).body.value, 1);
  release.resolve(); const result = await switching;
  assert.equal(result.generation.records[0]!.error?.code, "update_failed_using_previous_revision");
  assert.equal(f.host.reconcileActiveSpeech, original); assert.equal((await f.send()).body.value, 1);
  assert.deepEqual(f.events, ["events-stop:2"]); assert.equal(f.readyWrites(), 0);
});

test("partial registration and post-commit required-capability failures preserve published speech runtime", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.kernel.switch([f.candidate("old")]);
  const original = f.host.reconcileActiveSpeech;
  await assert.rejects(f.kernel.switch([f.candidate("unpublishable")], { readyRequires: ["missing.required@1"] }), /Required plugin capabilities/);
  assert.equal(f.host.reconcileActiveSpeech, original); assert.equal((await f.send()).body.value, 1);
  f.failProxy(); const result = await f.kernel.switch([f.candidate("partial")]);
  assert.match(result.generation.records[0]!.error!.message, /candidate proxy registration failure/);
  assert.equal(f.host.reconcileActiveSpeech, original); assert.equal((await f.send()).body.value, 1);
  assert.deepEqual(f.events, ["events-stop:2", "events-stop:3"]); assert.equal(f.readyWrites(), 0);
});

test("replacement and rollback publish fresh ownership without restarting shared speech models", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.kernel.switch([f.candidate("old")]);
  const oldGuard = f.guards[0]!; const old = f.candidate("replacement");
  await f.kernel.switch([old]);
  assert.equal((await f.send()).body.value, 2); assert.equal(oldGuard(), false); assert.equal(f.guards[1]!(), true);
  await f.kernel.switch([f.candidate("old")]);
  assert.equal((await f.send()).body.value, 3); assert.equal(f.guards[1]!(), false); assert.equal(f.guards[2]!(), true);
  assert.deepEqual(f.events, ["events-stop:1", "events-stop:2"]); assert.equal(f.readyWrites(), 0);
  // An unchanged activation does not reconcile again.
  const unchanged = f.candidate("old"); await f.kernel.switch([unchanged]); assert.equal(f.guards.length, 3);
});

test("a synchronous publication failure restores the original speech pointer and callable generation", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.kernel.switch([f.candidate("old")]);
  const original = f.host.reconcileActiveSpeech, generation = f.kernel.current();
  await assert.rejects(f.kernel.switch([f.candidate("failed-publication", undefined, {
    publish() { throw new Error("Controlled later synchronous publication failure."); }, rollback() {}
  })]), /Controlled later synchronous publication failure/);
  assert.equal(f.kernel.current(), generation); assert.equal(f.host.reconcileActiveSpeech, original);
  assert.equal(f.guards[0]!(), true); assert.equal(f.guards.length, 1); assert.equal((await f.send()).body.value, 1);
  assert.deepEqual(f.events, ["events-stop:2"]); assert.equal(f.readyWrites(), 0);
});

test("disconnected accepted work keeps old retirement pending while new requests use the replacement", { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const f = await fixture(t);
  f.work(async owner => { if (owner.value === 1) { entered.resolve(); await release.promise; } });
  await f.kernel.switch([f.candidate("old")]);
  const abort = new AbortController(), pending = f.send(abort.signal).catch(() => null);
  await entered.promise; abort.abort(); await pending;
  let finished = false;
  const published = f.nextPublication();
  const switching = f.kernel.switch([f.candidate("next")]).then(() => { finished = true; });
  // Wait on the real replacement publication, while the kernel still drains old work.
  await published; assert.equal(f.guards[0]!(), false);
  assert.equal(f.guards.length, 1); assert.equal(finished, false); assert.equal((await f.send()).body.value, 2);
  release.resolve(); await switching;
  assert.equal(f.guards.length, 2); assert.equal(f.guards[1]!(), true);
  assert.deepEqual(f.events, ["events-stop:1"]);
});

test("published retirement joins native installer close despite another cleanup failure and is idempotent", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-speech-retirement-close-"));
  const ready = deferred(), entered = deferred(), closed = deferred();
  let child: ReturnType<typeof spawn> | undefined, killOriginal: ChildProcess["kill"] | undefined, installer: SpeechModelManager | undefined;
  let childClosed = false, killRequests = 0, pendingSignal: NodeJS.Signals | number | undefined;
  // Register emergency cleanup before the fixture's kernel teardown, so assertion
  // failures cannot leave its native installer join waiting on the controlled child.
  t.after(async () => {
    if (child && !childClosed) { killOriginal?.(); await installer?.stop(); await closed.promise; }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const pluginRoot = path.join(root, "plugin-adapters", "rabi-speech");
  await fs.mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "scripts", "install.ps1"), "# controlled fixture\n");
  await fs.writeFile(path.join(pluginRoot, "model-catalog.json"), JSON.stringify({ schema_version: 1,
    models: [{ alias: "fixture", name: "Fixture", target: "fixture", capability: "asr", runtime: "core", kind: "file" }] }));
  const f = await fixture(t);
  const registrationStops: string[] = [];
  let registrationStopsAtRuntime: string[] = [];
  const observeRegistration = (registration: ApiOperationRegistration, name: string): ApiOperationRegistration => ({ ...registration,
    async dispose() { await registration.dispose(); registrationStops.push(name); }
  });
  const registerOperations = f.host.managerPluginRoutes.registerOperationsAsync;
  const registerProxies = f.host.managerPluginRoutes.registerHttpProxies;
  f.host.managerPluginRoutes.registerOperationsAsync = async (...args: Parameters<typeof registerOperations>) => observeRegistration(await registerOperations(...args), "typed");
  f.host.managerPluginRoutes.registerHttpProxies = (...args: Parameters<typeof registerProxies>) => observeRegistration(registerProxies(...args), "proxy");
  // Native installers use ignore/pipe/pipe; other spawn overloads are not exercised.
  const spawnInstaller = (() => {
    const running = spawn(process.execPath, ["-e", "process.stdout.write('controlled-ready\\n'); setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    child = running; killOriginal = running.kill.bind(running);
    // Delay only the test driver's actual signal. Native stop() has already run
    // and must join this real child's close, rather than accepting kill() as EOF.
    running.kill = signal => { killRequests++; pendingSignal = signal; entered.resolve(); return true; };
    running.stdout.once("data", () => ready.resolve());
    running.once("close", () => { childClosed = true; f.events.push("installer-child-close"); closed.resolve(); });
    return running;
  }) as unknown as typeof spawn;
  installer = new SpeechModelManager({ rootDir: root, modelRoot: path.join(root, "models"), platform: "win32", spawnInstaller });
  const jobId = installer.installRuntime().activeJob!.id;
  await ready.promise;
  f.nativeStops.runtime = () => {
    registrationStopsAtRuntime = [...registrationStops];
    f.events.push("runtime-stop"); throw new Error("Controlled runtime cleanup failure.");
  };
  f.nativeStops.installer = async () => { f.events.push("installer-stop"); await installer!.stop(); f.events.push("installer-closed"); };
  await f.kernel.switch([f.candidate("old")]);
  const original = f.host.reconcileActiveSpeech as (() => void) & { retired: Promise<void> };
  let finished = false;
  const removing = f.kernel.switch([]).then(value => { finished = true; return value; });
  await entered.promise; assert.equal(finished, false); assert.equal(f.guards[0]!(), false);
  assert.deepEqual(registrationStopsAtRuntime, ["typed", "proxy"]);
  assert.equal(childClosed, false); assert.equal(killRequests, 1);
  let retirementSettled = false;
  void original.retired.then(() => { retirementSettled = true; }, () => { retirementSettled = true; });
  await tick(); assert.equal(finished, false); assert.equal(retirementSettled, false);
  assert.deepEqual(f.events, ["events-stop:1", "runtime-stop", "installer-stop"]);
  assert.equal(killOriginal!(pendingSignal), true); await closed.promise;
  const result = await removing;
  assert.equal(childClosed, true); assert.equal(child!.stdout!.destroyed, true); assert.equal(child!.stderr!.destroyed, true);
  assert.equal(installer.snapshot().lastJob?.id, jobId); assert.equal(installer.snapshot().lastJob?.error, "manager_stopped");
  assert.deepEqual(f.events.slice(-2), ["installer-child-close", "installer-closed"]);
  assert.match(result.generation.cleanupDiagnostics[0]!.message, /Controlled runtime cleanup failure/);
  await assert.rejects(original.retired, /Controlled runtime cleanup failure/);
  const before = [...f.events];
  const shutdown = f.kernel.dispose();
  const assertShutdownFailure = (error: unknown): boolean => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "Plugin cleanup failed during shutdown.");
    assert.equal(error.errors.length, 1);
    assert.ok(error.errors[0] instanceof Error);
    assert.equal(error.errors[0].message, "Controlled runtime cleanup failure.");
    return true;
  };
  await assert.rejects(shutdown, assertShutdownFailure);
  assert.equal(f.kernel.dispose(), shutdown);
  await assert.rejects(f.kernel.dispose(), assertShutdownFailure);
  assert.deepEqual(f.events, before); assert.deepEqual(registrationStops, ["typed", "proxy"]); assert.equal(killRequests, 1);
  assert.ok(f.kernel.current().cleanupDiagnostics.some(item => item.phase === "shutdown" && item.message === "Controlled runtime cleanup failure."));
});

test("old SSE retirement joins native reader cancellation while replacement retains its shared runtime", { timeout: 15000 }, async t => {
  const cancelled = deferred(), release = deferred(); t.after(release.resolve);
  const f = await fixture(t);
  f.extraOperations(owner => [{ contract: fixtureApiContract({ operationId: "speech.fixture.events", method: "GET", pathTemplate: "/api/speech/events", transport: "sse",
    request: { path: { type: "object", additionalProperties: false }, query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "text/event-stream", stream: { framing: "bytes", maxFrameBytes: 4096, completion: "Native EOF.", cancellation: "Join original native reader." } } }
  }), handler: input => owner.events.open(input, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(": original-native-event\n\n")); },
    async cancel() { cancelled.resolve(); await release.promise; }
  }), { headers: { "content-type": "text/event-stream" } }), () => {}) }]);
  await f.kernel.switch([f.candidate("old")]);
  const stream = await fetch(new URL("/api/speech/events", f.url)), reader = stream.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), ": original-native-event\n\n");
  let finished = false; const switching = f.kernel.switch([f.candidate("next")]).then(() => { finished = true; });
  await cancelled.promise; assert.equal(finished, false); assert.equal((await f.send()).body.value, 2);
  assert.equal(finished, false);
  release.resolve(); await switching; await reader.cancel().catch(() => {});
  assert.equal(f.owners[0]!.events.activeCount(), 0); assert.deepEqual(f.events, ["events-stop:1"]);
});

test("candidate preparation joins an original timed-out shutdown and late disposal cannot stop new ownership", { timeout: 15000 }, async () => {
  let current: SpeechReconcile | undefined, started = 0, stopped = 0;
  const draining = deferred(), entered = deferred();
  const host = { SpeechApiOwner: class { events = { stop: async () => {} }; }, speechApiContext: {}, managerServicesReady: true, managerReadOnly: false,
    get reconcileActiveSpeech() { return current; }, set reconcileActiveSpeech(value) { current = value; },
    reconcileSpeechMicrophone: () => { started++; }, createSpeechApiOperations: () => ({ operations: [], proxies: [] }),
    managerPluginRoutes: { registerOperationsAsync: async () => ({ dispose: async () => {} }), registerHttpProxies: () => ({ dispose: async () => {} }) },
    speechControl: { stopMicrophone: async () => {}, stopPlayback: async () => {} }, speechRuntimeControl: { stop: async () => {} },
    speechModelManager: { stop: async () => { stopped++; entered.resolve(); await draining.promise; } }
  };
  const signal = new AbortController().signal;
  const old = lifecycleModule.createSpeechPluginLifecycle(host, { instanceId: "speech" }, signal), retire = await old.prepare(); old.publication.publish(); await old.publication.afterPublish({ previousRetirement: Promise.resolve(), signal });
  const retiring = retire(); await entered.promise;
  const next = lifecycleModule.createSpeechPluginLifecycle(host, { instanceId: "speech" }, signal);
  let prepared = false; const preparation = next.prepare().then((dispose: () => Promise<void>) => { prepared = true; return dispose; });
  await tick(); assert.equal(prepared, false); assert.equal(started, 1);
  draining.resolve(); await retiring; const disposeNext = await preparation; next.publication.publish(); await next.publication.afterPublish({ previousRetirement: retiring, signal });
  await retire(); assert.equal(started, 2); assert.equal(stopped, 1);
  await disposeNext(); assert.equal(stopped, 2);
});

test("startup barrier rejection still joins the original native work before shared shutdown", { timeout: 15000 }, async () => {
  let current: SpeechReconcile | undefined, registrations = 0, stopped = 0;
  const draining = deferred(), entered = deferred();
  const host = { SpeechApiOwner: class { events = { stop: async () => {} }; }, speechApiContext: {}, managerServicesReady: true, managerReadOnly: false,
    get reconcileActiveSpeech() { return current; }, set reconcileActiveSpeech(value) { current = value; },
    reconcileSpeechMicrophone: () => {}, createSpeechApiOperations: () => ({ operations: [], proxies: [] }),
    managerPluginRoutes: {
      registerOperationsAsync: async () => { const original = ++registrations === 1; return { dispose: async () => { if (original) { entered.resolve(); await draining.promise; } } }; },
      registerHttpProxies: () => ({ dispose: async () => {} })
    },
    speechControl: { stopMicrophone: async () => {}, stopPlayback: async () => {} }, speechRuntimeControl: { stop: async () => { stopped++; } },
    speechModelManager: { stop: async () => {} }
  };
  const signal = new AbortController().signal;
  const old = lifecycleModule.createSpeechPluginLifecycle(host, { instanceId: "speech" }, signal), retireOld = await old.prepare();
  old.publication.publish(); await old.publication.afterPublish({ signal, previousRetirement: Promise.resolve() });
  const next = lifecycleModule.createSpeechPluginLifecycle(host, { instanceId: "speech" }, signal), retireNext = await next.prepare();
  next.publication.publish(); const oldWork = retireOld(); await entered.promise;
  await assert.rejects(next.publication.afterPublish({ signal, previousRetirement: Promise.reject(new Error("Controlled kernel retirement deadline.")) }), /retirement deadline/);
  let finished = false; const retiring = retireNext().then(() => { finished = true; });
  try { await tick(); assert.equal(finished, false); assert.equal(stopped, 0); }
  finally { draining.resolve(); }
  await oldWork; await retiring; assert.equal(stopped, 1);
});
