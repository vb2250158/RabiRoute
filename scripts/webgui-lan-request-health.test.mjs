import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  isLocalMachineRemoteAddress,
  isLoopbackRemoteAddress,
  isPublicWebguiStaticRequest,
  isWebguiLanRequestAuthorized,
  managerListensOnLan,
  webguiTokenMatches
} from "../src/manager/webguiLanAccess.ts";

// Execute the actual request gate without starting the Manager and its adapters.
const filename = new URL("../src/manager/controlPlaneRoutes.ts", import.meta.url);
const source = fs.readFileSync(filename, "utf8");
const parsed = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.ES2022, true);
const symbols = [
  "headerValue", "remoteAgentRequestToken", "isRemoteAgentRequestAuthorized",
  "remoteRequestUsesIndependentAuthorization", "webguiLanRequestAllowed"
];
const functions = symbols.map(symbol => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === symbol);
  assert.ok(declaration, `Missing request gate dependency: ${symbol}`);
  return declaration.getText(parsed);
}).join("\n");
const javascript = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const createGate = new Function(
  "isLocalMachineRemoteAddress", "isLoopbackRemoteAddress", "isPublicWebguiStaticRequest",
  "isWebguiLanRequestAuthorized", "managerListensOnLan", "webguiTokenMatches",
  "managerHost", "rabiGlobalConfig", "remoteAgentToken", "localIpv4AddressEntries",
  `${javascript}\nreturn webguiLanRequestAllowed;`
);

function fixture({ host = "0.0.0.0", addresses = ["192.0.2.10"], enabled = true } = {}) {
  let enumerations = 0;
  const gate = createGate(
    isLocalMachineRemoteAddress, isLoopbackRemoteAddress, isPublicWebguiStaticRequest,
    isWebguiLanRequestAuthorized, managerListensOnLan, webguiTokenMatches,
    host, { read: () => ({ webguiLan: { enabled, accessToken: "fixture-webgui-token" } }) },
    "fixture-agent-token", () => {
      enumerations++;
      return addresses.map(address => ({ name: "fixture-interface", address }));
    }
  );
  return {
    allowed(remoteAddress, path = "/meta", headers = {}, method = "GET") {
      return gate({ socket: { remoteAddress }, headers, method }, new URL(path, "http://fixture.invalid"));
    },
    enumerations: () => enumerations
  };
}

test("the existing loopback address set bypasses synchronous interface enumeration", () => {
  const local = fixture();
  for (const address of ["127.0.0.1", "127.22.3.4", "::1", "::ffff:127.0.0.1", "localhost", " LOCALHOST "]) {
    assert.equal(isLocalMachineRemoteAddress(address, []), true, address);
    assert.equal(local.allowed(address), true, address);
  }
  assert.equal(local.enumerations(), 0);
});

test("the loopback short circuit does not expand the existing address predicate", () => {
  const remote = fixture();
  for (const address of ["[::1]", "128.0.0.1", "192.0.2.11", "", undefined]) {
    assert.equal(isLocalMachineRemoteAddress(address, []), false, String(address));
    assert.equal(remote.allowed(address), false, String(address));
  }
  assert.equal(remote.enumerations(), 5);
});

test("the Manager's own LAN interfaces still allow requests after one enumeration", () => {
  const local = fixture();
  assert.equal(local.allowed("192.0.2.10"), true);
  assert.equal(local.allowed("::ffff:192.0.2.10"), true);
  assert.equal(local.enumerations(), 2);
});

test("a loopback-only listener retains its existing gate behavior without enumeration", () => {
  const local = fixture({ host: "127.0.0.1" });
  assert.equal(local.allowed("192.0.2.11"), true);
  assert.equal(local.enumerations(), 0);
});

test("authenticated remote Agent requests retain independent authorization", () => {
  const remote = fixture();
  assert.equal(remote.allowed("192.0.2.11", "/api/remote-agent/threads", { "x-remote-agent-token": "fixture-agent-token" }), true);
  assert.equal(remote.allowed("192.0.2.11", "/api/remote-agent/threads", { authorization: "Bearer fixture-agent-token" }), true);
  assert.equal(remote.allowed("192.0.2.11", "/api/remote-agent/threads?token=fixture-agent-token"), true);
  assert.equal(remote.allowed("192.0.2.11", "/api/remote-agent/threads", { "x-remote-agent-token": "incorrect" }), false);
  assert.equal(remote.allowed("192.0.2.11", "/meta", { "x-remote-agent-token": "fixture-agent-token" }), false);
  assert.equal(remote.enumerations(), 5);
});

test("remote WebGUI and LAN Agent authentication retain their existing results", () => {
  const remote = fixture();
  assert.equal(remote.allowed("192.0.2.11", "/meta", { "x-rabiroute-webgui-token": "fixture-webgui-token" }), true);
  assert.equal(remote.allowed("192.0.2.11", "/meta?webgui_token=fixture-webgui-token"), true);
  assert.equal(remote.allowed("192.0.2.11", "/api/lan-agent/state", { authorization: ["Bearer fixture-webgui-token"] }), true);
  assert.equal(remote.allowed("192.0.2.11", "/api/lan-agent/state", { authorization: "Bearer incorrect" }), false);
  assert.equal(remote.allowed("192.0.2.11", "/meta", { "x-rabiroute-webgui-token": "incorrect" }), false);
  assert.equal(remote.enumerations(), 5);
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.allowed("192.0.2.11", "/api/lan-agent/state", { authorization: "Bearer fixture-webgui-token" }), false);
  assert.equal(disabled.enumerations(), 1);
});

test("public static requests retain their existing method and path rules", () => {
  const remote = fixture();
  assert.equal(remote.allowed("192.0.2.11", "/assets/app.js"), true);
  assert.equal(remote.allowed("192.0.2.11", "/reports/result.html", {}, "HEAD"), true);
  assert.equal(remote.allowed("192.0.2.11", "/assets/app.js", {}, "POST"), false);
  assert.equal(remote.enumerations(), 3);
});
