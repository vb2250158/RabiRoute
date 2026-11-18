import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatWebuiManagementOperations, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { isNapcatMirrorPrefix } from "./napcatWebuiMetadataViews.js";
import { NapcatWebuiSessions } from "../messageEndpoints/napcatWebuiSession.js";

type Row = Record<string, unknown>;
function fixture(t: test.TestContext) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-mirror-set-"));
  t.after(() => { assert.equal(path.dirname(rootDir), os.tmpdir()); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const state = { mirror: "https://old.example/PRIVATE_OLD_PATH?token=PRIVATE_OLD_TOKEN", loggedIn: true, userId: "12345", readOnly: false,
    cacheClears: 0, loseSetterReply: false, changeDuringQueue: false, changeAfterReadback: false, corruptReadback: false };
  const native: Array<{ method: string; pathname: string; body: Row }> = [];
  const route = { id: "fixture", gatewayPort: 3001, enabled: true, messageAdapters: ["napcat"],
    napcatInstances: [{ id: "instance", enabled: true, botUserId: "12345", httpUrl: "" }] } as GatewayDefinition;
  const context: NapcatWebuiManagementContext = { rootDir, readOnly: () => state.readOnly, local: () => true, route: () => route,
    transport: async () => { throw new Error("No external mirror or OneBot call"); },
    openManagementSession: async selection => ({ assertCurrent: selection.assertCurrent,
      runBindingOperation: async operation => { if (state.changeDuringQueue) state.userId = "54321"; return operation(); },
      requestManagement: async (method, pathname, body) => {
        native.push({ method, pathname, body });
        let data: unknown;
        if (pathname === "/api/QQLogin/CheckLoginStatus") data = { isLogin: state.loggedIn };
        else if (pathname === "/api/QQLogin/GetQQLoginInfo") data = { uin: state.userId };
        else if (pathname === "/api/Mirror/SetCustom") {
          assert.equal(method, "POST"); assert.deepEqual(Object.keys(body), ["mirror"]);
          assert.equal(typeof body.mirror, "string");
          state.mirror = body.mirror as string;
          state.cacheClears++;
          if (state.loseSetterReply) throw new Error("PRIVATE_NATIVE_RESPONSE containing PRIVATE_QUERY_TOKEN");
          data = { message: "Mirror set successfully" };
        } else if (pathname === "/api/Mirror/List") {
          assert.equal(method, "GET");
          data = { fileMirrors: [], rawMirrors: [], customMirror: state.corruptReadback ? "https://other.example/PRIVATE_OTHER" : state.mirror, timeout: 5000 };
          if (state.changeAfterReadback) state.userId = "54321";
        } else throw new Error("Unexpected native request");
        return Response.json({ code: 0, data });
      } }) };
  const operation = createNapcatWebuiManagementOperations(context).find(item => item.contract.operationId === "agent.qq.webui.management.mirror-custom.set")!;
  const input = (mirror: unknown, deliveryId = "fixture-set"): ApiOperationInput => ({ request: { headers: {} } as IncomingMessage, response: {},
    url: new URL("http://localhost/api/agent/qq/webui-management/mirror-custom.set"), path: {}, query: {},
    body: { routeId: "fixture", instanceId: "instance", params: { mirror }, deliveryId } } as ApiOperationInput);
  const run = (mirror: unknown, deliveryId?: string) => operation.handler(input(mirror, deliveryId));
  const persistedText = () => fs.readdirSync(rootDir, { recursive: true }).map(name => path.join(rootDir, String(name)))
    .filter(filename => fs.statSync(filename).isFile()).map(filename => fs.readFileSync(filename, "utf8")).join("\n");
  return { rootDir, state, native, context, operation, input, run, persistedText };
}

test("full HTTP/S mirror input, path/query and credentials are written verbatim and stay outside results/receipts", async t => {
  const f = fixture(t);
  const mirror = "HTTP://user:PRIVATE_PASSWORD@127.0.0.1:8080/PRIVATE_PATH/?token=PRIVATE_QUERY_TOKEN&target=#PRIVATE_FRAGMENT";
  const result = await f.run(mirror);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.state.mirror, mirror);
  assert.equal(f.native.find(call => call.pathname === "/api/Mirror/SetCustom")!.body.mirror, mirror);
  assert.equal(f.state.cacheClears, 1);
  const data = (result.body as { data: Row }).data;
  assert.equal(data.effectScope, "selected-native-process-memory");
  assert.equal((data.prefixMetadata as Row).origin, "http://127.0.0.1:8080");
  assert.equal((data.prefixMetadata as Row).hasQuery, true);
  assert.equal((data.prefixMetadata as Row).hasUserinfo, true);
  assert.equal((data.prefixMetadata as Row).executable, false);
  assert.match(String(data.afterDigest), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_|user:|token=/);
  assert.doesNotMatch(f.persistedText(), /PRIVATE_|user:|token=/);
});

test("empty input clears the same native preference without a separate restricted setter", async t => {
  const f = fixture(t);
  const result = await f.run("");
  assert.equal(result.status, 200);
  assert.equal(f.state.mirror, "");
  assert.equal(((result.body as {data:{prefixMetadata:Row}}).data.prefixMetadata).direct, true);
  assert.equal(f.state.cacheClears, 1);
});

test("closed URL syntax rejects before providers without imposing a target-host policy", async t => {
  for (const mirror of ["https://public.example/prefix?target=", "http://localhost:1/local/path", "https://192.168.0.1/private", "HTTPS://example.test/path/"]) assert.equal(isNapcatMirrorPrefix(mirror), true);
  for (const mirror of [42, null, "file:///private", "javascript:alert(1)", "ftp://example.test", "relative/path", "https://"]) {
    const f = fixture(t);
    assert.equal((await f.run(mirror)).status, 400);
    assert.equal(f.native.length, 0);
  }
  const f = fixture(t);
  const original = f.input("https://example.test");
  const extra = { ...original, body: { ...(original.body as Row), params: { mirror: "https://example.test", url: "http://elsewhere" } } };
  assert.equal((await f.operation.handler(extra)).status, 400);
  assert.equal(f.native.length, 0);
});

test("duplicates retain the original digest and changed URL conflicts without a second native write", async t => {
  const f = fixture(t), mirror = "https://example.test/PRIVATE_PATH?token=PRIVATE_QUERY_TOKEN";
  assert.equal((await f.run(mirror)).status, 200);
  assert.equal((await f.run(mirror)).status, 200);
  assert.equal((await f.run("https://other.test/other")).status, 409);
  assert.equal(f.state.cacheClears, 1);
  assert.doesNotMatch(f.persistedText(), /PRIVATE_|token=/);
});

test("accepted but lost native responses preserve the original uncertain ID without URL disclosure or replay", async t => {
  const f = fixture(t); f.state.loseSetterReply = true;
  const mirror = "https://example.test/PRIVATE_PATH?token=PRIVATE_QUERY_TOKEN";
  const first = await f.run(mirror);
  const second = await f.run(mirror);
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  assert.equal(f.state.cacheClears, 1);
  assert.doesNotMatch(JSON.stringify(first.body) + f.persistedText(), /PRIVATE_|token=/);
});

test("queued account changes prevent the write and post-readback changes retain uncertainty", async t => {
  const queued = fixture(t); queued.state.changeDuringQueue = true;
  assert.equal((await queued.run("https://example.test")).status, 202);
  assert.equal(queued.state.cacheClears, 0);
  const after = fixture(t); after.state.changeAfterReadback = true;
  assert.equal((await after.run("https://example.test")).status, 202);
  after.state.userId = "12345"; after.state.changeAfterReadback = false;
  assert.equal((await after.run("https://example.test")).status, 202);
  assert.equal(after.state.cacheClears, 1);
});

test("read-only, cancelled and malformed readback paths preserve the original owner boundaries", async t => {
  const readOnly = fixture(t); readOnly.state.readOnly = true;
  assert.equal((await readOnly.run("https://example.test")).status, 403); assert.equal(readOnly.native.length, 0);
  const cancelled = fixture(t), controller = new AbortController(); controller.abort();
  const original = cancelled.input("https://example.test");
  assert.notEqual((await cancelled.operation.handler({ ...original, signal: controller.signal })).status, 200);
  assert.equal(cancelled.native.length, 0);
  const changed = fixture(t); changed.state.corruptReadback = true;
  assert.equal((await changed.run("https://example.test")).status, 202);
  assert.equal(changed.state.cacheClears, 1);
  assert.doesNotMatch(changed.persistedText(), /PRIVATE_OTHER/);
});

test("the unchanged original credential session sends complete mirror values only to its fixed native path", async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const requests: Array<{ path: string; method: string | undefined; body: unknown }> = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://native.example");
    requests.push({ path: target.pathname, method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ code: 0, data: target.pathname.endsWith("/auth/login") ? { Credential: "fixture" } : { message: "ok" } });
  };
  const session = await new NapcatWebuiSessions().open("https://native.example/proxy", "fixture-token"); assert.ok(session);
  const mirror = "https://user:PRIVATE_PASSWORD@mirror.example/PRIVATE_PATH?token=PRIVATE_QUERY_TOKEN";
  await session.requestManagement("POST", "/api/Mirror/SetCustom", { mirror }, AbortSignal.timeout(2000));
  assert.equal(requests[1]!.path, "/proxy/api/Mirror/SetCustom");
  assert.equal(requests[1]!.method, "POST"); assert.deepEqual(requests[1]!.body, { mirror });
  const count = requests.length;
  await assert.rejects(async () => session.requestManagement("POST", "/api/Mirror/SetCustom", { mirror, action: "unknown" }, AbortSignal.timeout(2000)));
  await assert.rejects(async () => session.requestManagement("GET", "/api/Mirror/SetCustom", { mirror }, AbortSignal.timeout(2000)));
  assert.equal(requests.length, count);
});
