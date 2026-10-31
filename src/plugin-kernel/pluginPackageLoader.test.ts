import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { PluginPackageCatalog, loadPluginProfile } from "./profile.js";
import { GenerationRuntime } from "./generationRuntime.js";
import { loadPluginPackage } from "./packageLoader.js";

async function fixture(names: readonly string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-package-process-"));
  const packages = path.join(root, "packages"), runtimeRoot = path.join(root, "runtime"), profilePath = path.join(root, "profile.json");
  for (const name of names) {
    const directory = path.join(packages, "io.test." + name, "1.0.0");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test." + name, version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: ["fixture." + name + "@1"], requires: [], optional: [], permissions: [] }));
    await fs.writeFile(path.join(directory, "manager.mjs"), `export function activate(ctx) { ctx.services.provide(${JSON.stringify("fixture." + name + "@1")}, {}); }`);
  }
  const entries = names.map(name => ({ id: "test:" + name, package: "io.test." + name, version: "1.0.0", enabled: true, config: {}, grants: [] }));
  await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: ["fixture.good@1"], instances: entries }));
  return { root, packages, runtimeRoot, profilePath, entries };
}

async function testWorker(root: string, controlled?: Awaited<ReturnType<typeof fixture>>): Promise<URL> {
  const workerURL = new URL(import.meta.url.endsWith(".ts") ? "./pluginPackageLoadWorker.ts" : "./pluginPackageLoadWorker.js", import.meta.url);
  const target = path.join(root, "fault-worker.mjs");
  // Fault timing exercises process ownership, rather than repeatedly compiling
  // the metadata implementation. Real metadata/immutable copies are prepared
  // before its deadline; the natural-load and batch tests still read in children.
  const prepared = controlled ? Object.fromEntries(await Promise.all(controlled.entries.map(async entry => [entry.package,
    await loadPluginPackage(path.join(controlled.packages, entry.package, entry.version), controlled.runtimeRoot, "manager") ]))) : undefined;
  await fs.writeFile(target, `
import fs from 'node:fs/promises';
import path from 'node:path';
const prepared = ${JSON.stringify(prepared) ?? "undefined"};
async function executePluginPackageLoad(request) {
  if (prepared) {
    const value = request.task.kind === 'profile' ? JSON.parse(await fs.readFile(request.task.profilePath,'utf8')) : prepared[request.task.packageId];
    if (!value) throw new Error('Controlled fixture has no prepared metadata');
    return {id:request.id,ok:true,value};
  }
  const metadata = await import(${JSON.stringify(workerURL.href)});
  return metadata.executePluginPackageLoad(request);
}
process.once('message', async request => {
  if (process.env.PACKAGE_LOADER_PRIVATE_SENTINEL || process.env.NODE_OPTIONS || process.env.RABIROUTE_DESKTOP_IPC_PATH) {
    process.send({id:request.id,ok:false,error:'Unexpected private parent environment'} ,()=>process.disconnect()); return;
  }
  const task = request.task;
  if (task.kind === 'package') {
    await fs.appendFile(${JSON.stringify(path.join(root, "attempts.txt"))}, task.packageId+'\\n');
    if (task.packageId === 'io.test.hung') {
      const stage = path.join(task.runtimeRoot,'.staging',request.id);
      await fs.mkdir(stage,{recursive:true}); await fs.writeFile(path.join(stage,'held.txt'),'unpublished');
      await fs.writeFile(${JSON.stringify(path.join(root, "held-pid.txt.tmp"))}, String(process.pid));
      await fs.rename(${JSON.stringify(path.join(root, "held-pid.txt.tmp"))}, ${JSON.stringify(path.join(root, "held-pid.txt"))});
      while (true) {}
    }
    if (task.packageId === 'io.test.late') {
      const reply = await executePluginPackageLoad(request);
      await fs.writeFile(${JSON.stringify(path.join(root, "reply-pid.txt.tmp"))}, String(process.pid));
      await fs.rename(${JSON.stringify(path.join(root, "reply-pid.txt.tmp"))}, ${JSON.stringify(path.join(root, "reply-pid.txt"))});
      process.send(reply); setInterval(()=>{},1000); return;
    }
  }
  const reply = await executePluginPackageLoad(request);
  process.send(reply,()=>process.disconnect());
});
`);
  return pathToFileURL(target);
}

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Metadata worker did not reach the controlled fault.");
}
type ObservedChild = { process: ChildProcess; closed: boolean };
const observedChildren: ObservedChild[] = [];
const childChannel = channel("child_process");
const observeChild = (message: unknown) => {
  const child = (message as { process: ChildProcess }).process;
  const observed = { process: child, closed: false };
  observedChildren.push(observed);
  child.once("close", () => { observed.closed = true; });
};
childChannel.subscribe(observeChild);
after(() => childChannel.unsubscribe(observeChild));

function assertRetired(child: ObservedChild): void {
  assert.ok(child.closed && (child.process.exitCode !== null || child.process.signalCode !== null),
    `the owned metadata child must really be gone (pid ${child.process.pid}, close=${child.closed}, code=${child.process.exitCode}, signal=${child.process.signalCode})`);
}
function dead(pid: number, workerURL: URL): void {
  const owned = observedChildren.filter(child => child.process.pid === pid && child.process.spawnargs.includes(fileURLToPath(workerURL)));
  assert.ok(owned.length > 0, `the exact owned metadata child must have been observed (pid ${pid})`);
  for (const child of owned) assertRetired(child);
  // close belongs to the original OS process handle. The numeric PID may be
  // recycled during cleanup or healthy activation; never substitute its owner.
  try { process.kill(pid, 0); }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
  console.log(`# metadata child ${pid}: original process handle closed; numeric PID is still visible`);
}

test("the retirement assertion rejects a live process identity and an unconfirmed close", () => {
  assert.throws(() => assertRetired({ process: { pid: process.pid, exitCode: null, signalCode: null } as ChildProcess, closed: false }), /must really be gone/);
  assert.throws(() => assertRetired({ process: { pid: process.pid, exitCode: 0, signalCode: null } as ChildProcess, closed: false }), /must really be gone/);
});

test("metadata child excludes private parent environment, never imports plugin code and exits naturally", { timeout: 15_000 }, async t => {
  const app = await fixture(["good"]), workerURL = await testWorker(app.root);
  await fs.writeFile(path.join(app.packages, "io.test.good/1.0.0/manager.mjs"), "throw new Error('Plugin code must not execute during metadata loading'); export function activate() {};");
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages], loading: { workerURL, timeoutMs: 5000 } });
  t.after(async () => { await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  const keys = ["PACKAGE_LOADER_PRIVATE_SENTINEL", "NODE_OPTIONS", "RABIROUTE_DESKTOP_IPC_PATH"];
  const old = keys.map(key => process.env[key]);
  for (const [index, key] of keys.entries()) process.env[key] = index === 1 ? "--trace-warnings" : "fixture-private";
  try {
    const loaded = await catalog.loadPackage("io.test.good", "1.0.0", app.runtimeRoot, "manager");
    assert.equal(loaded.manifest.id, "io.test.good");
    assert.equal(Object.isFrozen(loaded.manifest.provides), true);
    assert.deepEqual(catalog.snapshot().workerPids, []);
    assert.equal(catalog.snapshot().active, 0);
  } finally { for (const [index, key] of keys.entries()) { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; } }
});

test("a truly hung optional package is killed and joined while healthy packages and the main loop remain available", { timeout: 15_000 }, async t => {
  const app = await fixture(["good", "hung", "other"]), workerURL = await testWorker(app.root, app);
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages], loading: { workerURL, timeoutMs: 3000 } });
  t.after(async () => { await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  await fs.writeFile(app.profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: ["fixture.good@1"], instances: [
    app.entries[0], ...Array.from({ length: 8 }, (_, index) => ({ ...app.entries[1], id: "hung:" + index })), app.entries[2]
  ] }));
  const loading = loadPluginProfile({ profilePath: app.profilePath, packageCatalog: catalog, runtimeRoot: app.runtimeRoot, host: "manager" });
  const pid = Number(await waitForFile(path.join(app.root, "held-pid.txt")));
  const tick = Date.now(); await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(Date.now() - tick < 1000);
  const loaded = await loading;
  assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId), ["test:good", "test:other"]);
  assert.equal(loaded.loadFailures.length, 8);
  assert.ok(loaded.loadFailures.every(failure => /timed out/.test(failure.error.message)));
  assert.equal((await fs.readFile(path.join(app.root, "attempts.txt"), "utf8")).split("io.test.hung").length - 1, 1);
  await dead(pid, workerURL); assert.deepEqual(catalog.snapshot().workerPids, []);
  assert.deepEqual(await fs.readdir(path.join(app.runtimeRoot, ".staging")), []);
});

test("the batch producer applies backpressure instead of rejecting the tail of a valid large Profile", { timeout: 120_000 }, async t => {
  const app = await fixture(["good", ...Array.from({ length: 7 }, (_, index) => "other" + index)]);
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages], loading: { maxConcurrency: 2, maxQueue: 0 } });
  t.after(async () => { await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  const loaded = await loadPluginProfile({ profilePath: app.profilePath, packageCatalog: catalog, runtimeRoot: app.runtimeRoot, host: "manager" });
  assert.equal(loaded.candidates.length, app.entries.length);
  assert.deepEqual(loaded.loadFailures, []);
});

test("dispose cancels queued work and joins the actual running child before declaring the catalog drained", { timeout: 15_000 }, async t => {
  const app = await fixture(["hung", "good"]), workerURL = await testWorker(app.root, app);
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages], loading: { workerURL, maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 } });
  t.after(async () => { await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  const running = catalog.loadPackage("io.test.hung", "1.0.0", app.runtimeRoot, "manager");
  const runningFailure = assert.rejects(running, /stopped during/);
  const pid = Number(await waitForFile(path.join(app.root, "held-pid.txt")));
  const queued = catalog.loadPackage("io.test.good", "1.0.0", app.runtimeRoot, "manager");
  const queuedFailure = assert.rejects(queued, /before loading began/);
  await assert.rejects(catalog.loadPackage("io.test.other", "1.0.0", app.runtimeRoot, "manager"), /queue is full/);
  const disposal = catalog.dispose(); assert.equal(catalog.dispose(), disposal);
  await disposal; await runningFailure; await queuedFailure;
  await dead(pid, workerURL); assert.deepEqual(catalog.snapshot().workerPids, []);
  assert.equal(catalog.snapshot().active, 0); assert.equal(catalog.snapshot().queued, 0);
  assert.equal(await fs.readFile(path.join(app.root, "attempts.txt"), "utf8"), "io.test.hung\n");
  await assert.rejects(catalog.loadPackage("io.test.good", "1.0.0", app.runtimeRoot, "manager"), /disposed/);
});

test("an early metadata reply cannot publish if its child remains alive past the deadline", { timeout: 15_000 }, async t => {
  const app = await fixture(["good", "late"]), workerURL = await testWorker(app.root, app);
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages], loading: { workerURL, timeoutMs: 3000 } });
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(async () => { await runtime.dispose(); await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  const pending = loadPluginProfile({ profilePath: app.profilePath, packageCatalog: catalog, runtimeRoot: app.runtimeRoot, host: "manager" });
  const pid = Number(await waitForFile(path.join(app.root, "reply-pid.txt")));
  assert.equal(runtime.current().sequence, 0);
  const loaded = await pending;
  assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId), ["test:good"]);
  const result = await runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires });
  assert.equal(result.generation.services.services.has("fixture.good@1"), true);
  assert.equal(result.generation.services.services.has("fixture.late@1"), false);
  assert.match(loaded.loadFailures[0]!.error.message, /timed out/);
  await dead(pid, workerURL); assert.deepEqual(catalog.snapshot().workerPids, []);
});

test("inflight metadata is reused and queue waiting consumes the original deadline", { timeout: 15_000 }, async t => {
  const app = await fixture(["hung", "good"]), workerURL = await testWorker(app.root, app);
  const catalog = new PluginPackageCatalog([app.packages], { trustedInProcessRoots: [app.packages],
    loading: { workerURL, maxConcurrency: 1, maxQueue: 1, timeoutMs: 3000 } });
  t.after(async () => { await catalog.dispose(); await fs.rm(app.root, { recursive: true, force: true }); });
  const running = catalog.loadPackage("io.test.hung", "1.0.0", app.runtimeRoot, "manager");
  assert.equal(catalog.loadPackage("io.test.hung", "1.0.0", app.runtimeRoot, "manager"), running);
  const queued = catalog.loadPackage("io.test.good", "1.0.0", app.runtimeRoot, "manager");
  const runningFailure = assert.rejects(running, /timed out/);
  const queueFailure = assert.rejects(queued, /timed out in queue/);
  assert.equal(catalog.snapshot().queued, 1);
  const pid = Number(await waitForFile(path.join(app.root, "held-pid.txt")));
  await queueFailure; await runningFailure;
  await dead(pid, workerURL); assert.equal(catalog.snapshot().queued, 0);
  assert.equal(await fs.readFile(path.join(app.root, "attempts.txt"), "utf8"), "io.test.hung\n");
});
