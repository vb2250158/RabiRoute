import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import test, { type TestContext } from "node:test";
import { GenerationRuntime, DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS } from "../plugin-kernel/generationRuntime.js";
import { PluginPackageCatalog, loadPluginProfile, pluginPackageForCandidate } from "../plugin-kernel/profile.js";
import { currentPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { HostService } from "../plugin-kernel/types.js";
import { ProcessLeaseRegistry } from "../runtime/processLeaseRegistry.js";
import { createFullPluginExecutor } from "./executor.js";
import { declareAsyncPluginService } from "./asyncServiceTransport.js";
import { AsyncPluginOutcomeArchive, outcomeKey } from "./asyncOutcomeArchive.js";
import { ApiContractError } from "../manager/apiOperationContract.js";

type Package = Readonly<{ id: string; source: string; requires?: readonly string[]; provides: readonly string[]; asyncProvides?: Readonly<Record<string, readonly string[]>> }>;
async function fixture(t: TestContext, packages: readonly Package[], hostServices: readonly HostService[] = [], archiveOptions: ConstructorParameters<typeof AsyncPluginOutcomeArchive>[1] = {}, shutdownTimeoutMs = DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-real-caller-"));
  const packageRoot = path.join(root, "packages");
  for (const plugin of packages) {
    const directory = path.join(packageRoot, plugin.id, "1.0.0"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "manager.mjs"), plugin.source);
    await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: plugin.id, version: "1.0.0", entries: { manager: { execution: "isolated", module: "./manager.mjs" } }, provides: plugin.provides, requires: plugin.requires ?? [], optional: [], permissions: [] }));
    if (plugin.asyncProvides) await fs.writeFile(path.join(directory, "rabi.async-services.json"), JSON.stringify({ schemaVersion: 1, provides: Object.fromEntries(Object.entries(plugin.asyncProvides).map(([capability, methods]) => [capability, { kind: "async-methods", methods }])) }));
  }
  const profilePath = path.join(root, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: packages.map(plugin => ({ id: plugin.id, package: plugin.id, version: "1.0.0", enabled: true, config: { label: plugin.id }, grants: [], policy: { resources: { maxChildProcesses: 2, shutdownTimeoutMs } } })) }));
  const observed: { child: ChildProcess; closed: Promise<void>; closeObserved: boolean }[] = [];
  const diagnostics = channel("child_process");
  const observe = (message: unknown) => {
    const child = (message as { process: ChildProcess }).process;
    const row = { child, closed: Promise.resolve(), closeObserved: false };
    row.closed = new Promise(resolve => child.once("close", () => { row.closeObserved = true; resolve(); })); observed.push(row);
  };
  diagnostics.subscribe(observe);
  const catalog = new PluginPackageCatalog([packageRoot]), leases = new ProcessLeaseRegistry();
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "outcomes"), archiveOptions);
  let lastAsyncObservation: import("./bridge/executor.mjs").RuntimeObservation | undefined;
  let diagnosticFailure = false;
  const executor = createFullPluginExecutor(leases, archive, observation => { lastAsyncObservation = observation; if (diagnosticFailure) throw new Error("fixture-only diagnostic observer failure"); }), lifecycleFailures: unknown[] = [];
  const runtimes: GenerationRuntime[] = [];
  const runtime = new GenerationRuntime({ host: "manager", executor, hostServices, activationTimeoutMs: 1000, applicationIdentity: { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }, onRuntimeFailure: failure => { lifecycleFailures.push(failure); } });
  runtimes.push(runtime);
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [() => Promise.allSettled(runtimes.map(owner => owner.shutdown())).then(results => { const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []); if (errors.length) throw new AggregateError(errors, "Original fixture runtimes did not all retire."); }), () => archive.dispose(), () => catalog.dispose(), () => leases.disposeAll()]) try { await close(); } catch (error) { failures.push(error); }
    diagnostics.unsubscribe(observe);
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([Promise.all(observed.map(row => row.closed)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned caller fixture child close is unconfirmed.")), 3000); })]); }
    finally { clearTimeout(timer); }
    assert.ok(observed.every(row => row.closeObserved));
    assert.equal(leases.list().length, 0);
    await fs.rm(root, { recursive: true });
    if (failures.length) throw new AggregateError(failures, "Actual caller fixture cleanup failed.");
  });
  let loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "immutable"), host: "manager" });
  assert.equal(loaded.loadFailures.length, 0);
  assert.ok(loaded.candidates.every(candidate => pluginPackageForCandidate(candidate)?.revision === candidate.revision));
  return { loaded, runtime, leases, archive, executor, root, packageRoot, lifecycleFailures,
    observedChildren: observed,
    asyncObservation: () => lastAsyncObservation,
    failDiagnostic: () => { diagnosticFailure = true; },
    anotherRuntime() { const owner = new GenerationRuntime({ host: "manager", executor, hostServices, activationTimeoutMs: 1000, applicationIdentity: { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }, onRuntimeFailure: failure => { lifecycleFailures.push(failure); } }); runtimes.push(owner); return owner; },
    async reload() { loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "immutable"), host: "manager", previous: loaded }); return loaded; }
  };
}

test("real factory and normal PackageCatalog wire two async providers and original activation ALS", { timeout: 15000 }, async t => {
  const owners: string[] = [];
  const service = declareAsyncPluginService({ async run(input: string) { const identity = currentPluginActivation(); assert.ok(identity); owners.push(identity.instanceId); return input + ":host"; } }, ["run"]);
  const f = await fixture(t, [
    { id: "org.example.provider", requires: ["host.fixture@1"], provides: ["fixture.provider@1"], asyncProvides: { "fixture.provider@1": ["run"] }, source: `export function activate(c){c.services.provide('fixture.provider@1',{async run(value){return (await c.services.require('host.fixture@1').run(value))+':provider';}});}` },
    { id: "org.example.consumer", requires: ["fixture.provider@1"], provides: ["fixture.consumer@1"], asyncProvides: { "fixture.consumer@1": ["run"] }, source: `export function activate(c){c.services.provide('fixture.consumer@1',{async run(value){return (await c.services.require('fixture.provider@1').run(value))+':consumer';}});}` }
  ], [{ capability: "host.fixture@1", value: service }]);
  const result = await f.runtime.switch(f.loaded.candidates);
  assert.deepEqual(result.generation.records.map(row => row.status), ["active", "active"], JSON.stringify(result.generation.records.map(row => ({ status: row.status, error: row.error }))));
  const consumer = result.generation.services.services.get("fixture.consumer@1")?.value as { run(value: string): Promise<string> };
  assert.equal(await consumer.run("input"), "input:host:provider:consumer");
  assert.deepEqual(owners, ["org.example.provider"]); assert.equal(f.leases.list().length, 2);
  assert.equal(f.archive.snapshot().writes, 0, "ordinary startup and successful calls perform no archive fsync");
});

const fixedRequestSource = (capability: string): string => `import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';crypto.randomUUID=()=> 'fixture.shared-request';syncBuiltinESMExports();export async function activate(c){try{await c.services.require('host.fixture@1').run();}catch(e){c.services.provide(${JSON.stringify(capability)},{operationId:e.operationId,effectOutcome:e.effectOutcome});}}`;

test("actual factory namespaces one requestId independently across two real child owners", { timeout: 15000 }, async t => {
  let calls = 0;
  const service = declareAsyncPluginService({ async run() { calls++; const owner = currentPluginActivation(); assert.ok(owner); throw new ApiContractError(500, "FIXTURE_UNKNOWN", "operation", owner.instanceId + ".original", true, "unknown"); } }, ["run"]);
  const f = await fixture(t, [
    { id: "org.example.first", requires: ["host.fixture@1"], provides: ["fixture.first@1"], asyncProvides: {}, source: fixedRequestSource("fixture.first@1") },
    { id: "org.example.second", requires: ["host.fixture@1"], provides: ["fixture.second@1"], asyncProvides: {}, source: fixedRequestSource("fixture.second@1") }
  ], [{ capability: "host.fixture@1", value: service }]);
  const result = await f.runtime.switch(f.loaded.candidates);
  const originals = [];
  for (const row of result.generation.records) {
    assert.equal(row.status, "active"); await f.archive.joinScope(row.identity);
    const original = await f.executor.readAsyncOutcome(row.identity, "fixture.shared-request"); assert.ok(original); assert.equal(original.archive, "confirmed");
    const native = original.record.firstObservation.nativeOutcome as { operationId: string };
    assert.equal(native.operationId, row.identity.instanceId + ".original"); assert.equal(original.record.identity.activationId, row.identity.activationId); originals.push(original);
  }
  assert.equal(calls, 2); assert.notEqual(originals[0].record.identity.activationId, originals[1].record.identity.activationId);
});

test("actual activation history evicts hot metadata but original unknown stays cold-readable", { timeout: 20000 }, async t => {
  let calls = 0;
  const service = declareAsyncPluginService({ async run() { calls++; throw new ApiContractError(500, "FIXTURE_UNKNOWN", "operation", "fixture.history." + calls, true, "unknown"); } }, ["run"]);
  const id = "org.example.history", source = fixedRequestSource("fixture.history@1");
  const f = await fixture(t, [{ id, requires: ["host.fixture@1"], provides: ["fixture.history@1"], asyncProvides: {}, source }], [{ capability: "host.fixture@1", value: service }], { hotLimit: 2 });
  const identities = [];
  let loaded = f.loaded;
  for (let revision = 0; revision < 3; revision++) {
    if (revision) { await fs.writeFile(path.join(f.packageRoot, id, "1.0.0/manager.mjs"), source + "\n// immutable revision " + revision); loaded = await f.reload(); }
    const result = await f.runtime.switch(loaded.candidates), owner = result.generation.records[0].identity;
    assert.equal(result.generation.records[0].status, "active"); await f.archive.joinScope(owner); identities.push(owner);
  }
  assert.equal(f.archive.snapshot().hot, 2); assert.equal(calls, 3);
  const oldest = await f.executor.readAsyncOutcome(identities[0], "fixture.shared-request"); assert.ok(oldest); assert.equal(oldest.archive, "confirmed");
  assert.equal((oldest.record.firstObservation.nativeOutcome as { operationId: string }).operationId, "fixture.history.1");
  assert.equal(oldest.record.identity.activationId, identities[0].activationId); assert.notEqual(identities[0].activationId, identities[2].activationId);
});

test("unarchived capacity is local; declared reads and real probes progress until original archive is repaired", { timeout: 20000 }, async t => {
  let writes = 0, reads = 0;
  const service = declareAsyncPluginService({ async run() { writes++; throw new ApiContractError(500, "FIXTURE_UNKNOWN", "operation", "fixture.capacity.original", true, "unknown"); }, async read() { reads++; return "available"; } }, ["run", "read"], { run: "mutation", read: "read" });
  const source = `import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';const original=crypto.randomUUID;let next=0;crypto.randomUUID=()=>++next===1?'fixture.capacity.original-request':original();syncBuiltinESMExports();export async function activate(c){const api=c.services.require('host.fixture@1');try{await api.run();}catch{}c.services.provide('fixture.control@1',{async run(){try{await api.run();}catch(e){return {mutationOutcome:e.mutationOutcome,code:e.code};}},async read(){return api.read();}});}`;
  const f = await fixture(t, [{ id: "org.example.capacity", requires: ["host.fixture@1"], provides: ["fixture.control@1"], asyncProvides: { "fixture.control@1": ["run", "read"] }, source }], [{ capability: "host.fixture@1", value: service }], { pendingLimitPerPlugin: 1 });
  await fs.writeFile(f.archive.root, "fixture-owned blocking file");
  try {
    const result = await f.runtime.switch(f.loaded.candidates), identity = result.generation.records[0].identity;
    assert.equal(result.generation.records[0].status, "active"); await assert.rejects(f.archive.flushScope(identity));
    const key = outcomeKey(identity, "fixture.capacity.original-request");
    let nativeCode: string | undefined;
    try { await fs.readFile(path.join(f.archive.root, key.slice(0, 2), key + ".json")); } catch (error) { nativeCode = (error as NodeJS.ErrnoException).code; }
    assert.ok(nativeCode === "ENOENT" || nativeCode === "ENOTDIR");
    if (nativeCode === "ENOENT") { const pending = await f.executor.readAsyncOutcome(identity, "fixture.capacity.original-request"); assert.ok(pending); assert.equal(pending.archive, "unconfirmed"); }
    else await assert.rejects(f.executor.readAsyncOutcome(identity, "fixture.capacity.original-request"), { code: "OUTCOME_FIRST_UNAVAILABLE" });
    const control = result.generation.services.services.get("fixture.control@1")?.value as { run(): Promise<{ mutationOutcome: string; code: string }>; read(): Promise<string> };
    const rejected = await control.run(); assert.equal(rejected.mutationOutcome, "not_started"); assert.equal(rejected.code, "RPC_OUTCOME_CAPACITY"); assert.equal(writes, 1);
    assert.equal(await control.read(), "available"); await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(reads, 1); assert.deepEqual(f.lifecycleFailures, []); assert.equal(f.leases.list().length, 1);
  } finally {
    assert.equal(await fs.readFile(f.archive.root, "utf8"), "fixture-owned blocking file"); await fs.unlink(f.archive.root);
    await f.archive.dispose();
  }
  assert.equal(writes, 1, "repair archives the original fact; it never repeats the synthetic mutation");
});

test("late original host settlement completes the same SDK retirement and cold first/current facts", { timeout: 20000 }, async t => {
  let entered!: () => void, finish!: () => void, original: ReturnType<typeof currentPluginActivation>, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const service = declareAsyncPluginService({ async run() { calls++; original = currentPluginActivation(); entered(); await pending; return { operationId: "fixture.late.original", value: "done" }; } }, ["run"]);
  const source = "import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';crypto.randomUUID=()=> 'fixture.late-request';syncBuiltinESMExports();export async function activate(c){await c.services.require('host.fixture@1').run();}";
  const f = await fixture(t, [{ id: "org.example.late-owner", requires: ["host.fixture@1"], provides: [], asyncProvides: {}, source }], [{ capability: "host.fixture@1", value: service }], {}, 150);
  const switching = f.runtime.switch(f.loaded.candidates);
  try {
    await Promise.race([started, switching.then(result => { throw new Error("Host gate never entered: " + JSON.stringify(result.generation.records.map(row => ({ status: row.status, error: row.error })))); })]); assert.ok(original);
    const child = f.leases.list()[0].child;
    await new Promise<void>(resolve => child.once("close", () => resolve()));
    await f.archive.joinScope(original);
    const failedGeneration = await switching;
    assert.equal(failedGeneration.generation.records[0].status, "failed", "local unknown must not block the generation switch");
    let retired = false;
    const retirement = f.runtime.shutdown().then(() => { retired = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(retired, false, "the original SDK scope still owns the unsettled host work after child close");
    const first = await f.executor.readAsyncOutcome(original, "fixture.late-request"); assert.ok(first); assert.equal(first.record.current.executionOutcome, "running");
    finish(); const result = await switching; await retirement; assert.equal(retired, true);
    assert.equal(calls, 1); assert.equal(result.generation.records[0].status, "failed"); assert.equal(f.leases.list().length, 0);
    const snapshot = f.archive.snapshot(); assert.equal(snapshot.pending, 0); assert.equal(snapshot.reservations, 0);
    const final = await f.executor.readAsyncOutcome(original, "fixture.late-request"); assert.ok(final); assert.deepEqual(final.record.firstObservation, first.record.firstObservation); assert.deepEqual(final.record.firstFailure, first.record.firstFailure);
    assert.equal((final.record.current.nativeOutcome as { operationId: string }).operationId, "fixture.late.original"); assert.equal(final.record.current.executionOutcome, "completed");
    assert.equal(snapshot.writes, 2, "only first uncertainty and the genuinely new late outcome are archived");
  } finally { finish(); await switching; }
});

test("the same factory keeps legacy clone-only packages on their existing isolated protocol", { timeout: 15000 }, async t => {
  const f = await fixture(t, [{ id: "org.example.clone", provides: ["fixture.clone@1"], source: `export function activate(c){c.services.provide('fixture.clone@1',{pid:process.pid,label:c.config.label});}` }]);
  const result = await f.runtime.switch(f.loaded.candidates);
  assert.equal(result.generation.records[0].status, "active");
  const value = result.generation.services.services.get("fixture.clone@1")?.value as { pid: number; label: string };
  assert.notEqual(value.pid, process.pid); assert.equal(value.label, "org.example.clone"); assert.equal(f.leases.list().length, 1);
});

test("real factory child import blocking fails locally while unrelated plugin and parent loop progress", { timeout: DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS + 10000 }, async t => {
  const f = await fixture(t, [
    { id: "org.example.blocked", provides: [], asyncProvides: {}, source: "while(true){};export function activate(){}" },
    { id: "org.example.usable", provides: ["fixture.usable@1"], asyncProvides: {}, source: "export function activate(c){c.services.provide('fixture.usable@1',{ready:true});}" }
  ]);
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const result = await f.runtime.switch(f.loaded.candidates);
  assert.equal(result.generation.records.find(row => row.identity.instanceId === "org.example.blocked")?.status, "failed");
  assert.equal(result.generation.records.find(row => row.identity.instanceId === "org.example.usable")?.status, "active");
  assert.ok(ticks > 2); assert.equal((result.generation.services.services.get("fixture.usable@1")?.value as { ready: boolean }).ready, true);
});

test("actual host result body getter is never read after original execution", { timeout: 15000 }, async t => {
  let calls = 0, getterReads = 0, ticks = 0;
  const service = declareAsyncPluginService({ async run() {
    calls++;
    return Object.defineProperty({ operationId: "fixture.body.original" }, "body", { enumerable: true, get() { getterReads++; throw new Error("body getter must not execute"); } });
  } }, ["run"]);
  const f = await fixture(t, [{ id: "org.example.body-getter", requires: ["host.fixture@1"], provides: ["fixture.result@1"], asyncProvides: {}, source: `export async function activate(c){try{await c.services.require('host.fixture@1').run();}catch(e){c.services.provide('fixture.result@1',{operationId:e.operationId,effectOutcome:e.effectOutcome,code:e.code});}}` }], [{ capability: "host.fixture@1", value: service }]);
  const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const result = await f.runtime.switch(f.loaded.candidates), value = result.generation.services.services.get("fixture.result@1")?.value as { operationId: string; effectOutcome: string; code: string };
  assert.equal(result.generation.records[0].status, "active"); assert.equal(calls, 1); assert.equal(getterReads, 0); assert.ok(ticks > 0);
  assert.equal(value.operationId, "fixture.body.original"); assert.equal(value.effectOutcome, "unknown"); assert.equal(value.code, "HOST_RESPONSE_UNAVAILABLE");
});

test("actual host error metadata getters stay inert and native data properties remain unknown", { timeout: 15000 }, async t => {
  let calls = 0, getterReads = 0, ticks = 0;
  const service = declareAsyncPluginService({ async run() {
    calls++;
    const error = Object.assign(new Error(), { operationId: "fixture.error.original", mutationOutcome: "unknown", uncertain: true });
    for (const name of ["details", "code", "message"]) Object.defineProperty(error, name, { configurable: true, get() { getterReads++; throw new Error("error metadata getter must not execute"); } });
    throw error;
  } }, ["run"]);
  const f = await fixture(t, [{ id: "org.example.error-getter", requires: ["host.fixture@1"], provides: ["fixture.result@1"], asyncProvides: {}, source: `export async function activate(c){try{await c.services.require('host.fixture@1').run();}catch(e){c.services.provide('fixture.result@1',{operationId:e.operationId,effectOutcome:e.effectOutcome,mutationOutcome:e.mutationOutcome,uncertain:e.uncertain});}}` }], [{ capability: "host.fixture@1", value: service }]);
  const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  const result = await f.runtime.switch(f.loaded.candidates), value = result.generation.services.services.get("fixture.result@1")?.value as { operationId: string; effectOutcome: string; mutationOutcome: string; uncertain: boolean };
  assert.equal(result.generation.records[0].status, "active"); assert.equal(calls, 1); assert.equal(getterReads, 0); assert.ok(ticks > 0);
  assert.equal(value.operationId, "fixture.error.original"); assert.equal(value.effectOutcome, "unknown"); assert.equal(value.mutationOutcome, "unknown"); assert.equal(value.uncertain, true);
});

test("declared read failures remain RAM diagnostics and do not archive or block probes", { timeout: 15000 }, async t => {
  let calls = 0;
  const service = declareAsyncPluginService({ async run() { calls++; throw new ApiContractError(500, "FIXTURE_READ_FAILED", "read", "fixture.read.operation", true); } }, ["run"], { run: "read" });
  const f = await fixture(t, [{ id: "org.example.read-error", requires: ["host.fixture@1"], provides: ["fixture.result@1"], asyncProvides: {}, source: "export async function activate(c){try{await c.services.require('host.fixture@1').run();}catch(e){c.services.provide('fixture.result@1',{code:e.code,effectOutcome:e.effectOutcome});}}" }], [{ capability: "host.fixture@1", value: service }]);
  const result = await f.runtime.switch(f.loaded.candidates), value = result.generation.services.services.get("fixture.result@1")?.value as { code: string; effectOutcome: string };
  assert.equal(result.generation.records[0].status, "active"); assert.equal(value.code, "FIXTURE_READ_FAILED"); assert.equal(value.effectOutcome, "read_only"); assert.equal(calls, 1);
  assert.equal(f.archive.snapshot().writes, 0); assert.equal(f.archive.snapshot().pending, 0); assert.equal(f.archive.snapshot().reservations, 0);
  await assert.rejects(fs.stat(f.archive.root), { code: "ENOENT" });
});

test("explicit native mutation uncertainty is preserved even if its method was declared read", { timeout: 15000 }, async t => {
  let calls = 0;
  const service = declareAsyncPluginService({ async run() { calls++; throw new ApiContractError(500, "FIXTURE_NATIVE_UNKNOWN", "operation", "fixture.read-contradiction.original", true, "unknown"); } }, ["run"], { run: "read" });
  const f = await fixture(t, [{ id: "org.example.read-contradiction", requires: ["host.fixture@1"], provides: ["fixture.result@1"], asyncProvides: {}, source: fixedRequestSource("fixture.result@1") }], [{ capability: "host.fixture@1", value: service }]);
  const result = await f.runtime.switch(f.loaded.candidates), identity = result.generation.records[0].identity;
  assert.equal(result.generation.records[0].status, "active"); await f.archive.joinScope(identity);
  const original = await f.executor.readAsyncOutcome(identity, "fixture.shared-request"); assert.ok(original); assert.equal(original.archive, "confirmed");
  assert.equal(original.record.firstObservation.effectOutcome, "unknown"); assert.equal((original.record.firstObservation.nativeOutcome as { operationId: string }).operationId, "fixture.read-contradiction.original"); assert.equal(calls, 1);
});

test("more than64 actual unavailable read responses retain bounded diagnostics and perform zero archive IO", { timeout: 20000 }, async t => {
  let calls = 0, getters = 0;
  const service = declareAsyncPluginService({ async read() {
    calls++; return Object.defineProperty({}, "body", { enumerable: true, get() { getters++; throw new Error("fixture getter must stay inert"); } });
  } }, ["read"], { read: "read" });
  const source = `export function activate(c){const api=c.services.require('host.fixture@1');c.services.provide('fixture.read-loop@1',{async run(count){const errors=[];for(let i=0;i<count;i++){try{await api.read();}catch(e){errors.push(e.code);}}return errors;}});}`;
  const f = await fixture(t, [{ id: "org.example.read-loop", requires: ["host.fixture@1"], provides: ["fixture.read-loop@1"], asyncProvides: { "fixture.read-loop@1": ["run"] }, source }], [{ capability: "host.fixture@1", value: service }]);
  const result = await f.runtime.switch(f.loaded.candidates);
  assert.equal(result.generation.records[0].status, "active"); f.failDiagnostic();
  const control = result.generation.services.services.get("fixture.read-loop@1")?.value as { run(count: number): Promise<string[]> };
  const errors = await control.run(96); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(errors.length, 96); assert.ok(errors.every(code => code === "HOST_RESPONSE_UNAVAILABLE"));
  assert.equal(calls, 96); assert.equal(getters, 0); assert.deepEqual(f.lifecycleFailures, []);
  const observation = f.asyncObservation(); assert.ok(observation); assert.ok(observation.calls.length <= 64);
  assert.equal(f.archive.snapshot().readReservations, 0); assert.equal(f.archive.snapshot().writes, 0); assert.equal(f.archive.snapshot().pending, 0);
  await assert.rejects(fs.stat(f.archive.root), { code: "ENOENT" });
});

test("new declared read methods and activations cannot bypass retained read uncertainty admission", { timeout: 20000 }, async t => {
  const calls = { a: 0, b: 0, c: 0 };
  const methods = Object.fromEntries(Object.keys(calls).map(method => [method, async () => { calls[method as keyof typeof calls]++; throw new ApiContractError(500, "FIXTURE_READ_CONTRADICTION", "operation", "fixture.read." + method, true, "unknown"); }])) as { a(): Promise<never>; b(): Promise<never>; c(): Promise<never> };
  const service = declareAsyncPluginService(methods, ["a", "b", "c"], { a: "read", b: "read", c: "read" });
  const id = "org.example.read-admission", source = (method: string) => `export async function activate(c){let result;try{await c.services.require('host.fixture@1').${method}();}catch(e){result={code:e.code,mutationOutcome:e.mutationOutcome};}c.services.provide('fixture.read-result@1',result);}`;
  const f = await fixture(t, [{ id, requires: ["host.fixture@1"], provides: ["fixture.read-result@1"], source: source("a") }], [{ capability: "host.fixture@1", value: service }], { readLimitPerPlugin: 2, pendingLimitPerPlugin: 2 });
  await fs.writeFile(f.archive.root, "fixture-owned read archive failure");
  const identities: import("../plugin-kernel/types.js").PluginIdentity[] = [];
  const originalRequests: string[] = [];
  try {
    for (const [index, method] of ["a", "b", "c", "a"].entries()) {
      const loaded = index ? (await fs.writeFile(path.join(f.packageRoot, id, "1.0.0/manager.mjs"), source(method) + "\n// activation " + index), await f.reload()) : f.loaded;
      const owner = index ? f.anotherRuntime() : f.runtime;
      const result = await owner.switch(loaded.candidates); assert.equal(result.generation.records[0].status, "active");
      identities.push(result.generation.records[0].identity);
      const reply = result.generation.services.services.get("fixture.read-result@1")?.value as { code: string; mutationOutcome: string };
      if (index < 2) {
        assert.equal(reply.code, "FIXTURE_READ_CONTRADICTION"); await assert.rejects(f.archive.flushScope(identities[index]));
        const receipt = (f.asyncObservation()?.calls as { requestId: string; nativeOutcome?: { operationId?: string } }[] | undefined)?.find(row => row.nativeOutcome?.operationId === "fixture.read." + method);
        assert.ok(receipt); originalRequests.push(receipt.requestId);
      }
      else { assert.equal(reply.mutationOutcome, "not_started"); assert.equal(reply.code, index === 2 ? "RPC_READ_CAPACITY" : "RPC_OUTCOME_CAPACITY"); }
    }
    assert.deepEqual(calls, { a: 1, b: 1, c: 0 });
    assert.notEqual(identities[0].activationId, identities[3].activationId);
    assert.equal(f.archive.snapshot().readReservations, 2); assert.equal(f.archive.snapshot().pending, 2); assert.equal(f.archive.snapshot().contradictoryMethods, 2);
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.deepEqual(f.lifecycleFailures, []);
  } finally {
    assert.equal(await fs.readFile(f.archive.root, "utf8"), "fixture-owned read archive failure"); await fs.unlink(f.archive.root);
    const settled = await Promise.allSettled(identities.map(identity => f.archive.flushScope(identity)));
    const errors = settled.flatMap(row => row.status === "rejected" ? [row.reason] : []);
    await f.archive.dispose(); if (errors.length) throw new AggregateError(errors, "Original read facts remain unconfirmed.");
  }
  assert.equal(f.archive.snapshot().readReservations, 0);
  for (const [index, method] of ["a", "b"].entries()) {
    const original = await f.executor.readAsyncOutcome(identities[index], originalRequests[index]); assert.ok(original);
    assert.equal(original.archive, "confirmed"); assert.equal((original.record.firstObservation.nativeOutcome as { operationId: string }).operationId, "fixture.read." + method);
    assert.equal(calls[method as keyof typeof calls], 1);
  }
});

test("settled read without ACK releases RAM admission only after its original child actual close", { timeout: 15000 }, async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const service = declareAsyncPluginService({ async read() { reads++; entered(); await finish; return "original-read-result"; } }, ["read"], { read: "read" });
  const source = `export function activate(c){const api=c.services.require('host.fixture@1');c.services.provide('fixture.close-read@1',{async run(){return api.read();}});}`;
  const f = await fixture(t, [{ id: "org.example.read-close", requires: ["host.fixture@1"], provides: ["fixture.close-read@1"], asyncProvides: { "fixture.close-read@1": ["run"] }, source }], [{ capability: "host.fixture@1", value: service }], { readLimitPerPlugin: 1 });
  let resultPromise: Promise<unknown> | undefined;
  try {
    const result = await f.runtime.switch(f.loaded.candidates), control = result.generation.services.services.get("fixture.close-read@1")?.value as { run(): Promise<string> };
    resultPromise = control.run().then(() => { throw new Error("Original exited child cannot receive its read result."); }, error => error);
    await started; const pid = f.asyncObservation()?.pid; assert.ok(pid);
    const child = f.observedChildren.find(row => row.child.pid === pid); assert.ok(child); assert.equal(child.child.kill("SIGTERM"), true, "terminate only the exact fixture-owned child after host admission"); await child.closed; assert.equal(child.closeObserved, true);
    assert.equal(f.archive.snapshot().readReservations, 1, "actual host work still owns its RAM slot after child close");
    release(); await resultPromise; await f.archive.dispose();
    assert.equal(reads, 1); assert.equal(f.archive.snapshot().readReservations, 0); assert.equal(f.archive.snapshot().writes, 0);
    await assert.rejects(fs.stat(f.archive.root), { code: "ENOENT" });
  } finally { release(); if (resultPromise) await resultPromise; }
});
