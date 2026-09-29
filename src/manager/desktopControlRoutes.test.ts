import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopConfigFilePayload,
  handleDesktopControlApi,
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

test("desktop API preserves stable route transaction errors and status", async () => {
  const responseWritten = deferred<void>();
  let actualStatus = 0;
  let actualBody: unknown;
  const failure = Object.assign(new Error("Route catalog update is temporarily unavailable."), {
    statusCode: 503,
    code: "route_catalog_unavailable",
    cause: new Error("private \\\\nas\\roles path")
  });
  const handled = handleDesktopControlApi(
    { method: "POST" } as never,
    new URL("http://127.0.0.1/open-config-file?type=role&roleId=YeYu"),
    {} as never,
    {
      openConfigFilePayload: () => Promise.reject(failure),
      jsonResponse(_response, statusCode, body) {
        actualStatus = statusCode;
        actualBody = body;
        responseWritten.resolve();
      }
    }
  );

  assert.equal(handled, true);
  await responseWritten.promise;
  assert.equal(actualStatus, 503);
  assert.deepEqual(actualBody, {
    code: -1,
    errorCode: "route_catalog_unavailable",
    message: "Route catalog update is temporarily unavailable."
  });
  assert.equal(JSON.stringify(actualBody).includes("nas"), false);
});
