import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNapcatWebuiApiSession, type NapcatManagerContext } from "../messageEndpoints/napcatManager.js";
import type { NapcatApiSelection } from "./napcatApiTransport.js";

let fixtureNumber = 0;
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-webui-api-bridge-"));
  const configPath = path.join(root, "webui.json");
  const token = `example-token-${++fixtureNumber}`;
  fs.writeFileSync(configPath, JSON.stringify({ token, port: 6099 }));
  const previousConfig = process.env.NAPCAT_WEBUI_CONFIG;
  const previousFetch = globalThis.fetch;
  const previousReadFile = fs.promises.readFile;
  process.env.NAPCAT_WEBUI_CONFIG = configPath;
  const paths: string[] = [];
  const requests: Array<{ path: string; method?: string; authorization?: string }> = [];
  const instance = { id: "instance", gatewayPort: 3001, httpUrl: "http://127.0.0.1:3000", webuiUrl: "http://127.0.0.1:6099/webui",
    webuiToken: token, botUserId: "12345", enabled: true, workingDir: root };
  const runtime = { definition: { id: "route", enabled: true, gatewayPort: 3001, messageAdapters: ["napcat"], napcatInstances: [instance] } };
  let afterAuthentication: (() => void) | undefined;
  fs.promises.readFile = (async (file: fs.PathLike, ...args: unknown[]) => {
    assert.equal(path.resolve(String(file)), configPath, "Only the fixture config may be read");
    paths.push(String(file));
    return (previousReadFile as (...params: unknown[]) => Promise<unknown>)(file, ...args);
  }) as typeof fs.promises.readFile;
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "http://127.0.0.1:6099");
    requests.push({ path: target.pathname, method: options?.method, authorization: new Headers(options?.headers).get("authorization") ?? undefined });
    if (target.pathname === "/api/auth/login") {
      afterAuthentication?.();
      return Response.json({ code: 0, data: { Credential: "fixture-credential" } });
    }
    assert.equal(target.pathname, "/api/base/GetNapCatVersion");
    return Response.json({ code: 0, data: { version: "fixture" } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch; fs.promises.readFile = previousReadFile;
    if (previousConfig === undefined) delete process.env.NAPCAT_WEBUI_CONFIG; else process.env.NAPCAT_WEBUI_CONFIG = previousConfig;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context: NapcatManagerContext = { rootDir: root, getRuntimes: () => [runtime], normalizeNapCatInstances: definition => definition.napcatInstances ?? [],
    appendLog() {}, checkHttpEndpoint: async () => { throw new Error("Not a bridge dependency"); } };
  let authorityChecks = 0;
  const selection: NapcatApiSelection = { routeId: "route", instanceId: "instance", botUserId: "12345", httpUrl: instance.httpUrl,
    accessToken: "example-onebot-token", assertCurrent() { authorityChecks++; } };
  return { context, selection, instance, runtime, paths, requests, authorityChecks: () => authorityChecks,
    setAfterAuthentication: (callback: () => void) => { afterAuthentication = callback; } };
}

test("manager bridge reuses original private token lookup and session cache for fixed reads", async t => {
  const f = fixture(t);
  const session = await openNapcatWebuiApiSession(f.context, f.selection, AbortSignal.timeout(2000));
  const response = await session.requestFixed("GET", "/api/base/GetNapCatVersion", AbortSignal.timeout(2000));
  assert.equal((await response.json()).data.version, "fixture");
  assert.equal(f.paths.length, 1);
  assert.deepEqual(f.requests.map(item => item.path), ["/api/auth/login", "/api/base/GetNapCatVersion"]);
  assert.equal(f.requests[1]!.authorization, "Bearer fixture-credential");
  assert.equal(f.requests[1]!.method, "GET");
  assert.ok(f.authorityChecks() >= 4);
  assert.doesNotMatch(JSON.stringify(session), /example-token|fixture-credential/);
  f.instance.webuiUrl = "http://127.0.0.1:6100/webui";
  await assert.rejects(() => session.requestFixed("GET", "/api/base/GetNapCatVersion", AbortSignal.timeout(2000)), /QQ_WEBUI_BINDING_CHANGED/);
  assert.equal(f.requests.length, 2);
});

test("WebUI configuration changes during authentication reject the original bridge before reads", async t => {
  const f = fixture(t);
  f.setAfterAuthentication(() => { f.instance.webuiToken = "changed-example-token"; });
  await assert.rejects(() => openNapcatWebuiApiSession(f.context, f.selection, AbortSignal.timeout(2000)), /QQ_WEBUI_BINDING_CHANGED/);
  assert.deepEqual(f.requests.map(item => item.path), ["/api/auth/login"]);
});

test("aborted and ambiguous instance requests stop before config or credential lookup", async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => openNapcatWebuiApiSession(f.context, f.selection, controller.signal));
  f.runtime.definition.napcatInstances.push({ ...f.instance });
  await assert.rejects(() => openNapcatWebuiApiSession(f.context, f.selection, AbortSignal.timeout(2000)), /QQ_WEBUI_INSTANCE_UNAVAILABLE/);
  assert.equal(f.paths.length, 0); assert.equal(f.requests.length, 0);
});
