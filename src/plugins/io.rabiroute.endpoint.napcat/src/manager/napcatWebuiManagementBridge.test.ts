import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNapcatWebuiManagementSession, verifyNapcatWebuiTokenCommitSource, type NapcatManagerContext } from "../messageEndpoints/napcatManager.js";
import type { NapcatWebuiManagementSelection } from "./napcatWebuiManagementOperations.js";

let fixtureNumber = 1000;
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
  const requests: Array<{ path: string; method?: string; authorization?: string; body?: unknown }> = [];
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
    requests.push({ path: target.pathname, method: options?.method, authorization: new Headers(options?.headers).get("authorization") ?? undefined, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (target.pathname === "/api/auth/login") {
      afterAuthentication?.();
      return Response.json({ code: 0, data: { Credential: "fixture-credential" } });
    }
    assert.ok(["/api/QQLogin/GetPlatformInfo", "/api/QQLogin/SetQuickLoginQQ"].includes(target.pathname));
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
  const selection: NapcatWebuiManagementSelection = { routeId: "route", instanceId: "instance", expectedUserId: "", assertCurrent() { authorityChecks++; } };
  return { context, selection, instance, runtime, paths, requests, authorityChecks: () => authorityChecks,
    setAfterAuthentication: (callback: () => void) => { afterAuthentication = callback; } };
}

test("first-login bridge preserves original private credentials, fixed method/body and binding admission", async t => {
  const f = fixture(t);
  f.instance.botUserId = "";
  f.instance.httpUrl = "";
  let admissions = 0;
  f.context.runBindingOperation = async (request, operation) => {
    assert.deepEqual(request, { gatewayId: "route", instanceId: "instance" });
    admissions++;
    return operation();
  };
  const signal = AbortSignal.timeout(2000);
  const session = await openNapcatWebuiManagementSession(f.context, f.selection, signal);
  await session.requestManagement("POST", "/api/QQLogin/GetPlatformInfo", {}, signal);
  await session.runBindingOperation(() => session.requestManagement("POST", "/api/QQLogin/SetQuickLoginQQ", { uin: "" }, signal));
  assert.equal(admissions, 1);
  assert.equal(f.paths.length, 1);
  assert.deepEqual(f.requests.map(item => item.path), ["/api/auth/login", "/api/QQLogin/GetPlatformInfo", "/api/QQLogin/SetQuickLoginQQ"]);
  assert.equal(f.requests[2]!.authorization, "Bearer fixture-credential");
  assert.deepEqual(f.requests[2]!.body, { uin: "" });
  await assert.rejects(() => session.requestManagement("POST", "/api/QQLogin/GetPlatformInfo?url=http://private", {}, signal));
  await assert.rejects(() => session.requestManagement("POST", "/api/QQLogin/GetPlatformInfo", { token: "private" }, signal));
  assert.equal(f.requests.length, 3);
  f.instance.webuiUrl = "http://127.0.0.1:6100";
  await assert.rejects(() => session.runBindingOperation(async () => 1), /QQ_WEBUI_BINDING_CHANGED/);
});

test("changed WebUI credentials during authentication stop first-login management", async t => {
  const f = fixture(t);
  f.setAfterAuthentication(() => { f.instance.webuiToken = "changed"; });
  await assert.rejects(() => openNapcatWebuiManagementSession(f.context, f.selection, AbortSignal.timeout(2000)), /QQ_WEBUI_BINDING_CHANGED/);
  assert.equal(f.requests.length, 1);
});

test("token source proof reuses the exact original private config and never discloses token or path",async t=>{
 const f=fixture(t),configPath=path.join(f.context.rootDir,"webui.json");
 const before=await verifyNapcatWebuiTokenCommitSource(f.context,f.selection,f.instance.webuiToken);
 assert.deepEqual(before,{credentialSource:"provided",nativeConfigMatches:true,configuredValueMatches:true,explicitTokenSource:"instance"});
 fs.writeFileSync(configPath,JSON.stringify({token:"NEW_PRIVATE_TOKEN",port:6099}));
 const nativeWritten=await verifyNapcatWebuiTokenCommitSource(f.context,f.selection,"NEW_PRIVATE_TOKEN");assert.equal(nativeWritten.nativeConfigMatches,true);assert.equal(nativeWritten.configuredValueMatches,false);
 f.instance.webuiToken="";const fileSource=await verifyNapcatWebuiTokenCommitSource(f.context,f.selection,"NEW_PRIVATE_TOKEN");assert.deepEqual(fileSource,{credentialSource:"config",nativeConfigMatches:true,configuredValueMatches:true});assert(!JSON.stringify(fileSource).includes("PRIVATE"));assert(!JSON.stringify(fileSource).includes(configPath));
});

test("only the typed token rotation runner delegates replacement authority while ordinary bindings retain their original tail fence",async t=>{
 const f=fixture(t),session=await openNapcatWebuiManagementSession(f.context,f.selection,AbortSignal.timeout(2000));
 assert.ok(session.runTokenRotation);assert.equal(await session.runTokenRotation(async()=>{f.instance.webuiToken="expected-own-write";return "replacement-will-be-verified-by-token-owner";}),"replacement-will-be-verified-by-token-owner");
 assert.throws(session.assertCurrent,/QQ_WEBUI_BINDING_CHANGED/);await assert.rejects(session.runBindingOperation(async()=>true),/QQ_WEBUI_BINDING_CHANGED/);
});
