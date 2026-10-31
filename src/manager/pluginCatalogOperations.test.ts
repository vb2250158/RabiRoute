import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { deferred, pluginCatalogFixture } from "./pluginCatalogOperations.fixture.js";
import { createPluginCatalogOwner } from "./pluginCatalogOwner.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { ApiContractError } from "./apiOperationContract.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

test("five executable contracts publish in the real registry and accept an authenticated unbound computer", async t => {
  const app = await pluginCatalogFixture(t);
  assert.equal(app.registry.catalogSnapshot().operations.length, 5);
  const openapi = (await apiCatalogOpenApi(app.registry.catalogSnapshot())) as { paths: Record<string, Record<string, any>> };
  assert.equal(Object.keys(openapi.paths).length, 4);
  assert.ok(openapi.paths["/api/plugins/modules/{id}/{rev}/{relativePath}"].get.responses["200"]);
  assert.deepEqual(app.authority.getSnapshot().nodes, [{ nodeId: "unbound-computer", enabled: true }]);
  const catalog = await app.fetch("/api/plugins/catalog?host=web&host=desktop&unknown=retained");
  assert.equal(catalog.status, 200); assert.equal(catalog.headers.get("x-rabiroute-source-revision"), "19");
  const result = await catalog.json(); assert.equal(result.data.host, "web"); assert.equal(result.data.plugins[0].status, "active");
  const current = app.runtime.current();
  const reconciled = await app.fetch("/api/plugins/reconciliation", { method: "POST", headers: { "content-type": "text/plain" }, body: "ignored native body" });
  assert.equal(reconciled.status, 200); assert.equal(app.count(), 2);
  assert.equal(app.runtime.current().id, current.id, "an unchanged reconciliation does not fake a publication");
  assert.deepEqual((await reconciled.json()).data.active, ["manager:catalog"]);
  assert.equal((await app.fetch("/api/plugins/reconciliation")).status, 200);
  assert.equal((await app.fetch("/api/plugins/modules")).status, 200);
});

test("native module URLs keep nested/encoded tails, exact bytes, MIME, cache, nosniff and ignored Range", async t => {
  const app = await pluginCatalogFixture(t, { ingress: "webgui" });
  const module = (await (await app.fetch("/api/plugins/modules")).json()).data.modules[0];
  const prefix = `/api/plugins/modules/${module.id}/${module.rev}/`;
  for (const tail of [module.entryPath, encodeURIComponent(module.entryPath)]) {
    const response = await app.fetch(prefix + tail, { headers: { range: "bytes=0-2" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-range"), null);
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), app.source);
  }
  const css = await app.fetch(prefix + "web/theme.css"); assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(await css.text(), /color: red/);
  const binary = await app.fetch(prefix + "web/data.bin"); assert.equal(binary.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0, 255, 128, 42]));
  assert.equal((await app.fetch(prefix + "web/missing.mjs")).status, 404);
  assert.equal((await app.fetch(prefix + "..%2F..%2Foutside")).status, 400);
  assert.equal((await app.fetch(`/api/plugins/modules/${module.id}/${"b".repeat(64)}/web/data.bin`)).status, 404);
  assert.equal((await app.fetch(`/api/plugins/modules/${module.id}/invalid-revision/web/data.bin`)).status, 404);
  assert.equal((await app.fetch(prefix + "%ZZ")).status, 400);
});

test("reconciliation honors native profile disabled instances and candidate failure diagnostics", async t => {
  const app = await pluginCatalogFixture(t);
  app.profile.instances[0].enabled = false; await fs.writeFile(app.profilePath, JSON.stringify(app.profile));
  const disabled = await app.fetch("/api/plugins/reconciliation", { method: "POST" });
  assert.equal(disabled.status, 200); assert.deepEqual((await disabled.json()).data.active, []);
  assert.deepEqual((await (await app.fetch("/api/plugins/modules")).json()).data.modules, []);
  app.profile.instances[0].enabled = true;
  await fs.writeFile(path.join(app.packageDirectory, "manager.mjs"), "export function activate() { throw new Error('fixture activation failed'); }");
  await fs.writeFile(app.profilePath, JSON.stringify(app.profile));
  const failed = await app.fetch("/api/plugins/reconciliation", { method: "POST" });
  assert.equal(failed.status, 200);
  const status = (await failed.json()).data;
  assert.equal(status.state, "degraded"); assert.deepEqual(status.failed, ["manager:catalog"]); assert.equal(status.diagnostics.length, 1);
});

test("read-only mode refuses the native write without dispatch and leaves every read usable", async t => {
  const app = await pluginCatalogFixture(t, { readOnly: true });
  assert.equal((await app.fetch("/api/plugins/reconciliation", { method: "POST" })).status, 403);
  assert.equal(app.count(), 1);
  for (const route of ["catalog", "modules", "reconciliation"]) assert.equal((await app.fetch("/api/plugins/" + route)).status, 200);
});

test("package-load diagnostics degrade reconciliation without inventing missing capabilities", async t => {
  const app = await pluginCatalogFixture(t, { configure(context) {
    context.reconciliation!.readiness = generation => ({ ...generation.readiness, state: "degraded" });
    context.reconciliation!.diagnostics = () => [{ instanceId: "optional:missing", error: { code: "package_load_failed", message: "fixture missing package" } }];
  } });
  assert.equal(app.runtime.current().readiness.state, "ready");
  const response = await app.fetch("/api/plugins/reconciliation");
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.state, "degraded");
  assert.deepEqual(result.readiness, { state: "degraded", missingCapabilities: [] });
  assert.equal(result.diagnostics[0].error.code, "package_load_failed");
});

test("missing native readiness capability rejects the candidate and retains the current generation", async t => {
  const app = await pluginCatalogFixture(t), original = app.runtime.current();
  await fs.writeFile(app.profilePath, JSON.stringify({ ...app.profile, readyRequires: ["test.absent@1"] }));
  const rejected = await app.fetch("/api/plugins/reconciliation", { method: "POST" });
  assert.equal(rejected.status, 500); assert.match((await rejected.json()).message, /Required plugin capabilities/);
  assert.equal(app.runtime.current(), original);
  assert.deepEqual((await (await app.fetch("/api/plugins/reconciliation")).json()).data.active, ["manager:catalog"]);
});

test("module list forwards the first webRelease and catalog preserves empty/all host selection", async t => {
  let release: string | null | undefined;
  const app = await pluginCatalogFixture(t, { configure(context) {
    const original = context.webModules!.list;
    context.webModules!.list = (webRelease, invocation) => { release = webRelease; return original(webRelease, invocation); };
  } });
  assert.equal((await app.fetch("/api/plugins/modules?webRelease=first&webRelease=second")).status, 200); assert.equal(release, "first");
  assert.equal((await (await app.fetch("/api/plugins/catalog?host=")).json()).data.host, "all");
});

test("native errors retain presentation unavailable, file ENOENT and optional reconciliation semantics", async t => {
  const app = await pluginCatalogFixture(t, { configure(context) {
    context.renderCatalog = async () => { throw new Error("private presentation details"); };
    context.reconciliation = undefined; context.webModules = undefined;
  } });
  const catalog = await app.fetch("/api/plugins/catalog"); assert.equal(catalog.status, 503);
  assert.doesNotMatch(JSON.stringify(await catalog.json()), /private presentation/);
  assert.equal((await app.fetch("/api/plugins/catalog?host=gateway")).status, 400);
  assert.equal((await app.fetch("/api/plugins/reconciliation", { method: "POST" })).status, 405);
  assert.deepEqual((await (await app.fetch("/api/plugins/modules")).json()).data.modules, []);
  assert.equal((await app.fetch(`/api/plugins/modules/absent/${"a".repeat(64)}/client.mjs`)).status, 404);
});

for (const action of ["catalog", "modules", "module-file"] as const) test(`revocation during ${action} suppresses native result and retains operation until actual completion`, async t => {
  const entered = deferred(), finish = deferred();
  const app = await pluginCatalogFixture(t, { configure(context) {
    if (action === "catalog") {
      const original = context.renderCatalog;
      context.renderCatalog = async (...args) => { entered.resolve(); await finish.promise; return original(...args); };
    } else if (action === "modules") {
      const original = context.webModules!.list;
      context.webModules!.list = async (...args) => { entered.resolve(); await finish.promise; return original(...args); };
    } else {
      const original = context.webModules!.read;
      context.webModules!.read = async (...args) => { const value = await original(...args); entered.resolve(); await finish.promise; return value; };
    }
  } });
  const module = app.modules.list()[0]!;
  const route = action === "module-file" ? `/api/plugins/modules/${module.id}/${module.rev}/${module.entryPath}` : "/api/plugins/" + action;
  const response = app.fetch(route); await entered.promise;
  app.authority.revokeNode("unbound-computer");
  assert.equal(app.registration.activeOperationCount(), 1);
  finish.resolve(); const result = await response;
  assert.equal(result.status, 403); const body = await result.json();
  assert.equal(body.errorCode, "API_REQUEST_AUTHORITY_REVOKED"); assert.equal(body.data, undefined);
});

test("queued reconciliation rechecks the original lease before reading the native profile", async t => {
  const app = await pluginCatalogFixture(t), barrier = deferred();
  app.blockQueue(barrier.promise);
  const accepted = deferred();
  const original = app.context.reconciliation!.reconcile!;
  app.context.reconciliation!.reconcile = invocation => { accepted.resolve(); return original(invocation); };
  const pending = app.fetch("/api/plugins/reconciliation", { method: "POST" });
  await accepted.promise; app.authority.revokeNode("unbound-computer"); barrier.resolve();
  const result = await pending; assert.equal(result.status, 403);
  const body = await result.json(); assert.equal(body.mutationOutcome, "unknown"); assert.equal(body.data, undefined);
  assert.equal(app.count(), 1, "revoked queued work must not load/switch a profile");
});

test("revocation during a real candidate effect wait fences native publication and joins candidate cleanup while retaining the old graph", async t => {
  const entered = deferred(), release = deferred(), cleaning = deferred(), releaseCleanup = deferred();
  const calls = { publish: 0, rollback: 0, afterPublish: 0, disposed: 0 };
  const gate = { enter: entered.resolve, wait: () => release.promise, cleaning: cleaning.resolve, cleanup: () => releaseCleanup.promise,
    publish: () => { calls.publish++; }, rollback: () => { calls.rollback++; }, afterPublish: () => { calls.afterPublish++; }, disposed: () => { calls.disposed++; } };
  const app = await pluginCatalogFixture(t, { hostServices: [{ capability: "test.catalog-gate@1", value: gate }] });
  const old = app.runtime.current(), oldModules = app.modules.list();
  const manifestPath = path.join(app.packageDirectory, "rabi.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); manifest.requires = ["test.catalog-gate@1"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(app.packageDirectory, "manager.mjs"), `export function activate(context) {
    const gate = context.services.require("test.catalog-gate@1");
    context.services.provide("test.catalog@1", { revision: "unpublished-candidate" });
    context.contributions.register({ kind: "navigation", id: "catalog", value: { hosts: ["web"], label: "unpublished-candidate" } });
    context.effects.add(async () => {
      gate.enter(); await gate.wait();
      return async () => { gate.cleaning(); await gate.cleanup(); gate.disposed(); };
    });
    context.publication.add({ publish: () => gate.publish(), rollback: () => gate.rollback(), afterPublish: () => gate.afterPublish() });
  }`);
  let responseSettled = false;
  const pending = app.fetch("/api/plugins/reconciliation", { method: "POST" }).then(response => { responseSettled = true; return response; });
  try {
    await entered.promise;
    assert.equal(app.runtime.current(), old); assert.equal(app.registration.activeOperationCount(), 1);
    app.authority.revokeNode("unbound-computer"); release.resolve();
    await Promise.race([cleaning.promise, pending.then(() => { throw new Error("Reconciliation returned before rejected-candidate cleanup started."); })]);
    assert.equal(app.runtime.current(), old, "the kernel's publication fence must retain the exact original graph");
    assert.equal(app.registration.activeOperationCount(), 1, "a rejected candidate still owns its cleanup flight");
    assert.equal(responseSettled, false, "the response cannot complete before actual candidate cleanup");
    assert.deepEqual(calls, { publish: 0, rollback: 0, afterPublish: 0, disposed: 0 });
    releaseCleanup.resolve();
    const result = await pending; assert.equal(result.status, 403);
    const body = await result.json(); assert.equal(body.errorCode, "API_REQUEST_AUTHORITY_REVOKED");
    assert.equal(body.mutationOutcome, "unknown"); assert.equal(body.uncertain, true); assert.equal(body.data, undefined);
    assert.equal(app.runtime.current(), old);
    assert.equal(app.runtime.current().services, old.services); assert.equal(app.runtime.current().contributions, old.contributions);
    assert.deepEqual(app.modules.list(), oldModules);
    assert.deepEqual(calls, { publish: 0, rollback: 0, afterPublish: 0, disposed: 1 });
    assert.equal(app.count(), 2, "the real profile/candidate load ran before the kernel publication rejection");
  } finally { release.resolve(); releaseCleanup.resolve(); await pending; }
});

test("published reconciliation followed by revocation keeps native state and unknown outcome without diagnostic disclosure", async t => {
  const published = deferred(), release = deferred();
  const app = await pluginCatalogFixture(t, { configure(context) {
    const original = context.reconciliation!.reconcile!;
    context.reconciliation!.reconcile = async invocation => { const value = await original(invocation); published.resolve(); await release.promise; return value; };
  } });
  app.profile.instances[0].enabled = false; await fs.writeFile(app.profilePath, JSON.stringify(app.profile));
  const pending = app.fetch("/api/plugins/reconciliation", { method: "POST" });
  await published.promise; assert.deepEqual(app.runtime.current().records, []);
  app.authority.revokeNode("unbound-computer"); release.resolve();
  const result = await pending; assert.equal(result.status, 403);
  const body = await result.json(); assert.equal(body.mutationOutcome, "unknown"); assert.equal(body.uncertain, true);
  assert.equal(body.data, undefined); assert.equal(body.active, undefined); assert.deepEqual(app.runtime.current().records, []);
});

test("original source root and owner references remain pinned across awaited native reads", async t => {
  for (const change of ["root", "owner", "readiness"] as const) {
    const entered = deferred(), release = deferred(); let currentRoot = "original-root";
    const app = await pluginCatalogFixture(t, { configure(context) {
      context.root = () => currentRoot;
      const original = context.renderCatalog;
      context.renderCatalog = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    } });
    const pending = app.fetch("/api/plugins/catalog"); await entered.promise;
    if (change === "root") currentRoot = "replacement-root";
    else if (change === "owner") app.context.webModules = { ...app.context.webModules! };
    else app.context.reconciliation!.readiness = generation => generation.readiness;
    release.resolve(); const result = await pending;
    assert.equal(result.status, 409); const body = await result.json(); assert.equal(body.errorCode, "API_PLUGIN_SOURCE_CHANGED"); assert.equal(body.data, undefined);
  }
});

test("real child stdout producer is killed and joined before disconnected/deadline operation leases drain", async t => {
  for (const trigger of ["disconnect", "deadline", "early-close"] as const) {
    const entered = deferred(), cleanup = deferred(), allowClose = deferred(); let childPid: number | undefined;
    const app = await pluginCatalogFixture(t, { deadlineMs: trigger === "deadline" ? 500 : undefined, configure(context) {
      const original = context.webModules!.read;
      context.webModules!.read = async (id, rev, file, invocation) => {
        const value = await original(id, rev, file, invocation);
        const script = trigger === "early-close" ? "process.exit(0)" : "process.stdout.write('ready');setInterval(()=>process.stdout.write('x'),20)";
        const child = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        childPid = child.pid;
        const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
        const failed = new Promise<never>((_resolve, reject) => child.once("error", reject));
        const abort = () => { child.kill(); cleanup.resolve(); };
        invocation!.signal!.addEventListener("abort", abort, { once: true });
        try {
          if (invocation!.signal!.aborted) abort();
          await Promise.race([once(child.stdout!, "data"), failed,
            closed.then(() => { throw new Error("Controlled child closed before its first stdout frame."); })]);
          entered.resolve();
          await closed; await allowClose.promise; return value;
        } finally { invocation!.signal!.removeEventListener("abort", abort); child.kill(); await closed; }
      };
    } });
    const module = app.modules.list()[0]!;
    const request = http.get(`${app.baseUrl}/api/plugins/modules/${module.id}/${module.rev}/${module.entryPath}`, { headers: app.headers });
    const result = new Promise<{ status: number; body: any } | undefined>((resolve, reject) => {
      request.on("response", response => { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) })); response.on("error", reject); });
      request.on("error", error => trigger === "disconnect" ? resolve(undefined) : reject(error));
    });
    const started = Promise.race([entered.promise, result.then(() => { throw new Error("Controlled HTTP result arrived before producer startup."); })]);
    try {
      if (trigger === "early-close") {
        await assert.rejects(started, /HTTP result arrived before producer startup/);
        assert.equal((await result)?.status, 500);
      } else {
        await started; if (trigger === "disconnect") request.destroy();
        await cleanup.promise; assert.equal(app.registration.activeOperationCount(), 1);
        assert.ok(childPid); allowClose.resolve();
        const response = await result;
        if (response) { assert.equal(response.status, 408); assert.equal(response.body.data, undefined); }
      }
      await app.registration.dispose(); assert.equal(app.registration.activeOperationCount(), 0);
      assert.ok(childPid); assert.throws(() => process.kill(childPid!, 0), "native child must actually be closed");
    } finally {
      allowClose.resolve(); request.destroy(); await result.catch(() => undefined);
      await app.registration.dispose();
    }
  }
});

test("owner admission refuses revoked work before native mutation dispatch", async t => {
  const app = await pluginCatalogFixture(t);
  const request = { headers: {}, socket: {} } as http.IncomingMessage;
  let active = true; markAuthenticatedConnectionRequest(request, () => { if (!active) throw new Error("revoked"); });
  const owner = createPluginCatalogOwner(app.context);
  const bound = owner.prepare(request, "reconciliation.run"); active = false;
  await assert.rejects(bound.execute({}), (error: unknown) => error instanceof ApiContractError && error.status === 403 && error.mutationOutcome === "not_started");
});

test("owner retains original trusted source and rejects source rebinding before disclosure", async t => {
  const app = await pluginCatalogFixture(t), request = { headers: {}, socket: {} } as http.IncomingMessage;
  markAuthenticatedConnectionRequest(request);
  setTrustedLanAgentSource(request, { nodeId: "fixture", agentId: "codex", provider: "codex", sessionId: "original", sessionName: "original" });
  const owner = createPluginCatalogOwner(app.context), bound = owner.prepare(request, "catalog.read");
  setTrustedLanAgentSource(request, { nodeId: "fixture", agentId: "codex", provider: "codex", sessionId: "replacement", sessionName: "replacement" });
  await assert.rejects(bound.execute({}), (error: unknown) => error instanceof ApiContractError && error.status === 403);
});

test("reconciliation refuses a callback's stale generation instead of returning a publication success", async t => {
  const app = await pluginCatalogFixture(t, { configure(context) {
    const original = context.reconciliation!.reconcile!;
    context.reconciliation!.reconcile = async invocation => { const generation = await original(invocation); return { ...generation, id: "stale-generation" }; };
  } });
  const result = await app.fetch("/api/plugins/reconciliation", { method: "POST" });
  assert.equal(result.status, 500); const body = await result.json();
  assert.equal(body.errorCode, "API_PLUGIN_RECONCILIATION_UNCONFIRMED"); assert.equal(body.mutationOutcome, "unknown"); assert.equal(body.data, undefined);
});
