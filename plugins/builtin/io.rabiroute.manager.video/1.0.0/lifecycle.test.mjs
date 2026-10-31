import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { activate } from "./manager.mjs";
import { register } from "tsx/esm/api";
const loader = register({ namespace: "video-publication-test" });
after(() => loader.unregister());
const { GenerationRuntime } = await loader.import("../../../../src/plugin-kernel/generationRuntime.ts", import.meta.url);
const { ManagerPluginRouteRegistry, createManagerApiOperationsService } = await loader.import("../../../../src/manager/managerPluginRouteRegistry.ts", import.meta.url);
const { createVideoOperations } = await loader.import("../../../../src/manager/videoOperations.ts", import.meta.url);

const manifest = JSON.parse(await fs.readFile(new URL("./rabi.plugin.json", import.meta.url), "utf8"));
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const observed = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); })]); }
  finally { clearTimeout(timer); }
};

async function fixture(t, { readOnly = false, omitCapability, activationTimeoutMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-publication-"));
  const componentRoot = path.join(root, "component"), stateRoot = path.join(root, "state");
  const modules = new WeakMap(), owners = [], events = [], stops = [], publications = [], releases = [];
  let kernel;
  const routes = new ManagerPluginRouteRegistry(() => new Set(kernel.current().records.filter(row => row.status === "active").map(row => row.identity.activationId)));
  const runtimeFor = identity => ({
    stateRoot, componentRoot, readOnly, defaultModelRoot: path.join(root, "models"),
    alive: () => false, requestAccess: () => ({ assert() {}, beforeMutation() {} }), localSettingsAllowed: () => true,
    onExit: () => () => {},
    stop: async () => { stops.push({ identity, kind: "runtime" }); },
    stopInstaller: async () => { stops.push({ identity, kind: "installer" }); },
    stopMediaProbe: async () => { stops.push({ identity, kind: "probe" }); }
  });
  const host = { createRuntime: runtimeFor, createOperations(context) { owners.push(context); return createVideoOperations(context); } };
  kernel = new GenerationRuntime({ host: "manager", activationTimeoutMs, executor: { prepare: async candidate => modules.get(candidate) },
    hostServices: [
      { capability: "manager.core@1", value: Object.freeze({ instanceId: "fixture-core" }) },
      { capability: "host.manager.video@1", value: host },
      { capability: "host.manager.http@1", value: { publishManagerEvent: (...args) => events.push(args), readJsonBody: async () => ({}) } },
      { capability: "host.manager.operations@1", value: createManagerApiOperationsService(routes) }
    ].filter(service => service.capability !== omitCapability), onPublished: () => { routes.refreshPublication(); for (const done of publications.splice(0)) done(); }
  });
  const candidate = (revision, laterEffect, publication) => {
    const value = { instanceId: "manager:video", revision, config: {}, entry: { execution: manifest.entries.manager.execution, path: manifest.entries.manager.module },
      manifest: structuredClone(manifest) };
    modules.set(value, { async activate(context) { await activate(context); if (laterEffect) context.effects.add(laterEffect); if (publication) context.publication.add(publication); } });
    return value;
  };
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url, "http://fixture"), response)) response.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/video/status`;
  t.after(async () => {
    for (const release of releases) release();
    await kernel.dispose().catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const seed = async (status = "running", compute = false) => {
    const id = randomUUID(), directory = path.join(stateRoot, ...(compute ? ["compute"] : []), "jobs");
    const job = { id, model: catalog.models[0].id, status, createdAt: new Date().toISOString(), ...(compute ? { computeOnly: true, computeDeviceId: "fixture-peer" } : {}) };
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${id}.json`); await fs.writeFile(file, JSON.stringify(job)); return { job, file };
  };
  const component = path.join(componentRoot, "inspect-media.py");
  const settings = path.join(stateRoot, "model-directory.json");
  return { kernel, candidate, root, stateRoot, componentRoot, component, settings, owners, stops, events, seed, routes, releases,
    nextPublication: () => new Promise(resolve => publications.push(resolve)),
    send: () => fetch(url).then(async response => ({ status: response.status, body: await response.json() })),
    sendPath: (pathname, method) => fetch(new URL(pathname, url), { method,
      ...(["POST", "PATCH", "PUT"].includes(method) ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) }) };
}

test("async Video route preparation failure closes its candidate without publishing or recovering jobs", async t => {
  const f = await fixture(t), local = await f.seed();
  const original = await fs.readFile(local.file);
  f.routes.registerOperationsAsync = async (_instance, _definitions, signal) => {
    assert.equal(signal instanceof AbortSignal, true);
    await tick();
    throw new Error("controlled async Video registration failure");
  };
  const result = await f.kernel.switch([f.candidate("cancelled")]);
  assert.equal(result.generation.records[0].status, "failed");
  assert.equal(f.routes.snapshot().length, 0);
  assert.ok(f.stops.some(row => row.kind === "runtime"));
  assert.deepEqual(await fs.readFile(local.file), original);
  await assert.rejects(fs.access(f.component));
});

test("failed Video preparation cleanup fences later owners and remains a shutdown failure", async t => {
  const f = await fixture(t);
  f.routes.registerOperationsAsync = async () => {
    f.owners.at(-1).runtime.stopMediaProbe = async () => { throw new Error("fixture media probe stop failed"); };
    throw new Error("fixture async registration failed");
  };
  const failed = await f.kernel.switch([f.candidate("one")]);
  assert.ok(failed.generation.cleanupDiagnostics.some(row => /media probe stop failed/.test(row.message)));
  await f.kernel.switch([f.candidate("two")]);
  assert.equal(f.owners.length, 1);
  await assert.rejects(f.kernel.dispose(), /Plugin cleanup failed/);
});

test("Video retains a late registration and joins its disposer before another native owner", async t => {
  const f = await fixture(t, { activationTimeoutMs: 800 });
  const registered = gate(), enter = gate(), retired = gate(), retiring = gate();
  f.releases.push(registered.resolve, retired.resolve);
  let stops = 0;
  f.routes.registerOperationsAsync = async () => {
    enter.resolve(); await registered.promise;
    return { async dispose() { stops++; retiring.resolve(); await retired.promise; } };
  };
  const item = revision => {
    const candidate = f.candidate(revision);
    candidate.policy = { resources: { maxChildProcesses: 0, shutdownTimeoutMs: 20 },
      restart: { mode: "never", maxAttempts: 0, windowMs: 1000, initialBackoffMs: 1, maximumBackoffMs: 1 } };
    return candidate;
  };
  const switching = f.kernel.switch([item("one")]);
  await observed(Promise.race([enter.promise, switching.then(value => { throw new Error(`Video preparation returned before registration: ${JSON.stringify(value.generation.records)}`); })]), "Video async registration was not reached");
  assert.ok((await observed(switching, "Video preparation deadline did not release the queue")).generation.cleanupDiagnostics.some(row => /timed out/.test(row.message)));
  await observed(f.kernel.switch([item("two")]), "Blocked Video retry did not release the queue"); assert.equal(f.owners.length, 1);
  registered.resolve(); await observed(retiring.promise, "Late Video registration was not disposed");
  await observed(f.kernel.switch([item("three")]), "Video retry did not retain the late disposer fence"); assert.equal(f.owners.length, 1); assert.equal(stops, 1);
  retired.resolve(); for (let i = 0; i < 10; i++) await tick();
  f.routes.registerOperationsAsync = async () => ({ async dispose() {} });
  assert.equal((await observed(f.kernel.switch([item("four")]), "Confirmed Video retirement did not permit recovery")).generation.records[0].status, "active");
  assert.equal(f.owners.length, 2);
});

for (const failure of ["effects", "publication"]) {
  test(`failed Video ${failure} candidate and cleanup never alter existing native jobs or shared component`, { timeout: 15000 }, async t => {
    const f = await fixture(t); await f.kernel.switch([f.candidate("old")]);
    const originalGeneration = f.kernel.current(), local = await f.seed(), compute = await f.seed("running", true);
    f.owners[0].service.jobs.set(local.job.id, local.job);
    f.owners[0].service.jobs.set(compute.job.id, compute.job);
    await fs.mkdir(f.componentRoot, { recursive: true }); await fs.writeFile(f.component, "original component");
    const originals = await Promise.all([local.file, compute.file, f.component].map(file => fs.readFile(file)));
    if (failure === "effects") {
      await f.kernel.switch([f.candidate("failed", async () => { throw new Error("Controlled later candidate effect failure."); })]);
    } else {
      await assert.rejects(f.kernel.switch([f.candidate("failed", undefined, { publish() { throw new Error("Controlled publication failure."); }, rollback() {} })]), /Controlled publication failure/);
    }
    for (const [index, file] of [local.file, compute.file, f.component].entries()) assert.deepEqual(await fs.readFile(file), originals[index]);
    assert.equal(f.events.length, 0);
    assert.equal(f.kernel.current().records[0].identity.activationId, originalGeneration.records[0].identity.activationId);
    if (failure === "publication") assert.equal(f.kernel.current(), originalGeneration);
    assert.equal((await f.send()).status, 200);
    assert.equal(f.stops.some(row => row.identity.revision === "old"), false);
    assert.equal(f.owners[1].service.ownsJobState, false);
    assert.equal(f.owners[1].service.jobs.get(local.job.id).status, "running");
    assert.equal(f.owners[1].service.jobs.get(compute.job.id).computeOutcome, undefined);
  });
}

test("successful Video publication recovers unfinished local and remote jobs only after publication", { timeout: 15000 }, async t => {
  const f = await fixture(t), local = await f.seed(), compute = await f.seed("running", true);
  const entered = gate(), release = gate(); f.releases.push(release.resolve);
  const switching = f.kernel.switch([f.candidate("new", async () => { entered.resolve(); await release.promise; return () => {}; })]);
  await entered.promise;
  assert.equal(JSON.parse(await fs.readFile(local.file, "utf8")).status, "running");
  await assert.rejects(fs.access(f.component)); assert.equal(f.events.length, 0);
  release.resolve(); await switching;
  assert.equal(JSON.parse(await fs.readFile(local.file, "utf8")).status, "interrupted");
  const remote = JSON.parse(await fs.readFile(compute.file, "utf8"));
  assert.equal(remote.status, "interrupted"); assert.equal(remote.computeOutcome, "unknown");
  assert.equal(f.owners[0].service.remote.blocked.has("fixture-peer"), true);
  assert.deepEqual(await fs.readFile(f.component), await fs.readFile(new URL("./inspect-media.py", import.meta.url)));
  assert.equal((await f.send()).status, 200);
  assert.equal(f.routes.catalogSnapshot().operations.length, 35);
});

test("replacement waits for the old native job and reloads its final receipt and model revision before accepting requests", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.kernel.switch([f.candidate("old")]);
  const old = f.owners[0], local = await f.seed(); old.service.jobs.set(local.job.id, local.job);
  await fs.writeFile(f.component, "old active component");
  await fs.writeFile(f.settings, JSON.stringify({ revision: 1, modelRoot: null, layout: "flat" }));
  const release = gate(); f.releases.push(release.resolve);
  old.service.active = release.promise.then(async () => {
    local.job.status = "succeeded"; await old.service.save(local.job);
    await fs.writeFile(f.settings, JSON.stringify({ revision: 3, modelRoot: null, layout: "flat" }));
  });
  const published = f.nextPublication(), switching = f.kernel.switch([f.candidate("new")]);
  await published; await tick();
  assert.equal((await f.send()).status, 503);
  const contracts = f.routes.catalogSnapshot().operations;
  assert.equal(contracts.length, 35);
  for (const { contract } of contracts) {
    const pathname = contract.method === "*" ? "/api/video/models-native-extension" : contract.pathTemplate.replace(/:[A-Za-z][A-Za-z0-9]*/g, local.job.id);
    const response = await f.sendPath(pathname, contract.method === "*" ? "PROPFIND" : contract.method);
    assert.equal(response.status, 503, `${contract.method} ${contract.pathTemplate}`);
    await response.arrayBuffer();
  }
  assert.equal(JSON.parse(await fs.readFile(local.file, "utf8")).status, "running");
  assert.equal(await fs.readFile(f.component, "utf8"), "old active component");
  assert.equal(f.stops.some(row => row.identity.revision === "old" && row.kind === "runtime"), false);
  release.resolve(); await switching;
  const current = f.owners[1];
  assert.equal(current.service.jobs.get(local.job.id).status, "succeeded");
  assert.equal(current.models.settings.revision, 3);
  assert.equal((await f.send()).status, 200);
  assert.equal(f.stops.some(row => row.identity.revision === "old" && row.kind === "runtime"), true);
  assert.equal(f.stops.some(row => row.identity.revision === "new" && row.kind === "runtime"), false);
});

test("read-only Video publication and disposal do not create shared directories or interrupt persisted jobs", { timeout: 15000 }, async t => {
  const f = await fixture(t, { readOnly: true }), local = await f.seed();
  const original = await fs.readFile(local.file);
  await f.kernel.switch([f.candidate("read-only")]);
  assert.deepEqual(await fs.readFile(local.file), original);
  await assert.rejects(fs.access(f.componentRoot));
  await assert.rejects(fs.access(path.join(f.stateRoot, "compute")));
  await f.kernel.dispose();
  assert.deepEqual(await fs.readFile(local.file), original);
});


test("packaged Video manifest admits its real activation through kernel declaration checks and restores all contracts after a rejected omission", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const missingDeclaration = f.candidate("undeclared-operations");
  missingDeclaration.manifest.requires = missingDeclaration.manifest.requires.filter(capability => capability !== "host.manager.operations@1");
  const rejected = await f.kernel.switch([missingDeclaration]);
  assert.equal(rejected.generation.records[0].status, "failed");
  assert.match(rejected.generation.records[0].error.message, /Plugin did not declare required capability: host\.manager\.operations@1/);
  assert.equal(f.owners.length, 0);
  assert.equal(f.routes.catalogSnapshot().operations.length, 0);
  await assert.rejects(fs.access(f.component));

  const restored = await f.kernel.switch([f.candidate("packaged-manifest")]);
  assert.equal(restored.generation.records[0].status, "active");
  assert.equal(restored.generation.services.services.has("manager.video@1"), true);
  assert.equal(f.routes.catalogSnapshot().operations.length, 35);
  assert.equal((await f.send()).status, 200);
});

test("packaged Video manifest waits for its operations provider before any native recovery or contract publication", { timeout: 15000 }, async t => {
  const f = await fixture(t, { omitCapability: "host.manager.operations@1" });
  const local = await f.seed();
  const original = await fs.readFile(local.file);
  const result = await f.kernel.switch([f.candidate("missing-operations-provider")]);
  assert.equal(result.generation.records[0].status, "waiting_dependency");
  assert.equal(result.generation.services.services.has("manager.video@1"), false);
  assert.equal(f.owners.length, 0);
  assert.equal(f.routes.catalogSnapshot().operations.length, 0);
  assert.deepEqual(await fs.readFile(local.file), original);
  await assert.rejects(fs.access(f.component));
});


test("one damaged job and project leave the formal published video HTTP owner usable", async t => {
  const f = await fixture(t), good = await f.seed("succeeded"), brokenId = randomUUID();
  const broken = path.join(f.stateRoot, "jobs", `${brokenId}.json`); await fs.writeFile(broken, "{");
  const projects = path.join(f.stateRoot, "projects"), projectId = randomUUID(); await fs.mkdir(projects);
  await fs.writeFile(path.join(projects, `${projectId}.json`), JSON.stringify({id:projectId,title:"Good",revision:0,updatedAt:"2026-01-01",value:null}));
  await fs.writeFile(path.join(projects, `${randomUUID()}.json`), "{");
  for (const invalid of [{progress:"bad"}, {error:{}}, {updatedAt:null}]) {
    const bad = await f.seed("succeeded"); await fs.writeFile(bad.file, JSON.stringify({...bad.job, ...invalid}));
  }
  await f.kernel.switch([f.candidate("isolated-records")]);
  const status = await f.send(); assert.equal(status.status, 200);
  assert.deepEqual(status.body.jobs.map(job => job.id), [good.job.id]); assert.equal(status.body.recordIssues.length, 4);
  const response = await f.sendPath("/api/video/projects", "GET"), listed = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(listed.projects.map(row => row.id), [projectId]);
  assert.equal(listed.recordIssues.length, 1); assert.equal(await fs.readFile(broken,"utf8"), "{");
});
