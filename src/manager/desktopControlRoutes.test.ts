import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopSettingsStore } from "./desktopSettings.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import {
  desktopConfigFilePayload,
  createDesktopControlOperations,
  type DesktopConfigFileContext
} from "./desktopControlRoutes.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function context(overrides: Partial<DesktopConfigFileContext> = {}): DesktopConfigFileContext {
  return {
    routeRoot: "C:\\route",
    rolesRoot: "C:\\roles",
    async ensureDataDirs() {},
    findRoute: () => undefined,
    async ensurePersonaConfigFile(roleId) { return `C:\\roles\\${roleId}\\personaConfig.json`; },
    async ensureRoleFile(roleId, roleFile) { return `C:\\roles\\${roleId}\\${roleFile}`; },
    async ensureRoleFolder(roleId) { return `C:\\roles\\${roleId}`; },
    adapterConfigPath: configName => `C:\\route\\${configName}\\adapterConfig.json`,
    async writeAdapterConfigFile() {},
    openPath() {},
    ...overrides
  };
}

test("desktop open waits for the child-backed role transaction before exposing the path", async () => {
  const ensured = deferred<string>();
  const opened: string[] = [];
  const operation = desktopConfigFilePayload("role", null, "YeYu", context({
    ensureRoleFile: () => ensured.promise,
    openPath: target => { opened.push(target); }
  }));

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(opened, []);
  ensured.resolve("C:\\roles\\YeYu\\persona.md");
  const payload = await operation;
  assert.deepEqual(opened, ["C:\\roles\\YeYu\\persona.md"]);
  assert.deepEqual(payload, { code: 0, data: { path: "C:\\roles\\YeYu\\persona.md" } });
});

test("recording folder aliases wait for the owner and preserve failures", async () => {
  for (const alias of ["xiaomi-recordings", "xiaomi-media", "camera-clips"]) {
    const ensured = deferred<string>();
    const opened: string[] = [];
    const operation = desktopConfigFilePayload(alias, null, "example", context({
      ensureRoleFolder(roleId, subfolder) {
        assert.equal(roleId, "example");
        assert.equal(subfolder, "xiaomi-media");
        return ensured.promise;
      },
      openPath: target => { opened.push(target); }
    }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(opened, []);
    ensured.resolve("recordings-path");
    assert.deepEqual(await operation, { code: 0, data: { path: "recordings-path" } });
    assert.deepEqual(opened, ["recordings-path"]);

    const failure = new Error("transaction unavailable");
    await assert.rejects(desktopConfigFilePayload(alias, null, "example", context({
      ensureRoleFolder: async () => { throw failure; },
      openPath: () => assert.fail("must not open a failed transaction")
    })), error => error === failure);
    await assert.rejects(desktopConfigFilePayload(alias, null, null, context({
      ensureRoleFolder: async () => { assert.fail("missing role must not create a directory"); },
      openPath: () => assert.fail("missing role must not open a directory")
    })), /请先选择/);
  }
});

test("desktop route open always awaits the serialized route upsert", async () => {
  const committed = deferred<void>();
  const opened: string[] = [];
  const operation = desktopConfigFilePayload("routes", "route-a", null, context({
    findRoute: () => ({ id: "route-a", configName: "route-a" }),
    writeAdapterConfigFile: () => committed.promise,
    openPath: target => { opened.push(target); }
  }));

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(opened, []);
  committed.resolve();
  await operation;
  assert.deepEqual(opened, ["C:\\route\\route-a\\adapterConfig.json"]);
});


async function fixture(t: test.TestContext, options: { readOnly?: boolean; open?: (type: string | null, gateway: string | null, role: string | null) => Promise<Record<string, unknown>>; changed?: () => void } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-operations-"));
  const file = path.join(root, "settings.json"), settings = new DesktopSettingsStore(file), registry = new ManagerPluginRouteRegistry();
  const events: string[] = [], opens: unknown[][] = [];
  const definitions = createDesktopControlOperations({ settings, readOnly: options.readOnly ?? false, settingsChanged: saved => { events.push(saved.webTheme); options.changed?.(); }, openConfigFilePayload: options.open ?? (async (...selection) => { opens.push(selection); return { code: 0, data: { path: "controlled-path" } }; }) });
  const registration = registry.registerOperations("desktop-fixture", definitions);
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (url = "/api/desktop/settings", method = "GET", body?: unknown, authenticated = true, signal?: AbortSignal) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(base + url, { method, signal, headers: { "content-type": "text/plain", ...(authenticated ? { authorization: "Bearer fixture" } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, body: raw ? JSON.parse(raw) : null }); });
    }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned Desktop fixture timed out."))); request.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { root, file, settings, registry, definitions, registration, events, opens, send };
}

test("four executable Desktop operations share the native persistent settings owner", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.definitions.map(value => value.contract.operationId), ["manager.desktop.settings.read", "manager.desktop.settings.patch", "manager.desktop.settings.put", "manager.desktop.config.open"]);
  const initial = await f.send(); assert.equal(initial.status, 200); assert.equal(initial.body.data.autostartConfigured, false);
  const patch = await f.send(undefined, "PATCH", { screenshot: { enabled: true, shortcut: " F3 ", autoCopy: false }, autostart: true, theme: "dark" });
  assert.equal(patch.status, 200); assert.equal(patch.body.data.autostartConfigured, true); assert.equal(patch.body.data.screenshot.shortcut, "F3"); assert.deepEqual(f.events, ["system"]);
  const put = await f.send(undefined, "PUT", { screenshot: { clipboardShortcut: " F4 " }, unknown: "discard" });
  assert.equal(put.status, 200); assert.equal(put.body.data.screenshot.enabled, true); assert.equal(put.body.data.screenshot.shortcut, "F3"); assert.equal(put.body.data.screenshot.autoCopy, false); assert.equal(put.body.data.screenshot.clipboardShortcut, "F4"); assert.equal(put.body.data.autostart, true);
  assert.deepEqual(new DesktopSettingsStore(f.file).read(), f.settings.read()); assert.deepEqual((await f.send()).body.data, put.body.data);
  assert.equal((await f.send(undefined, "PATCH", "null")).status, 200); assert.equal((await f.send(undefined, "PUT", "")).status, 200);
});

test("read-only Desktop settings reject malformed writes before parsing while public open behavior remains available", async t => {
  const f = await fixture(t, { readOnly: true });
  assert.equal((await f.send()).status, 200);
  for (const method of ["PUT", "PATCH"]) { const reply = await f.send(undefined, method, "malformed"); assert.equal(reply.status, 403); assert.deepEqual(reply.body, { code: -1, message: "Manager is read-only." }); }
  assert.equal(f.settings.autostartConfigured(), false); assert.deepEqual(f.events, []);
  const opened = await f.send("/open-config-file?type=manager", "POST", "malformed"); assert.equal(opened.status, 200); assert.deepEqual(f.opens, [["manager", null, null]]);
});

test("Desktop config selection preserves query first-values, ignored bodies and native coded errors", async t => {
  const f = await fixture(t);
  const reply = await f.send("/open-config-file?type=role&type=manager&roleId=first&roleId=second&gatewayId=&ignored=yes", "POST", "not-json");
  assert.equal(reply.status, 200); assert.deepEqual(f.opens, [["role", "", "first"]]);
  const failure = Object.assign(new Error("Controlled owner transaction unavailable."), { statusCode: 503, code: "route_catalog_unavailable", cause: new Error("private-cause") });
  const failed = await fixture(t, { open: async () => { throw failure; } });
  const error = await failed.send("/open-config-file?type=role", "POST"); assert.equal(error.status, 503); assert.deepEqual(error.body, { code: -1, errorCode: "route_catalog_unavailable", message: "Controlled owner transaction unavailable." });
  assert.equal(JSON.stringify(error.body).includes("private-cause"), false);
  assert.equal((await f.send("/open-config-file", "GET")).status, 405); assert.equal((await f.send(undefined, "DELETE")).status, 405); assert.equal((await f.send(undefined, "GET", undefined, false)).status, 401);
});

test("settings event failure preserves native 400 and independent readback proves the prior write", async t => {
  const f = await fixture(t, { changed: () => { throw new Error("Controlled event failure."); } });
  const reply = await f.send(undefined, "PATCH", { autostart: true });
  assert.equal(reply.status, 400); assert.deepEqual(reply.body, { code: -1, message: "Controlled event failure." });
  assert.equal(new DesktopSettingsStore(f.file).read().autostart, true); assert.equal((await f.send()).body.data.autostart, true);
});

test("Desktop retirement joins original file preparation after HTTP disconnect without replaying an opener", async t => {
  const prepared = deferred<string>(), entered = deferred<void>(), opened: string[] = [];
  t.after(() => prepared.resolve("controlled-path"));
  const f = await fixture(t, { open: (type, gateway, role) => desktopConfigFilePayload(type, gateway, role, context({ ensureRoleFile: async () => { entered.resolve(); return prepared.promise; }, openPath: target => { opened.push(target); } })) });
  const abort = new AbortController(), pending = f.send("/open-config-file?type=role&roleId=example", "POST", undefined, true, abort.signal).catch(() => null);
  await Promise.race([entered.promise, pending.then(() => { throw new Error("Desktop fixture ended before owner entry."); })]); abort.abort(); await pending;
  let retired = false; const retiring = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false); assert.deepEqual(opened, []);
  prepared.resolve("controlled-path"); await retiring; assert.equal(retired, true); assert.deepEqual(opened, ["controlled-path"]);
});
