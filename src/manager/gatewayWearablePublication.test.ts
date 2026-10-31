import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { HostService, PluginCandidate, PluginContext, PluginManifest, PluginModule } from "../plugin-kernel/types.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import { GenerationHandoffLease } from "./generationHandoffLease.js";
import { ManagerGatewayRuntimeService } from "./managerGatewayRuntimeService.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createGatewayListenerPublicationHost } from "./gatewayListenerPublication.js";
import { createGatewayListenerRuntime, GATEWAY_LISTENER_PUBLICATION_PREFIX } from "../runtime/gatewayListenerRuntime.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { PassThrough } from "node:stream";
import { WearableCompanionWorkerService } from "./wearableCompanionWorkerService.js";
import type { WearableCompanionRuntimeIdentity } from "./wearableCompanionRuntimeIdentity.js";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type ControlledGatewayDefinition = { id: string };
type ControlledGatewayRuntime = { definition: ControlledGatewayDefinition; needsRestart: boolean };

async function kernelFixture(t: test.TestContext, name: string, services: HostService[]) {
  const entry = path.resolve(`plugins/builtin/io.rabiroute.manager.${name}/1.0.0/manager.mjs`);
  const module: PluginModule = await import(pathToFileURL(entry).href);
  const manifest: PluginManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "rabi.plugin.json"), "utf8"));
  let extra: ((context: PluginContext) => void) | undefined;
  let expectedShutdownFailure: RegExp | undefined;
  const releases: Array<() => void> = [];
  const kernel = new GenerationRuntime({ host: "manager", hostServices: services,
    applicationIdentity: { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager" },
    executor: { async prepare() {
      const after = extra; extra = undefined;
      return { async activate(context) { await module.activate(context); after?.(context); } };
    } }
  });
  const candidate = (revision: string, config: unknown = {}): PluginCandidate => ({
    instanceId: `manager:${name}`, revision, manifest, config, entry: { execution: "in_process", path: entry },
    policy: { resources: { maxChildProcesses: 1, shutdownTimeoutMs: 1000 },
      restart: { mode: "never", maxAttempts: 0, windowMs: 1000, initialBackoffMs: 1, maximumBackoffMs: 1 } }
  });
  t.after(async () => {
    for (const release of releases) release();
    if (expectedShutdownFailure) await assert.rejects(kernel.dispose(), expectedShutdownFailure);
    else await kernel.dispose();
  });
  return { kernel, candidate, extra(value: (context: PluginContext) => void) { extra = value; },
    expectShutdownFailure(value: RegExp) { expectedShutdownFailure = value; },
    releaseOnCleanup(value: () => void) { releases.push(value); } };
}

async function gatewayFixture(t: test.TestContext, readOnly = false) {
  const lease = new GenerationHandoffLease();
  let kernel: GenerationRuntime | undefined;
  const listenerRegistry = new ManagerPluginRouteRegistry(() => new Set(kernel?.current().records
    .filter(record => record.status === "active").map(record => record.identity.activationId) ?? []));
  const listenerHost = createGatewayListenerPublicationHost(listenerRegistry);
  const actions: string[] = [], stopped: string[] = [];
  const records = new Map(["start", "stop", "restart"].map(id => [id, { definition: { id }, needsRestart: false }]));
  const running = new Set(["stop", "restart"]);
  const service = new ManagerGatewayRuntimeService<ControlledGatewayDefinition, ControlledGatewayRuntime>(records, {
    loadDefinitions: () => [], normalizeDefinition: value => value, definitionFingerprint: value => value.id,
    createRuntime: definition => ({ definition, needsRestart: false }), isRunning: value => running.has(value.definition.id),
    reconcileAction: value => value.definition.id === "start" ? "start" : value.definition.id === "stop" ? "stop" : "restart",
    startRuntime: value => { actions.push(`start:${value.definition.id}`); running.add(value.definition.id); },
    stopRuntime: value => { actions.push(`stop:${value.definition.id}`); running.delete(value.definition.id); }
  });
  const registrations: { dispose(): Promise<void> }[] = [];
  let nextDrain: Promise<void> | undefined;
  const host = { managerReadOnly: readOnly, managerServicesReady: true,
    createGatewayListenerProjection: () => listenerHost.project(),
    createGatewayControlOperations: () => [],
    acquireGatewayRuntimePluginLease: () => lease.acquire(),
    syncRunningGateways() { assert.equal(lease.active, true); service.reconcile(); },
    manualTriggerProcesses: { async stopOwner(owner: string) { stopped.push(owner); } },
    async stopAllGatewaysAndWait() { stopped.push("gateways"); service.stopAll(); },
    managerPluginRoutes: { async registerOperationsAsync() {
      const drain = nextDrain; nextDrain = undefined;
      let retirement: Promise<void> | undefined;
      const registration = { dispose: () => retirement ??= Promise.resolve(drain) };
      registrations.push(registration); return registration;
    } }
  };
  const fixture = await kernelFixture(t, "gateway-runtime", [
    { capability: "host.manager.gateway-runtime@1", value: host }, { capability: "manager.core@1", value: {} }
  ]);
  kernel = fixture.kernel;
  t.after(() => listenerHost.dispose());
  return { ...fixture, host, listenerHost, listenerRegistry, actions, stopped, lease, registrations, drain(value: Promise<void>) { nextDrain = value; } };
}

test("Gateway candidate effects and required-capability failure never acquire the published lease or reconcile", async t => {
  const f = await gatewayFixture(t), prepared = gate(), release = gate();
  f.releaseOnCleanup(release.release);
  f.extra(context => context.effects.add(async () => { prepared.release(); await release.promise; return () => {}; }));
  const switching = f.kernel.switch([f.candidate("unpublished")], { readyRequires: ["fixture.missing@1"] });
  const rejected = assert.rejects(switching, /required plugin capabilities/i);
  await prepared.promise;
  assert.equal(f.lease.size, 0); assert.deepEqual(f.actions, []); assert.deepEqual(f.stopped, []);
  release.release(); await rejected;
  assert.equal(f.lease.size, 0); assert.deepEqual(f.actions, []); assert.deepEqual(f.stopped, []);
});

test("Gateway failed replacement and publication rollback preserve old gateways and the original lease", async t => {
  const f = await gatewayFixture(t);
  await f.kernel.switch([f.candidate("one")]);
  const actions = [...f.actions]; assert.deepEqual(actions, ["start:start", "stop:stop", "stop:restart", "start:restart"]);
  f.extra(context => context.effects.add(() => { throw new Error("candidate failed"); }));
  await f.kernel.switch([f.candidate("bad-effect")]);
  assert.equal(f.lease.size, 1); assert.deepEqual(f.actions, actions); assert.deepEqual(f.stopped, []);
  f.extra(context => context.publication.add({ publish() { throw new Error("publication failed"); }, rollback() {} }));
  await assert.rejects(f.kernel.switch([f.candidate("bad-publish")]), /publication failed/);
  assert.equal(f.lease.size, 1); assert.deepEqual(f.actions, actions); assert.deepEqual(f.stopped, []);
});

test("Gateway handoff waits for old accepted work without stopping shared processes, then revision rollback and final disposal join once", async t => {
  const f = await gatewayFixture(t), slow = gate(), published = gate();
  f.releaseOnCleanup(slow.release); f.drain(slow.promise);
  await f.kernel.switch([f.candidate("one")]);
  const actions = [...f.actions];
  f.extra(context => context.publication.add({ publish() { published.release(); }, rollback() {} }));
  const switching = f.kernel.switch([f.candidate("two")]);
  await published.promise; await tick();
  assert.equal(f.lease.size, 1); assert.equal(f.lease.active, true); assert.deepEqual(f.actions, actions); assert.deepEqual(f.stopped, []);
  slow.release(); await switching;
  assert.equal(f.lease.size, 1); assert.deepEqual(f.stopped, []);
  assert.equal(f.actions.length > actions.length, true);
  await f.registrations[0]!.dispose(); assert.deepEqual(f.stopped, []);
  await f.kernel.switch([f.candidate("one")]); assert.equal(f.lease.size, 1); assert.deepEqual(f.stopped, []);
  await Promise.all([f.kernel.dispose(), f.kernel.dispose()]);
  assert.equal(f.lease.active, false); assert.deepEqual(f.stopped, ["manager:gateway-runtime", "gateways"]);
});

test("Gateway read-only publication keeps reconciliation disabled", async t => {
  const f = await gatewayFixture(t, true);
  await f.kernel.switch([f.candidate("read-only")]); assert.deepEqual(f.actions, []);
});

test("Gateway final disposal still joins native shutdown after route cleanup fails and duplicate disposal does not replay it", async t => {
  const f = await gatewayFixture(t), started = gate(), nativeClosed = gate();
  f.releaseOnCleanup(nativeClosed.release);
  await f.kernel.switch([f.candidate("one")]);
  f.registrations[0]!.dispose = async () => { throw new Error("controlled route disposal failure"); };
  f.expectShutdownFailure(/Plugin cleanup failed during shutdown/);
  let nativeStops = 0, done = false;
  f.host.stopAllGatewaysAndWait = async () => { nativeStops++; started.release(); await nativeClosed.promise; };
  const first = f.kernel.dispose(), second = f.kernel.dispose();
  const joined = Promise.all([
    assert.rejects(first, /Plugin cleanup failed during shutdown/),
    assert.rejects(second, /Plugin cleanup failed during shutdown/)
  ]).then(() => { done = true; });
  await started.promise; await tick();
  assert.equal(done, false); assert.equal(f.lease.active, false); assert.equal(nativeStops, 1);
  nativeClosed.release(); await joined;
  assert.equal(nativeStops, 1); assert.deepEqual(f.stopped, ["manager:gateway-runtime"]);
});

function nativeGatewayPublication(t: test.TestContext, fixture: Awaited<ReturnType<typeof gatewayFixture>>) {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 62001, exitCode: null, signalCode: null, stdout });
  const processIdentity = { gatewayId: "fixture-gateway", gatewayGenerationId: "fixture-gateway-generation" };
  const detach = fixture.listenerHost.attach(child as unknown as ChildProcess, processIdentity);
  let publications = 0;
  const native = createGatewayListenerRuntime({ identity: { ...processIdentity, pid: child.pid },
    publish(value) { publications++; stdout.write(GATEWAY_LISTENER_PUBLICATION_PREFIX + JSON.stringify(value) + "\n"); } });
  const listener = native.registerExternalListener("fixture-native", {
    listenerId: native.operationId("listener"), protocol: "fixture-native", invocation: "native",
    address: { protocol: "http", hostname: "127.0.0.1", port: 32123 },
    authentication: { kind: "none", description: "Controlled native listener metadata; no server is started." }
  });
  listener.registerOperations([{ contract: fixtureApiContract({ operationId: native.operationId("record") }),
    handler: async () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  t.after(async () => { detach(); await native.dispose(); stdout.destroy(); });
  const operation = () => {
    const value = fixture.listenerRegistry.catalogSnapshot().operations.find(item => item.binding);
    assert.ok(value); return value;
  };
  return { child, operation, publications: () => publications };
}

test("actual Gateway plugin projects preserved native metadata only after publication and isolates failed candidates", async t => {
  const f = await gatewayFixture(t), native = nativeGatewayPublication(t, f), prepared = gate(), release = gate();
  f.releaseOnCleanup(release.release);
  assert.equal(f.listenerRegistry.catalogSnapshot().listeners.length, 0);
  f.extra(context => context.effects.add(async () => { prepared.release(); await release.promise; return () => {}; }));
  const first = f.kernel.switch([f.candidate("one")]); await prepared.promise;
  assert.equal(f.listenerRegistry.catalogSnapshot().listeners.length, 0);
  release.release(); await first;
  const original = native.operation(), count = native.publications();
  assert.equal(original.owner.revision, "one");
  f.extra(context => context.effects.add(() => { throw new Error("projection candidate failure"); }));
  await f.kernel.switch([f.candidate("failed-effect")]);
  f.extra(context => context.publication.add({ publish() { throw new Error("projection publication failure"); }, rollback() {} }));
  await assert.rejects(f.kernel.switch([f.candidate("failed-publication")]), /projection publication failure/);
  const retained = native.operation();
  assert.equal(retained.owner.activationId, original.owner.activationId);
  assert.equal(retained.binding!.leaseId, original.binding!.leaseId);
  assert.equal(f.listenerRegistry.catalogSnapshot().listeners.length, 1);
  assert.equal(native.child.stdout.listenerCount("data"), 1); assert.equal(native.publications(), count);
  assert.deepEqual(f.stopped, []);
});

test("actual Gateway projection handoff and rollback reuse the one parser and child cache while old operations drain", async t => {
  const f = await gatewayFixture(t), native = nativeGatewayPublication(t, f), slow = gate(), published = gate();
  f.releaseOnCleanup(slow.release); f.drain(slow.promise);
  await f.kernel.switch([f.candidate("one")]); const old = native.operation(), count = native.publications();
  f.extra(context => context.publication.add({ publish() { published.release(); }, rollback() {} }));
  const switching = f.kernel.switch([f.candidate("two")]); await published.promise; await tick();
  const replacement = native.operation();
  assert.equal(replacement.owner.revision, "two"); assert.notEqual(replacement.owner.activationId, old.owner.activationId);
  assert.equal(replacement.binding!.leaseId, old.binding!.leaseId); assert.equal(replacement.contractDigest, old.contractDigest);
  assert.equal(f.listenerRegistry.catalogSnapshot().listeners.length, 1);
  assert.equal(native.child.pid, 62001); assert.equal(native.child.stdout.listenerCount("data"), 1);
  slow.release(); await switching;
  assert.equal(native.operation().owner.activationId, replacement.owner.activationId); assert.deepEqual(f.stopped, []);
  await f.kernel.switch([f.candidate("one")]);
  assert.equal(native.operation().owner.revision, "one"); assert.equal(native.publications(), count);
  await Promise.all([f.kernel.dispose(), f.kernel.dispose()]);
  assert.equal(f.listenerRegistry.catalogSnapshot().listeners.length, 0);
  assert.equal(native.child.stdout.listenerCount("data"), 1, "Activation cleanup cannot dispose the Manager-lifetime parser host.");
});

class ControlledChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  constructor(readonly pid: number) { super(); }
  kill() { this.killed = true; return true; }
}

async function wearableFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wearable-publication-"));
  const runtime: WearableCompanionRuntimeIdentity = { schemaVersion: 1, hostOwned: true,
    managerBaseUrl: "http://127.0.0.1:1", applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager",
    runtimeRoot: root, stateRoot: path.join(root, "state"), logRoot: path.join(root, "logs"),
    pwshPath: path.join(root, "pwsh.exe"), environment: {} };
  const children: ControlledChild[] = [], closed: number[] = [], stopping: number[] = [];
  const startup = gate();
  let nativeCloseGate: Promise<void> | undefined, stoppingSignal: (() => void) | undefined;
  const registry = new ProcessLeaseRegistry(async child => {
    const current = children.find(item => item.pid === child.pid); assert.ok(current);
    stopping.push(current.pid); current.exitCode = 0; current.emit("exit", 0); stoppingSignal?.();
    const closeAfter = nativeCloseGate;
    void Promise.resolve(closeAfter).then(() => { closed.push(current.pid); current.emit("close", 0); });
  });
  const workers = new WearableCompanionWorkerService(runtime, registry, { startupReady: startup.promise,
    isFile: () => true, spawn: () => {
      const child = new ControlledChild(61000 + children.length); children.push(child);
      // The ChildProcess boundary is deliberately replaced by this controlled emitter.
      return child as unknown as ChildProcess;
    } });
  const f = await kernelFixture(t, "wearable-companion", [
    { capability: "host.manager.wearable-companion-runtime@1", value: runtime },
    { capability: "host.manager.wearable-companion@1", value: workers }
  ]);
  f.releaseOnCleanup(startup.release);
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...f, root, runtime, workers, registry, children, closed, stopping, ready: startup.release,
    holdClose(value: Promise<void>, signal: () => void) { nativeCloseGate = value; stoppingSignal = signal; } };
}

test("Wearable candidate failure with an already-ready Manager performs no launch or state-directory write", async t => {
  const f = await wearableFixture(t), prepared = gate(), release = gate(); f.ready(); f.releaseOnCleanup(release.release);
  f.extra(context => context.effects.add(async () => { prepared.release(); await release.promise; return () => {}; }));
  const switching = f.kernel.switch([f.candidate("unpublished")], { readyRequires: ["fixture.missing@1"] });
  const rejected = assert.rejects(switching, /required plugin capabilities/i);
  await prepared.promise;
  assert.equal(f.children.length, 0); assert.equal(fs.existsSync(f.runtime.stateRoot), false);
  release.release(); await rejected; assert.equal(f.children.length, 0); assert.equal(f.registry.list().length, 0);
  f.extra(context => context.publication.add({ publish() { throw new Error("wearable publication failed"); }, rollback() {} }));
  await assert.rejects(f.kernel.switch([f.candidate("publication-failed")]), /wearable publication failed/);
  assert.equal(f.children.length, 0); assert.equal(fs.existsSync(f.runtime.logRoot), false);
});

test("Wearable publication preserves Host READY and replacement waits for actual native close, including revision rollback", async t => {
  const f = await wearableFixture(t);
  await f.kernel.switch([f.candidate("one")]); assert.equal(f.children.length, 0);
  f.ready(); await tick(); assert.equal(f.children.length, 1);
  const first = f.registry.list()[0]!, oldClose = gate(), stopStarted = gate();
  f.releaseOnCleanup(oldClose.release); f.holdClose(oldClose.promise, stopStarted.release);
  const switching = f.kernel.switch([f.candidate("two")]); await stopStarted.promise; await tick();
  assert.equal(f.children[0]!.exitCode, 0); assert.equal(f.closed.length, 0);
  assert.equal(f.children.length, 1, "exit alone must not start replacement");
  oldClose.release(); await switching; await tick();
  assert.deepEqual(f.closed, [first.child.pid]); assert.equal(f.children.length, 2); assert.equal(f.registry.list().length, 1);
  const current = f.registry.list()[0]!; assert.notEqual(current.owner.activationId, first.owner.activationId);
  await f.kernel.switch([f.candidate("one")]); await tick();
  assert.equal(f.children.length, 3); assert.equal(f.registry.list().length, 1);
  await Promise.all([f.kernel.dispose(), f.kernel.dispose()]);
  assert.equal(f.registry.list().length, 0); assert.equal(f.stopping.length, 3); assert.equal(f.closed.length, 3);
});

test("Wearable failed replacement leaves the old process lease untouched", async t => {
  const f = await wearableFixture(t); f.ready();
  await f.kernel.switch([f.candidate("one")]); await tick(); const original = f.registry.list()[0]!;
  f.extra(context => context.effects.add(() => { throw new Error("wearable effect failed"); }));
  await f.kernel.switch([f.candidate("effect-failed")]);
  f.extra(context => context.publication.add({ publish() { throw new Error("wearable pointer failed"); }, rollback() {} }));
  await assert.rejects(f.kernel.switch([f.candidate("publication-failed")]), /wearable pointer failed/);
  assert.equal(f.children.length, 1); assert.deepEqual(f.stopping, []); assert.equal(f.registry.list()[0]!.id, original.id);
});

test("Wearable unconfirmed predecessor close blocks replacement and cannot trigger a late spawn", async t => {
  const f = await wearableFixture(t); f.ready();
  const first = f.candidate("one");
  await f.kernel.switch([{ ...first, policy: { ...first.policy!, resources: { maxChildProcesses: 1, shutdownTimeoutMs: 20 } } }]);
  const oldClose = gate(), stopStarted = gate();
  f.releaseOnCleanup(oldClose.release); f.holdClose(oldClose.promise, stopStarted.release);
  const result = await f.kernel.switch([f.candidate("blocked")]);
  assert.equal(f.children.length, 1); assert.equal(f.closed.length, 0);
  assert.equal(result.generation.records[0]!.status, "failed");
  assert.equal(result.generation.cleanupDiagnostics.some(item => item.message.includes("timed out")), true);
  oldClose.release(); await tick(); await tick();
  assert.equal(f.children.length, 1); assert.equal(f.closed.length, 1);
});

test("Wearable disposal before Host READY prevents delayed spawn and remains idempotent", async t => {
  const f = await wearableFixture(t);
  await f.kernel.switch([f.candidate("one")]);
  await Promise.all([f.kernel.dispose(), f.kernel.dispose()]); f.ready(); await tick();
  assert.equal(f.children.length, 0); assert.equal(f.registry.list().length, 0); assert.equal(fs.existsSync(f.runtime.stateRoot), false);
});
