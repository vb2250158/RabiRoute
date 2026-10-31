import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { buildWebPatch, verifyWebPatch, webPatchBackend, webPatchHash, webPatchPath, writeWebPatchJson } from "./webPatchCatalog.js";
import { WebPatchService, type WebPatchIdentity } from "./webPatchService.js";
import { WebPatchWatcher } from "./webPatchWatcher.js";
import { NativeWebguiStaticOwner } from "./nativeWebguiStaticOwner.js";
import { createWebguiStaticOperations } from "./webguiStaticOperations.js";
import { createCorePublicOperations, type CorePublicOperationsContext } from "./corePublicOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { handleWebPatchApi } from "./webPatchRoutes.js";

const identity: WebPatchIdentity = { applicationGenerationId: "application", managerInstanceId: "manager", pluginGenerationId: "plugins" };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("stopping initial Web preparation joins the current file operation and removes its staging directory", async context => {
  const sample = await fixture(context), entered = gate(), release = gate();
  const stoppedState = path.join(sample.root, "stop-during-initialization");
  const originalCopy = fs.copyFile.bind(fs);
  const copy = context.mock.method(fs, "copyFile", async (source: Parameters<typeof fs.copyFile>[0], destination: Parameters<typeof fs.copyFile>[1]) => {
    await originalCopy(source, destination);
    if (String(destination).startsWith(stoppedState)) { entered.resolve(); await release.promise; }
  });
  const service = new WebPatchService({ packageRoot: sample.packageRoot, stateRoot: stoppedState, identity: () => identity,
    serialize: async (_generation, action) => action() });
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, service.ready.then(() => assert.fail("Initial preparation settled before the controlled file operation."))]);
    let complete = false; stopping = service.stop().then(() => { complete = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(complete, false);
    release.resolve(); await stopping;
    assert.equal(service.status().error, undefined);
    assert.deepEqual(await fs.readdir(service.candidates), []);
    await assert.rejects(fs.stat(path.join(stoppedState, "states")), { code: "ENOENT" });
  } finally {
    release.resolve(); await Promise.allSettled([stopping, service.stop()]); copy.mock.restore();
  }
});

test("cancelling backend hashing closes the real file stream before its owner settles", async context => {
  const sample = await fixture(context), abort = new AbortController();
  await sample.write("dist/slow-backend.js", "x".repeat(1024 * 1024));
  const originalStream = nativeFs.createReadStream; let opened: nativeFs.ReadStream | undefined; let closed = false;
  const mock = context.mock.method(nativeFs, "createReadStream", ((filename: nativeFs.PathLike, options?: Parameters<typeof nativeFs.createReadStream>[1]) => {
    const stream = originalStream(filename, options);
    if (String(filename).endsWith("slow-backend.js")) {
      opened = stream; stream.once("close", () => { closed = true; });
      stream.once("data", () => abort.abort(new Error("Fixture owner stopped")));
    }
    return stream;
  }) as typeof nativeFs.createReadStream);
  syncBuiltinESMExports();
  try { await assert.rejects(webPatchBackend(sample.packageRoot, abort.signal), /abort|Fixture owner stopped/i); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(opened); assert.equal(closed, true); assert.equal(opened.destroyed, true); assert.equal(Reflect.get(opened, "fd"), null);
  assert.equal((await fs.stat(path.join(sample.packageRoot, "dist/slow-backend.js"))).size, 1024 * 1024);
});

test("stop joins an accepted candidate import without cancelling its verified bytes", async context => {
  const sample = await fixture(context), next = await sample.candidate(), entered = gate(), release = gate();
  const originalCopy = fs.copyFile.bind(fs);
  const mock = context.mock.method(fs, "copyFile", async (source: Parameters<typeof fs.copyFile>[0], destination: Parameters<typeof fs.copyFile>[1]) => {
    await originalCopy(source, destination);
    if (String(destination).includes(path.sep + ".import-")) { entered.resolve(); await release.promise; }
  });
  const importing = sample.service.importCandidate(next.source, next.revision);
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, importing.then(() => assert.fail("Candidate import settled before the controlled file operation."))]);
    let complete = false; stopping = sample.service.stop().then(() => { complete = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(complete, false);
    release.resolve(); await importing; await stopping;
    await verifyWebPatch(path.join(sample.service.candidates, next.revision), next.revision);
    assert.equal((await fs.readdir(sample.service.candidates)).some(name => name.startsWith(".import-")), false);
  } finally {
    release.resolve(); await Promise.allSettled([importing, stopping, sample.service.stop()]); mock.mock.restore();
  }
});

test("stop joins an accepted publication through its durable commit and preserves its receipt", async context => {
  const sample = await fixture(context), next = await sample.candidate(), entered = gate(), release = gate();
  await sample.service.importCandidate(next.source, next.revision);
  const originalRename = fs.rename.bind(fs);
  const mock = context.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination).endsWith(`${sample.service.status().backend}.json`)) { entered.resolve(); await release.promise; }
    await originalRename(source, destination);
  });
  const publishing = sample.service.publish({ ...identity, operationId: "shutdown-commit", candidate: next.revision, expectedRevision: 0 });
  let stopping: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, publishing.then(() => assert.fail("Publication settled before the controlled durable commit."))]);
    let complete = false; stopping = sample.service.stop().then(() => { complete = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(complete, false);
    release.resolve(); assert.equal((await publishing).state, "committed"); await stopping;
    const restarted = sample.start(); await restarted.ready;
    assert.equal(restarted.operation("shutdown-commit")?.active, next.revision);
  } finally {
    release.resolve(); await Promise.allSettled([publishing, stopping, sample.service.stop()]); mock.mock.restore();
  }
});

test("watcher stop cancels its uncommitted observation and joins asynchronous cleanup", async context => {
  const sample = await fixture(context), entered = gate(), release = gate(); let abortObserved = false;
  const errors: unknown[] = [];
  const automatic = context.mock.method(sample.service, "automatic", async (_root: string, signal?: AbortSignal) => {
    entered.resolve(); await new Promise<void>(resolve => signal!.addEventListener("abort", () => { abortObserved = true; resolve(); }, { once: true }));
    await release.promise;
  });
  const watcher = new WebPatchWatcher(sample.packageRoot, sample.service, error => errors.push(error));
  let stopping: Promise<void> | undefined;
  try {
    await entered.promise; let complete = false; stopping = watcher.stop().then(() => { complete = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(abortObserved, true); assert.equal(complete, false);
    release.resolve(); await stopping; assert.deepEqual(errors, []);
  } finally {
    release.resolve(); await Promise.allSettled([stopping, watcher.stop()]); automatic.mock.restore();
  }
});

test("native static manifest access checks compatibility and cannot mutate cached authority", async context => {
  const sample = await fixture(context), revision = sample.service.status().active!;
  const manifest = await sample.service.staticManifest(revision);
  assert.equal(manifest.backend, sample.service.status().backend);
  const original = manifest.files[0]!.sha256; manifest.files[0]!.sha256 = "changed-local-copy";
  assert.equal((await sample.service.staticManifest(revision)).files[0]!.sha256, original);
  await assert.rejects(sample.service.staticManifest("invalid-revision"));
  await sample.service.stop(); await assert.rejects(sample.service.staticManifest(revision), /unavailable/);
});

async function fixture(context: { after(action: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-patch-test-")));
  const packageRoot = path.join(root, "package");
  const stateRoot = path.join(root, "state");
  const services: WebPatchService[] = [];
  const httpCleanups: Array<() => Promise<void>> = [];
  context.after(async () => {
    await Promise.all(httpCleanups.map(close => close()));
    await Promise.all(services.map(service => service.stop()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(relative: string, body: string) {
    const filename = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, body);
  }
  await write("dist/manager.js", "export const version = 1;");
  await write("dist/plugins/packages/example/rabi.plugin.json", JSON.stringify({ id: "example", version: "1", entries: { web: { module: "web/client.mjs" } } }));
  await write("dist/plugins/packages/example/web/client.mjs", 'export { activate } from "/assets/module.js";\n');
  await write("ribiwebgui/dist/index.html", '<html><head><link href="./assets/style.css"></head><body><script type="module" src="./assets/main.js"></script></body></html>');
  await write("ribiwebgui/dist/assets/main.js", 'import "./lazy.js";');
  await write("ribiwebgui/dist/assets/lazy.js", 'export const value = "old";');
  await write("ribiwebgui/dist/assets/module.js", "export function activate() { return 1; }");
  await write("ribiwebgui/dist/assets/style.css", "body { color: red; }");
  await write("assets/icon.svg", "<svg/>");
  await write("docs/guide.md", "old guide");
  function start() {
    const service = new WebPatchService({ packageRoot, stateRoot, identity: () => identity,
      serialize: async (generation, action) => { assert.equal(generation, identity.pluginGenerationId); return action(); } });
    services.push(service);
    return service;
  }
  const service = start();
  await service.ready;
  assert.equal(service.status().state, "ready", service.status().error);
  async function candidate(value = "new") {
    await write("ribiwebgui/dist/assets/lazy.js", `export const value = ${JSON.stringify(value)};`);
    await write("docs/guide.md", `${value} guide`);
    const output = path.join(packageRoot, "dist/web-patches");
    const revision = await buildWebPatch(packageRoot, output);
    return { output, revision, source: path.join(output, revision) };
  }
  let serving: Promise<{ base: string }> | undefined;
  function serve(owningService = service) {
    return serving ??= (async () => {
      const owner = new NativeWebguiStaticOwner({ packageRoot, webuiDistPath: path.join(packageRoot, "ribiwebgui/dist"), patches: owningService,
        isControlPath: value => value.startsWith("/api/") || value === "/health" || value.startsWith("/_rabiroute/host/") });
      const registry = new ManagerPluginRouteRegistry(), definitions = createWebguiStaticOperations(owner);
      const staticRegistration = registry.registerHttpProxies("web-publication-static-fixture", [...definitions.resources, definitions.fallback]);
      const publicRegistration = registry.registerOperations("web-publication-core-fixture", createCorePublicOperations({ identity: () => identity, webPatches: owningService } as unknown as CorePublicOperationsContext)
        .filter(value => value.contract.pathTemplate.startsWith("/api/web-patches")));
      const server = http.createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        if (url.pathname === "/health") { response.end("healthy"); return; }
        if (handleWebPatchApi(request, url, response, { service: owningService, identity: null, readJson: async () => ({}), json: (target, status, body) => { target.writeHead(status, { "content-type": "application/json" }); target.end(JSON.stringify(body)); } })) return;
        if (!registry.handle(request, url, response)) response.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      httpCleanups.push(async () => { server.closeAllConnections(); await Promise.all([staticRegistration.dispose(), publicRegistration.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(owner.activeFileCount(), 0); });
      return { base: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}` };
    })();
  }
  async function readShell() {
    const { base } = await serve(), response = await fetch(base + "/"), body = await response.text();
    assert.equal(response.status, 200, body);
    const revision = body.match(/data-rabi-web-release="([a-f0-9]{64})"/)?.[1]; assert.ok(revision);
    return { revision, body };
  }
  async function readAsset(revision: string, filename: string) {
    const { base } = await serve(), response = await fetch(`${base}/_rabiroute/web/${revision}/${filename}`);
    const body = await response.text(); assert.equal(response.status, 200, body); return { body };
  }
  return { root, packageRoot, stateRoot, service, start, write, candidate, serve, readShell, readAsset };

}

test("atomic release keeps old HTML, lazy assets, documentation and module entry pinned; rollback and restart preserve receipts", async context => {
  const sample = await fixture(context);
  const original = (await sample.readShell())!;
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const request = { ...identity, operationId: "publish", candidate: next.revision, expectedRevision: 0 };
  const receipt = await sample.service.publish(request);
  assert.equal(receipt.revision, 1);
  assert.deepEqual(await sample.service.publish(request), receipt);
  assert.match((await sample.readShell())!.body, new RegExp(`/_rabiroute/web/${next.revision}/web/assets/main.js`));
  assert.match(original.body, new RegExp(`data-rabi-web-release="${original.revision}"`));
  assert.match((await sample.readAsset(original.revision, "web/assets/lazy.js")).body.toString(), /old/);
  assert.equal((await sample.readAsset(original.revision, "docs/guide.md")).body.toString(), "old guide");
  assert.equal((await sample.readAsset(next.revision, "docs/guide.md")).body.toString(), "new guide");
  const modules = [{ id: "web-example", pluginId: "example", version: "1", rev: "legacy", entryPath: "web/client.mjs", instances: [] }];
  assert.equal((await sample.service.modules(modules, original.revision))[0]!.rev, original.revision);
  assert.match((await sample.service.module(modules, "web-example", original.revision, "web/client.mjs"))!.source.toString(), new RegExp(original.revision));
  await assert.rejects(sample.service.publish({ ...request, candidate: original.revision }), /conflict/);
  await assert.rejects(sample.service.publish({ ...request, operationId: "stale" }), /baseline/);
  await assert.rejects(sample.service.publish({ ...request, operationId: "identity", managerInstanceId: "old" }), /identity/);
  await sample.service.publish({ ...identity, operationId: "rollback", candidate: original.revision, expectedRevision: 1 });
  assert.equal((await sample.readShell())!.revision, original.revision);
  await sample.service.stop();
  const restored = sample.start();
  await restored.ready;
  assert.equal(restored.status().state, "ready", restored.status().error);
  assert.equal(restored.status().active, original.revision);
  assert.deepEqual(restored.operation("publish"), receipt);
});

test("Web release construction rejects a declared but missing plugin entry", async context => {
  const sample = await fixture(context);
  await fs.unlink(path.join(sample.packageRoot, "dist/plugins/packages/example/web/client.mjs"));
  await assert.rejects(sample.candidate(), /Web Bundle entry is missing: example/);
});

test("code and Web share one durable publication and recover together", async context => {
  const sample = await fixture(context);
  const service = sample.start();
  const codeRevision = webPatchHash("fixture code candidate");
  let activeCode = "baseline";
  let commits = 0;
  service.registerCodePublication(async revision => {
    assert.equal(revision, codeRevision);
    return () => { activeCode = revision; commits++; };
  });
  await service.ready;
  const next = await sample.candidate();
  await service.importCandidate(next.source, next.revision);
  const request = { ...identity, operationId: "joint-publication", candidate: next.revision, expectedRevision: 0 };
  const receipt = await service.publish(request, codeRevision);
  assert.equal(activeCode, codeRevision);
  assert.equal(service.status().active, next.revision);
  assert.equal(service.status().codeRevision, codeRevision);
  assert.deepEqual(await service.publish(request, codeRevision), receipt);
  assert.equal(commits, 1);
  await assert.rejects(service.publish(request, webPatchHash("other code")), /conflict/);
  await service.stop();
  activeCode = "baseline";
  const restored = sample.start();
  restored.registerCodePublication(async revision => () => { activeCode = revision; });
  await restored.ready;
  assert.equal(restored.status().state, "ready", restored.status().error);
  assert.equal(restored.status().active, next.revision);
  assert.equal(activeCode, codeRevision);
  assert.equal(restored.operation(request.operationId)?.codeRevision, codeRevision);
});

test("code preparation failure keeps both published versions unchanged", async context => {
  const sample = await fixture(context);
  const service = sample.start();
  service.registerCodePublication(async () => { throw new Error("incompatible code fixture"); });
  await service.ready;
  const original = service.status().active;
  const next = await sample.candidate();
  await service.importCandidate(next.source, next.revision);
  await assert.rejects(service.publish({ ...identity, operationId: "bad-code", candidate: next.revision, expectedRevision: 0 }, webPatchHash("bad")), /incompatible code fixture/);
  assert.equal(service.status().active, original);
  assert.equal(service.status().revision, 0);
  assert.equal(service.operation("bad-code"), undefined);
});

test("a persisted code revision without its owner fails closed on restart", async context => {
  const sample = await fixture(context);
  const service = sample.start();
  service.registerCodePublication(async () => () => {});
  await service.ready;
  await service.publish({ ...identity, operationId: "code-only", candidate: service.status().active!, expectedRevision: 0 }, webPatchHash("code"));
  await service.stop();
  const missingOwner = sample.start();
  await missingOwner.ready;
  assert.equal(missingOwner.status().state, "blocked");
  assert.match(missingOwner.status().error!, /owner is unavailable/);
});

test("a backend-only plugin does not require a Web entry in the complete baseline", async context => {
  const sample = await fixture(context);
  await sample.write("dist/plugins/packages/optional/rabi.plugin.json", JSON.stringify({ id: "optional", version: "1", entries: { manager: { module: "manager.mjs" } } }));
  const baseline = await buildWebPatch(sample.packageRoot, path.join(sample.packageRoot, "candidate")).catch(error => { throw error; });
  const manifest = await verifyWebPatch(path.join(sample.packageRoot, "candidate", baseline), baseline);
  assert.equal(manifest.modules.some(module => module.pluginId === "optional"), false);
});

test("backend mismatch, corrupt candidate and missing entry fail without changing the live release", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active;
  const next = await sample.candidate();
  await fs.writeFile(path.join(next.source, "web/assets/lazy.js"), "tampered");
  await assert.rejects(sample.service.importCandidate(next.source, next.revision), /verification/);
  await sample.write("dist/manager.js", "export const version = 2;");
  const changed = await sample.candidate("incompatible");
  await assert.rejects(sample.service.importCandidate(changed.source, changed.revision), /incompatible/);
  await sample.write("ribiwebgui/dist/index.html", '<html><script src="./assets/absent.js"></script></html>');
  await assert.rejects(sample.candidate(), /missing asset/);
  assert.equal(sample.service.status().active, baseline);
  assert.equal(sample.service.status().revision, 0);
});

test("automatic marker consumes each operation once and does not undo a deliberate rollback", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active!;
  const next = await sample.candidate();
  await writeWebPatchJson(path.join(next.output, "latest.json"), { revision: next.revision, operationId: "automatic" });
  await sample.service.automatic(sample.packageRoot);
  assert.equal(sample.service.status().active, next.revision);
  await sample.service.publish({ ...identity, operationId: "rollback", candidate: baseline, expectedRevision: 1 });
  await sample.service.automatic(sample.packageRoot);
  assert.equal(sample.service.status().active, baseline);
  assert.equal(sample.service.status().revision, 2);
});

test("watcher picks up completed markers after output directory creation and rebuild", async context => {
  const sample = await fixture(context);
  const errors: unknown[] = [];
  const watcher = new WebPatchWatcher(sample.packageRoot, sample.service, error => errors.push(error));
  context.after(async () => watcher.stop());
  async function waitFor(revision: string) {
    const deadline = Date.now() + 10000;
    while (sample.service.status().active !== revision && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sample.service.status().active, revision, String(errors));
  }
  const first = await sample.candidate();
  await writeWebPatchJson(path.join(first.output, "latest.json"), { revision: first.revision, operationId: "first" });
  await waitFor(first.revision);
  await fs.rm(first.output, { recursive: true, force: true });
  const second = await sample.candidate("second");
  await writeWebPatchJson(path.join(second.output, "latest.json"), { revision: second.revision, operationId: "second" });
  await waitFor(second.revision);
  assert.equal(sample.service.status().revision, 2);
});

test("persisted receipt corruption blocks updates instead of losing idempotency history", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  await sample.service.publish({ ...identity, operationId: "original", candidate: next.revision, expectedRevision: 0 });
  const statePath = path.join(sample.stateRoot, "states", `${sample.service.status().backend}.json`);
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.operations[0].fingerprint = "forged";
  await fs.writeFile(statePath, JSON.stringify(state));
  await sample.service.stop();
  const restored = sample.start();
  await restored.ready;
  assert.equal(restored.status().state, "blocked");
  await assert.rejects(restored.publish({ ...identity, operationId: "new", candidate: next.revision, expectedRevision: 1 }), /unavailable/);
});

test("candidate paths reject traversal and manifest aliases", async context => {
  const sample = await fixture(context);
  for (const filename of ["web/../secret", "web//secret", "web/./secret", "docs/../../secret", "web\\secret", "/web/index.html"]) {
    assert.throws(() => webPatchPath(filename), /Invalid/);
  }
  const next = await sample.candidate();
  await assert.rejects(verifyWebPatch(next.source, "0".repeat(64)), /hash mismatch/);
  const manifest = JSON.parse(await fs.readFile(path.join(next.source, "manifest.json"), "utf8"));
  manifest.files.push({ ...manifest.files[0] });
  const raw = JSON.stringify(manifest);
  await fs.writeFile(path.join(next.source, "manifest.json"), raw);
  await assert.rejects(verifyWebPatch(next.source, webPatchHash(raw)), /file record/);
});

test("publication persistence failure is reconciled without replay and receipt reads cannot mutate history", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const originalRename = fs.rename.bind(fs);
  const rename = context.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (String(destination).endsWith(`${sample.service.status().backend}.json`)) throw new Error("injected persistence failure");
    return originalRename(source, destination);
  });
  const request = { ...identity, operationId: "original", candidate: next.revision, expectedRevision: 0 };
  await assert.rejects(sample.service.publish(request), /persistence/);
  assert.equal(sample.service.status().state, "blocked");
  assert.equal((await sample.service.reconcile("original")).state, "not_started");
  rename.mock.restore();
  assert.equal(sample.service.status().state, "ready");
  const receipt = await sample.service.publish(request);
  receipt.active = "mutated";
  sample.service.operation("original")!.active = "mutated";
  assert.equal(sample.service.operation("original")!.active, next.revision);
  assert.equal((await sample.service.reconcile("original")).state, "committed");
  assert.equal(sample.service.status().revision, 1);
});

test("rename committed before an error still returns the one persisted outcome", async context => {
  const sample = await fixture(context);
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const originalRename = fs.rename.bind(fs);
  const rename = context.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    await originalRename(source, destination);
    if (String(destination).endsWith(`${sample.service.status().backend}.json`)) throw new Error("injected lost acknowledgement");
  });
  const request = { ...identity, operationId: "committed", candidate: next.revision, expectedRevision: 0 };
  assert.equal((await sample.service.publish(request)).state, "committed");
  rename.mock.restore();
  assert.equal((await sample.service.publish(request)).revision, 1);
  assert.equal(sample.service.status().revision, 1);
});

test("missing versioned module never falls back to a different release", async context => {
  const sample = await fixture(context);
  await assert.rejects(sample.service.modules([{ id: "other", pluginId: "other", version: "1", rev: "legacy", entryPath: "web/client.mjs", instances: [] }], sample.service.status().active), /no compatible/);
});

test("continuous HTTP reads remain available during publication; old assets and HEAD stay valid", async context => {
  const sample = await fixture(context);
  const baseline = sample.service.status().active!;
  const { base } = await sample.serve();
  const next = await sample.candidate();
  await sample.service.importCandidate(next.source, next.revision);
  const publication = sample.service.publish({ ...identity, operationId: "concurrent", candidate: next.revision, expectedRevision: 0 });
  await Promise.all(Array.from({ length: 40 }, async () => {
    assert.equal(await (await fetch(`${base}/health`)).text(), "healthy");
    const asset = await fetch(`${base}/_rabiroute/web/${baseline}/web/assets/lazy.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /old/);
  }));
  await publication;
  const head = await fetch(`${base}/_rabiroute/web/${next.revision}/web/assets/lazy.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("cache-control")!, /immutable/);
  assert.equal((await fetch(`${base}/_rabiroute/host/web-patches`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${base}/api/web-patches/operations/concurrent`)).status, 200);
});

type CapacityFixture = Awaited<ReturnType<typeof fixture>>;

async function retainCandidateHistory(sample: CapacityFixture, count: number, prefix: string) {
  const retained: Array<{ revision: string; source: string; manifest: string }> = [];
  for (let index = 0; index < count; index++) {
    const next = await sample.candidate(`${prefix}-${index}`);
    const destination = path.join(sample.service.candidates, next.revision);
    await fs.cp(next.source, destination, { recursive: true, errorOnExist: true, force: false });
    retained.push({ revision: next.revision, source: next.source, manifest: await fs.readFile(path.join(destination, "manifest.json"), "utf8") });
  }
  return retained;
}

test("capacity: foreign backend history does not consume current slots or read foreign payloads", async context => {
  const sample = await fixture(context), originalBackendSource = await fs.readFile(path.join(sample.packageRoot, "dist/manager.js"));
  await sample.write("dist/manager.js", "export const version = 2;");
  const retained = await retainCandidateHistory(sample, 65, "foreign");
  const foreignBackend = JSON.parse(retained[0]!.manifest).backend;
  await fs.writeFile(path.join(sample.packageRoot, "dist/manager.js"), originalBackendSource);
  const evidencePath = path.join(sample.stateRoot, "states", foreignBackend + ".json");
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  const evidence = '{"unknownOldReceipt":"preserve exactly"}'; await fs.writeFile(evidencePath, evidence);
  const next = await sample.candidate("current-after-history"), roots = retained.map(item => path.join(sample.service.candidates, item.revision) + path.sep);
  let payloadReads = 0;
  const originalRead = fs.readFile.bind(fs), originalStream = nativeFs.createReadStream;
  const read = context.mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
    if (roots.some(root => String(args[0]).startsWith(root)) && !String(args[0]).endsWith("manifest.json")) payloadReads++;
    return originalRead(...args);
  }) as typeof fs.readFile);
  const stream = context.mock.method(nativeFs, "createReadStream", ((filename: nativeFs.PathLike, options?: Parameters<typeof nativeFs.createReadStream>[1]) => {
    if (roots.some(root => String(filename).startsWith(root))) payloadReads++;
    return originalStream(filename, options);
  }) as typeof nativeFs.createReadStream); syncBuiltinESMExports();
  try { await sample.service.importCandidate(next.source, next.revision); }
  finally { read.mock.restore(); stream.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(payloadReads, 0);
  for (const old of retained) assert.equal(await fs.readFile(path.join(sample.service.candidates, old.revision, "manifest.json"), "utf8"), old.manifest);
  assert.equal(await fs.readFile(evidencePath, "utf8"), evidence);
  assert.equal((await sample.service.staticManifest(next.revision)).backend, sample.service.status().backend);
});

test("capacity: a full current backend rejects new imports but preserves existing reads and idempotency", async context => {
  const sample = await fixture(context), active = sample.service.status().active!;
  const retained = await retainCandidateHistory(sample, 63, "current-full"), next = await sample.candidate("too-many");
  await assert.rejects(sample.service.importCandidate(next.source, next.revision), /retention limit/);
  await sample.service.importCandidate(retained[0]!.source, retained[0]!.revision);
  assert.equal((await sample.service.staticManifest(active)).backend, sample.service.status().backend);
  assert.equal((await sample.readAsset(active, "docs/guide.md")).body, "old guide");
  assert.equal(sample.service.status().active, active);
  assert.equal((await fs.readdir(sample.service.candidates)).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 64);
});

test("capacity: an existing baseline still initializes when historical current-backend count already exceeds 64", async context => {
  const sample = await fixture(context), active = sample.service.status().active!;
  const retained = await retainCandidateHistory(sample, 65, "overfull");
  await sample.write("ribiwebgui/dist/assets/lazy.js", 'export const value = "old";'); await sample.write("docs/guide.md", "old guide");
  const restarted = sample.start(); await restarted.ready;
  assert.equal(restarted.status().state, "ready", restarted.status().error); assert.equal(restarted.status().active, active);
  await restarted.importCandidate(retained[0]!.source, retained[0]!.revision);
  assert.equal((await restarted.staticManifest(active)).backend, restarted.status().backend);
  const next = await sample.candidate("new-overfull");
  await assert.rejects(restarted.importCandidate(next.source, next.revision), /retention limit/);
  assert.equal(sample.service.status().active, active);
});

test("capacity: a real cold owner serves its new installed baseline despite full history and rejects optional imports", async context => {
  const sample = await fixture(context); await retainCandidateHistory(sample, 63, "cold-full");
  const next = await sample.candidate("new-installed-baseline");
  await sample.service.stop(); assert.equal(sample.service.status().active !== next.revision, true);
  const restarted = sample.start(); await restarted.ready;
  assert.equal(restarted.status().state, "ready", restarted.status().error); assert.equal(restarted.status().active, next.revision);
  const { base } = await sample.serve(restarted);
  const shell = await fetch(base + "/"); assert.equal(shell.status, 200); assert.match(await shell.text(), new RegExp(`data-rabi-web-release="${next.revision}"`));
  const asset = await fetch(`${base}/_rabiroute/web/${next.revision}/web/assets/lazy.js`); assert.equal(asset.status, 200); assert.match(await asset.text(), /new-installed-baseline/);
  const state = await fetch(base + "/api/web-patches"); assert.equal(state.status, 200); assert.equal((await state.json()).data.active, next.revision);
  const optional = await sample.candidate("optional-after-cold-full");
  await assert.rejects(restarted.importCandidate(optional.source, optional.revision), /retention limit/);
  const after = await fetch(base + "/"); assert.equal(after.status, 200); assert.match(await after.text(), new RegExp(next.revision));
  assert.equal(restarted.status().active, next.revision);
});


test("capacity: optional imports wait for installed baseline readiness before checking their final slot", async context => {
  const sample = await fixture(context); await retainCandidateHistory(sample, 62, "baseline-order");
  const baseline = await sample.candidate("baseline-last-slot"), next = await sample.candidate("early-import");
  await sample.write("ribiwebgui/dist/assets/lazy.js", 'export const value = "baseline-last-slot";'); await sample.write("docs/guide.md", "baseline-last-slot guide");
  const entered = gate(), release = gate(), originalCopy = fs.copyFile.bind(fs); let held = false, importingCopies = 0;
  const copy = context.mock.method(fs, "copyFile", async (source: Parameters<typeof fs.copyFile>[0], destination: Parameters<typeof fs.copyFile>[1]) => {
    await originalCopy(source, destination);
    if (String(destination).includes(path.sep + ".import-")) importingCopies++;
    if (!held && String(destination).startsWith(sample.service.candidates) && String(destination).includes(path.sep + ".staging-")) { held = true; entered.resolve(); await release.promise; }
  });
  const restarted = sample.start(), importing = restarted.importCandidate(next.source, next.revision);
  const outcome = importing.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
  try { await entered.promise; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(importingCopies, 0); }
  finally { release.resolve(); }
  await restarted.ready; const result = await outcome; copy.mock.restore();
  assert.equal(restarted.status().state, "ready", restarted.status().error); assert.equal(restarted.status().baseline, baseline.revision);
  assert.equal(result.ok, false); assert.match(String(result.error), /retention limit/);
  assert.equal((await fs.readdir(sample.service.candidates)).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 64);
});

test("capacity: two concurrent imports serialize the final current-backend slot", async context => {
  const sample = await fixture(context); await retainCandidateHistory(sample, 62, "import-order");
  const first = await sample.candidate("first-last-slot"), second = await sample.candidate("second-last-slot");
  const results = await Promise.allSettled([sample.service.importCandidate(first.source, first.revision), sample.service.importCandidate(second.source, second.revision)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected"); assert.ok(failed && failed.status === "rejected"); assert.match(String(failed.reason), /retention limit/);
  assert.equal((await fs.readdir(sample.service.candidates)).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 64);
});

test("capacity: invalid manifest history is retained but cannot consume records or admit invalid new input", async context => {
  const sample = await fixture(context); await retainCandidateHistory(sample, 62, "usable");
  const corrupt = await sample.candidate("corrupt-cache"), corruptRoot = path.join(sample.service.candidates, corrupt.revision);
  await fs.cp(corrupt.source, corruptRoot, { recursive: true, errorOnExist: true, force: false });
  await fs.writeFile(path.join(corruptRoot, "manifest.json"), "existing-corrupt-manifest");
  const unknown = path.join(sample.service.candidates, "f".repeat(64)); await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, "manifest.json"), "unknown-evidence");
  const next = await sample.candidate("valid-after-corruption"); await sample.service.importCandidate(next.source, next.revision);
  assert.equal(await fs.readFile(path.join(corruptRoot, "manifest.json"), "utf8"), "existing-corrupt-manifest");
  assert.equal(await fs.readFile(path.join(unknown, "manifest.json"), "utf8"), "unknown-evidence");
  const invalid = await sample.candidate("invalid-new"); await fs.writeFile(path.join(invalid.source, "docs/guide.md"), "invalid-input");
  await assert.rejects(sample.service.importCandidate(invalid.source, invalid.revision), /verification/);
  await assert.rejects(fs.stat(path.join(sample.service.candidates, invalid.revision)), { code: "ENOENT" });
});

test("capacity: current-backend quota counts manifest records even when existing payload access is refused", async context => {
  const sample = await fixture(context); await retainCandidateHistory(sample, 63, "manifest-records");
  const next = await sample.candidate("beyond-manifest-records"), originalStat = fs.stat.bind(fs);
  let payloadAttempts = 0;
  const stats = context.mock.method(fs, "stat", (async (...args: Parameters<typeof fs.stat>) => {
    const parts = path.relative(sample.service.candidates, String(args[0])).split(path.sep);
    if (parts.length > 1 && /^[a-f0-9]{64}$/.test(parts[0]!) && parts[1] !== "manifest.json") { payloadAttempts++; throw new Error("Existing payload access refused"); }
    return originalStat(...args);
  }) as typeof fs.stat);
  try {
    await assert.rejects(sample.service.importCandidate(next.source, next.revision), /retention limit/);
    assert.equal(payloadAttempts, 0);
    await assert.rejects(verifyWebPatch(path.join(sample.service.candidates, sample.service.status().active!), sample.service.status().active!), /Existing payload access refused/);
    assert.ok(payloadAttempts > 0);
  } finally { stats.mock.restore(); }
  assert.equal(sample.service.status().state, "ready");
});
