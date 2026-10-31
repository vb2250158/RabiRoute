import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { NativeWebguiStaticOwner } from "./nativeWebguiStaticOwner.js";
import { createWebguiStaticOperations } from "./webguiStaticOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { WebPatchService } from "./webPatchService.js";
import { compileApiContract } from "./apiOperationContract.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";

async function fixture(t: test.TestContext, patch = false, linkedRoot = false, script = "export const ready=true;") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webgui-static-owner-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("webgui-static-owner-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dist = path.join(root, "ribiwebgui/dist");
  await fs.mkdir(path.join(dist, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "assets")); await fs.mkdir(path.join(root, "docs")); await fs.mkdir(path.join(root, "dist"));
  await fs.mkdir(path.join(root, "dist/plugins/packages"), { recursive: true });
  await fs.writeFile(path.join(dist, "index.html"), '<!doctype html><html><head><link href="./assets/main-abcdefgh.css"></head><body><script src="/assets/main-abcdefgh.js"></script>首页</body></html>');
  await fs.writeFile(path.join(dist, "assets/main-abcdefgh.css"), "body{color:red}");
  await fs.writeFile(path.join(dist, "assets/main-abcdefgh.js"), script);
  await fs.writeFile(path.join(dist, "assets/shared.svg"), "dist svg");
  await fs.writeFile(path.join(root, "assets/shared.svg"), "package svg");
  await fs.writeFile(path.join(root, "docs/guide.md"), "# Guide\n中文说明");
  await fs.writeFile(path.join(root, "dist/manager.js"), "export const fixture=true;");
  const patches = new WebPatchService({ packageRoot: root, stateRoot: path.join(root, "patch-state"),
    identity: () => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugin" }),
    serialize: async (_generation, action) => action() });
  await patches.ready;
  assert.equal(patches.status().state, "ready", patches.status().error);
  const servedRoot = linkedRoot ? path.join(root, "web-root") : dist;
  if (linkedRoot) await fs.symlink(dist, servedRoot, process.platform === "win32" ? "junction" : "dir");
  const owner = new NativeWebguiStaticOwner({ packageRoot: root, webuiDistPath: servedRoot,
    patches: { candidates: patches.candidates, status: () => ({ ...patches.status(), active: patch ? patches.status().active : undefined }),
      staticManifest: revision => patches.staticManifest(revision) },
    isControlPath: value => value === "/api" || value.startsWith("/api/") || value === "/health" || value === "/meta" });
  const operations = createWebguiStaticOperations(owner);
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerHttpProxies("fixture-static", [...operations.resources, operations.fallback].map(definition => ({ ...definition, async handler(input) {
    if (input.request.headers["x-fixture-deadline"] !== "yes") return definition.handler(input);
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(new Error("Fixture request deadline.")), 100);
    try { await definition.handler({ ...input, signal: AbortSignal.any([input.signal, deadline.signal]),
      assertCurrent() { input.assertCurrent(); deadline.signal.throwIfAborted(); } }); }
    finally { clearTimeout(timer); }
  } })));
  const business = registry.registerOperations("fixture-other-owner", [{ contract: fixtureApiContract({ operationId: "fixture.business.read", method: "GET", pathTemplate: "/api/fixture-known",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object" } } } }), handler: () => ({ status: 200, body: { known: true } }) },
  { contract: fixtureApiContract({ operationId: "fixture.host-private.read", method: "GET", pathTemplate: "/_rabiroute/host/fixture", exposure: "internal",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "403": { mediaType: "application/json", schema: { type: "object" } } } }), handler: () => ({ status: 403, body: { privateOwner: true } }) }]);
  let revoked = false;
  const server = http.createServer((request, response) => {
    if (request.headers["x-fixture-connection"] === "yes") markAuthenticatedConnectionRequest(request, () => { if (revoked) throw new Error("fixture revoked"); });
    const url = new URL(request.url!, "http://fixture.invalid");
    if (registry.handle(request, url, response)) return;
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await business.dispose(); await patches.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(owner.activeFileCount(), 0);
  });
  async function request(resource: string, method = "GET", headers: Record<string, string> = {}) {
    return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const outgoing = http.request({ host: "127.0.0.1", port, path: resource, method, headers }, incoming => {
        const chunks: Buffer[] = []; incoming.on("data", bytes => chunks.push(bytes));
        incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
        incoming.on("error", reject);
      }); outgoing.on("error", reject); outgoing.end();
    });
  }
  return { owner, root, dist, servedRoot, patches, registration, registry, operations, request, port, revoke: () => { revoked = true; } };
}

for (const pinned of [false, true]) test(`complete large WebGUI resources reach EOF (${pinned ? "pinned" : "distribution"})`, { timeout: 20000 }, async t => {
  const expected = "x".repeat(1024 * 1024 + 17);
  const f = await fixture(t, pinned, false, expected);
  const resource = pinned ? `/_rabiroute/web/${f.patches.status().active}/web/assets/main-abcdefgh.js` : "/assets/main-abcdefgh.js";
  const response = await f.request(resource);
  assert.equal(response.status, 200);
  assert.equal(response.body, expected);
  await f.registration.dispose();
  assert.equal(f.owner.activeFileCount(), 0);
});

test("native collection contracts compile without per-hash entries", async t => {
  const f = await fixture(t); const definitions = createWebguiStaticOperations(f.owner);
  assert.equal(definitions.resources.length + 1, 2);
  assert.equal(definitions.fallback.contract.httpProxy?.dispatch, "final-fallback");
  for (const definition of [...definitions.resources, definitions.fallback]) {
    const compiled = compileApiContract(definition);
    assert.equal(compiled.contract.httpProxy !== undefined, true);
    assert.equal(compiled.contract.exposure, "public");
    assert.equal(compiled.contract.method, "*");
  }
});

test("formal final fallback preserves other-owner APIs, native 405, private handlers and discovery phase", async t => {
  const f = await fixture(t);
  const known = await f.request("/api/fixture-known"); assert.equal(known.status, 200); assert.deepEqual(JSON.parse(known.body), { known: true });
  const wrongMethod = await f.request("/api/fixture-known", "POST"); assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.allow, "GET");
  const privateRequest = await f.request("/_rabiroute/host/fixture"); assert.equal(privateRequest.status, 403); assert.deepEqual(JSON.parse(privateRequest.body), { privateOwner: true });
  const snapshot = f.registry.catalogSnapshot();
  assert.equal(snapshot.operations.some(value => value.contract.operationId === "fixture.host-private.read"), false);
  const definition = snapshot.operations.find(value => value.contract.operationId === "manager.webgui-static.distribution");
  assert.equal(definition?.contract.httpProxy?.dispatch, "final-fallback");
  const openapi = (await apiCatalogOpenApi(snapshot));
  assert.match(JSON.stringify(openapi), /final-fallback/);
  assert.throws(() => f.registry.registerHttpProxies("fixture-second-fallback", [{ ...f.operations.fallback,
    contract: { ...f.operations.fallback.contract, operationId: "fixture.second.final-fallback" } }]), /final.*fallback/i);
});

test("real HTTP retains package priority, media/cache, SPA/API boundary and public reads", async t => {
  const f = await fixture(t);
  const root = await f.request("/"); assert.equal(root.status, 200); assert.match(root.body, /首页/); assert.equal(root.headers["cache-control"], "no-store");
  const packageAsset = await f.request("/assets/shared.svg"); assert.equal(packageAsset.body, "package svg");
  assert.equal(packageAsset.headers["content-type"], "image/svg+xml; charset=utf-8"); assert.equal(packageAsset.headers["cache-control"], undefined);
  const head = await f.request("/assets/shared.svg", "HEAD"); assert.equal(head.body, ""); assert.equal(head.headers["cache-control"], "no-cache");
  const hashed = await f.request("/assets/main-abcdefgh.js"); assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
  const spa = await f.request("/settings/routes"); assert.equal(spa.body, root.body);
  for (const resource of ["/api/missing", "/_rabiroute/host/private"]) {
    const response = await f.request(resource); assert.equal(response.status, 404); assert.doesNotMatch(response.body, /doctype|首页/);
  }
  const missing = await f.request("/missing.js"); assert.equal(missing.status, 503); assert.match(missing.body, /build is missing/);
  const nativeMethod = await f.request("/settings/routes", "POST"); assert.equal(nativeMethod.status, 200); assert.match(nativeMethod.body, /首页/);
  const encoded = await f.request("/assets/%73hared.svg"); assert.equal(encoded.body, "dist svg");
});

test("Range, conditional requests, compression and CSP preserve the native absence", async t => {
  const f = await fixture(t);
  const result = await f.request("/assets/main-abcdefgh.js", "GET", { range: "bytes=0-2", "if-none-match": "*", "if-modified-since": new Date().toUTCString(), "accept-encoding": "gzip, br" });
  assert.equal(result.status, 200); assert.equal(result.body, "export const ready=true;");
  for (const header of ["content-range", "accept-ranges", "etag", "last-modified", "content-encoding", "content-security-policy"]) assert.equal(result.headers[header], undefined);
  assert.equal((await f.request("/", "HEAD")).body, "");
});

test("immutable patch files and documentation retain hash, HEAD and active-shell rewriting", async t => {
  const f = await fixture(t, true); const revision = f.patches.status().active!;
  const shell = await f.request("/settings"); assert.equal(shell.status, 200);
  assert.match(shell.body, new RegExp(`data-rabi-web-release="${revision}"`));
  assert.match(shell.body, new RegExp(`href="/_rabiroute/web/${revision}/web/assets/main-abcdefgh.css"`));
  assert.match(shell.body, new RegExp(`src="/_rabiroute/web/${revision}/web/assets/main-abcdefgh.js"`));
  const docs = await f.request(`/_rabiroute/web/${revision}/docs/guide.md`); assert.equal(docs.status, 200); assert.equal(docs.body, "# Guide\n中文说明");
  assert.equal(docs.headers["content-type"], "text/plain; charset=utf-8"); assert.equal(docs.headers["x-content-type-options"], "nosniff"); assert.equal(docs.headers["x-rabiroute-web-revision"], revision);
  assert.equal((await f.request(`/_rabiroute/web/${revision}/docs/guide.md`, "HEAD")).body, "");
  assert.equal((await f.request(`/_rabiroute/web/${revision}/docs/guide.md`, "POST")).status, 405);
  assert.equal((await f.request(`/_rabiroute/web/${revision}/docs/%zz`)).status, 400);
  assert.equal((await f.request(`/_rabiroute/web/${revision}/docs/%2e%2e%2fsecret`)).status, 404);
  await fs.writeFile(path.join(f.patches.candidates, revision, "docs/guide.md"), "tampered");
  assert.equal((await f.request(`/_rabiroute/web/${revision}/docs/guide.md`)).status, 404);
});

test("malformed/escaping paths, missing roots and private filesystem links fail closed", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "private.txt"), "fixture-private-data");
  for (const resource of ["/assets/%00bad.js", "/..%5cprivate.txt", "/assets/%2e%2e%5c%2e%2e%5cprivate.txt"]) {
    const result = await f.request(resource); assert.ok([404, 503].includes(result.status)); assert.doesNotMatch(result.body, /fixture-private-data/);
  }
  assert.equal((await f.request("/assets/%zz.js")).status, 500);
  try { await fs.symlink(path.join(f.root, "private.txt"), path.join(f.dist, "leak.txt")); }
  catch (error) { if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; t.diagnostic("File symlink creation unavailable on this host; directory junction coverage follows."); }
  const link = await f.request("/leak.txt"); assert.equal(link.status, 503); assert.doesNotMatch(link.body, /fixture-private-data/);
  await fs.symlink(f.root, path.join(f.dist, "outside"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.request("/outside/private.txt")).status, 503);
  await fs.rename(f.dist, f.dist + "-removed"); assert.equal((await f.request("/")).status, 503);
});

test("backpressure cancellation and retirement join the real file descriptor close", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dist, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
  const stopped = new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin" }, response => {
      response.pause(); assert.equal(f.owner.activeFileCount(), 1);
      void f.registration.dispose().then(() => { assert.equal(f.owner.activeFileCount(), 0); resolve(); }, reject);
    }); request.on("error", reject);
  });
  await stopped;
  assert.equal(f.registration.activeOperationCount(), 0);
});

test("connection revocation fences streaming bytes and releases files", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dist, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin", headers: { "x-fixture-connection": "yes" } }, response => {
      response.once("data", () => f.revoke()); response.on("error", () => resolve());
      response.on("end", () => reject(new Error("Revoked response reached successful EOF.")));
    }); request.on("error", reject);
  });
  await f.registration.dispose(); assert.equal(f.owner.activeFileCount(), 0);
});

test("a client disconnect closes the actual producer and permits retirement", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dist, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin" }, response => {
      response.once("data", () => { response.destroy(); resolve(); });
    }); request.on("error", reject);
  });
  await f.registration.dispose(); assert.equal(f.owner.activeFileCount(), 0);
});

test("an owner deadline under backpressure closes the actual descriptor before its lease drains", { timeout: 5000 }, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dist, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin", headers: { "x-fixture-deadline": "yes" } }, response => {
      response.once("data", () => { response.pause(); setTimeout(() => response.resume(), 200); });
      response.once("aborted", () => { response.destroy(); resolve(); });
      response.once("error", () => resolve());
    }); request.on("error", reject);
  });
  await f.registration.dispose(); assert.equal(f.owner.activeFileCount(), 0); assert.equal(f.registration.activeOperationCount(), 0);
});

test("a replaced live resource root aborts an accepted stream", async t => {
  const f = await fixture(t, false, true); await fs.writeFile(path.join(f.dist, "large.bin"), Buffer.alloc(16 * 1024 * 1024, 0x61));
  let replacement: Promise<void> | undefined;
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin" }, response => {
      response.once("data", () => {
        replacement = (async () => {
          if (process.platform === "win32") await fs.rmdir(f.servedRoot); else await fs.unlink(f.servedRoot);
          await fs.mkdir(f.servedRoot);
        })();
        void replacement.catch(reject);
      });
      response.on("error", () => resolve());
      response.on("end", () => reject(new Error("Changed resource root reached successful EOF.")));
    }); request.on("error", reject);
  });
  await replacement; await f.registration.dispose(); assert.equal(f.owner.activeFileCount(), 0);
});

test("a deleted live resource aborts its accepted stream", async t => {
  const f = await fixture(t); const filename = path.join(f.dist, "large.bin"); await fs.writeFile(filename, Buffer.alloc(16 * 1024 * 1024, 0x61));
  let deletion: Promise<void> | undefined;
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: f.port, path: "/large.bin" }, response => {
      response.once("data", () => { deletion = fs.unlink(filename); });
      response.on("error", () => resolve());
      response.on("end", () => reject(new Error("Deleted resource reached successful EOF.")));
    }); request.on("error", reject);
  });
  await deletion; await f.registration.dispose(); assert.equal(f.owner.activeFileCount(), 0);
});

test("streamed shell rewriting survives UTF-8 and attribute chunk boundaries", async t => {
  const f = await fixture(t, true);
  const original = f.patches.status().active!;
  const html = '<html>' + '文'.repeat(21839) + '<script src="./assets/main-abcdefgh.js"></script><link href="assets/main-abcdefgh.css">'
    + '😀文x😺'.repeat(16384) + '</html>';
  await fs.writeFile(path.join(f.dist, "index.html"), html);
  // Import through a second genuine publication owner, retaining the original candidate for old pages.
  const next = new WebPatchService({ packageRoot: f.root, stateRoot: path.join(f.root, "next-patch-state"),
    identity: () => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugin" }),
    serialize: async (_generation, action) => action() });
  await next.ready; assert.equal(next.status().state, "ready", next.status().error);
  t.after(() => next.stop());
  const revision = next.status().active!; await f.patches.importCandidate(path.join(next.candidates, revision), revision);
  await f.patches.publish({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugin", operationId: "fixture-next", candidate: revision, expectedRevision: 0 });
  const result = await f.request("/");
  const expected = html.replace(/(<html\b)/i, `$1 data-rabi-web-release="${revision}"`)
    .replace(/((?:src|href)=["'])((?:\.\/|\/)?assets\/[^"']+)/g, (_match, prefix, asset: string) => `${prefix}/_rabiroute/web/${revision}/web/${asset.replace(/^\.?\//, "")}`);
  assert.equal(result.body, expected);
  assert.equal((await f.request(`/_rabiroute/web/${original}/web/assets/main-abcdefgh.js`)).status, 200);
});
