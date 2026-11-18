import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createNapcatWebuiManagementOperations, type NapcatWebuiManagementContext } from "./napcatWebuiManagementOperations.js";
import { projectNapcatWebuiMetadata } from "./napcatWebuiMetadataViews.js";

const config = { fileLog: false, consoleLog: true, fileLogLevel: "debug", consoleLogLevel: "verbose-user-value", packetBackend: "user-backend",
  packetServer: "not-a-proven-credential", o3HookMode: 0.5, autoTimeSync: false,
  bypass: { hook: true, window: false, module: true, process: true, container: false, js: false } };

test("config metadata preserves all eight declared typed fields and labels the limited ninth field", () => {
  const result = projectNapcatWebuiMetadata("napcat-global-config", { ...config, unknownSetting: "PRIVATE_FIXTURE" })!;
  const { packetServer: _packetServer, ...eight } = config;
  assert.deepEqual(result.config, eight);
  assert.deepEqual(result.packetServer, { present: true, valueType: "string", length: config.packetServer.length });
  assert.equal(result.omittedUnknownFieldCount, 1);
  assert.equal(result.runtimeApplied, "not-proven");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|not-a-proven-credential/);
  assert.deepEqual(result.invalidFields, []);
});

test("one malformed configured field keeps independent metadata available without inventing a default", () => {
  const result = projectNapcatWebuiMetadata("napcat-account-config", { ...config, fileLog: "false", packetServer: null,
    bypass: { hook: true, window: "invalid", unexpected: "PRIVATE_FIXTURE" } })!;
  assert.equal((result.config as Record<string, unknown>).consoleLog, true);
  assert.equal(Object.hasOwn(result.config as object, "fileLog"), false);
  assert.deepEqual((result.config as Record<string, unknown>).bypass, { hook: true });
  assert.deepEqual(result.invalidFields, ["fileLog", "bypass.window", "packetServer"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE/);
});

test("mirrors preserve native priority and origin while keeping path values private metadata", () => {
  const result = projectNapcatWebuiMetadata("mirror-list", {
    fileMirrors: ["https://user:PRIVATE_FIXTURE@mirror.example/base/path/?token=PRIVATE_FIXTURE#PRIVATE_FIXTURE", 42, "https://mirror.example/private-token-123/file"],
    rawMirrors: ["", "https://raw.example/prefix"], customMirror: "https://custom.example/root?auth=PRIVATE_FIXTURE", timeout: 2500.5 })!;
  const rows = result.fileMirrors as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map(item => item.index), [0, 2]);
  assert.equal(rows[0]!.origin, "https://mirror.example");
  assert.equal(rows[0]!.pathPresent, true);
  assert.equal(rows[0]!.pathLength, "/base/path/".length);
  assert.equal(rows[1]!.pathLength, "/private-token-123/file".length);
  assert.equal(Object.hasOwn(rows[0]!, "path"), false);
  assert.equal(Object.hasOwn(rows[0]!, "displayUrl"), false);
  assert.equal(rows[0]!.hasUserinfo, true); assert.equal(rows[0]!.hasQuery, true); assert.equal(rows[0]!.hasFragment, true);
  assert.equal(rows[0]!.executable, false); assert.equal(result.executable, false);
  assert.equal(result.timeoutMs, 2500.5); assert.equal(result.invalidItems, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIXTURE|private-token-123|\/base\/path\/|user:|token=/);
});

test("font absence requires a native boolean and cannot be inferred from a failed or malformed result", () => {
  assert.deepEqual(projectNapcatWebuiMetadata("webui-font-exists", false), { exists: false });
  assert.throws(() => projectNapcatWebuiMetadata("webui-font-exists", null), /RESPONSE_INVALID/);
  assert.throws(() => projectNapcatWebuiMetadata("webui-font-exists", "false"), /RESPONSE_INVALID/);
});

function ownerFixture() {
  let nativeUserId = "12345";
  const calls: string[] = [];
  const route = { id: "fixture", gatewayPort: 3001, enabled: true, messageAdapters: ["napcat"],
    napcatInstances: [{ id: "instance", enabled: true, botUserId: "12345", httpUrl: "" }] } as GatewayDefinition;
  let switchDuringRead = false;
  let loggedIn = true;
  let logoutDuringRead = false;
  const context: NapcatWebuiManagementContext = { rootDir: "unused-read-only-fixture", readOnly: () => false, local: () => true,
    route: () => route, transport: async () => { throw new Error("No OneBot dependency"); },
    openManagementSession: async selected => ({ assertCurrent: selected.assertCurrent, runBindingOperation: async run => run(),
      requestManagement: async (_method, pathname) => {
        calls.push(pathname);
        let data: unknown;
        if (pathname.endsWith("CheckLoginStatus")) data = { isLogin: loggedIn };
        else if (pathname.endsWith("GetQQLoginInfo")) data = { uin: nativeUserId };
        else if (pathname === "/api/NapCatConfig/GetUinConfig") { data = config; if (switchDuringRead) nativeUserId = "54321"; if (logoutDuringRead) { loggedIn = false; nativeUserId = ""; } }
        else throw new Error("Unexpected provider call");
        return Response.json({ code: 0, data });
      } }) };
  const operation = createNapcatWebuiManagementOperations(context).find(item => item.contract.operationId === "agent.qq.webui.management.napcat-account-config")!;
  const input = (params = {}): ApiOperationInput => ({ request: { headers: {} } as IncomingMessage, response: {},
    url: new URL("http://localhost/api/agent/qq/webui-management/napcat-account-config"), path: {}, query: {},
    body: { routeId: "fixture", instanceId: "instance", params } } as ApiOperationInput);
  return { operation, input, calls, setSwitch: () => { switchDuringRead = true; }, setLogout: () => { logoutDuringRead = true; } };
}

test("account config uses exact original native QQ before and after its fixed read", async () => {
  const f = ownerFixture();
  const result = await f.operation.handler(f.input());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(f.calls, ["/api/QQLogin/CheckLoginStatus", "/api/QQLogin/GetQQLoginInfo", "/api/NapCatConfig/GetUinConfig",
    "/api/QQLogin/CheckLoginStatus", "/api/QQLogin/GetQQLoginInfo"]);
  const changed = ownerFixture(); changed.setSwitch();
  const rejected = await changed.operation.handler(changed.input());
  assert.equal(rejected.status, 409);
  assert.equal(Object.hasOwn(rejected.body as object, "data"), false);
  const loggedOut = ownerFixture(); loggedOut.setLogout();
  assert.equal((await loggedOut.operation.handler(loggedOut.input())).status, 409);
});

test("caller paths, QQ selectors, mirror URLs and credentials reject before any provider call", async () => {
  for (const params of [{ path: "/private" }, { userId: "54321" }, { mirror: "http://private" }, { authorization: "private" }]) {
    const f = ownerFixture();
    assert.equal((await f.operation.handler(f.input(params))).status, 400);
    assert.equal(f.calls.length, 0);
  }
});
