import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as access from "./webguiLanAccess.js";

// Run the production ingress callback without starting a Manager or changing global state.
const source = fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("controlPlaneRoutes.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "webguiLanRequestAllowed");
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(ast) + "\nglobalThis.allowed=webguiLanRequestAllowed;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function fixture() {
  let enumerations = 0, token = "synthetic-access-token";
  const context = vm.createContext({ ...access, managerHost: "0.0.0.0",
    localIpv4AddressEntries: () => { enumerations++; return [{ address: "192.0.2.5" }]; },
    remoteRequestUsesIndependentAuthorization: () => false,
    rabiGlobalConfig: { read: () => ({ webguiLan: { enabled: true, accessToken: token } }) }
  });
  vm.runInContext(code, context);
  return { request(remoteAddress: string, localAddress: string, path = "/api/roles", credential?: string) {
    const request = { method: "GET", headers: credential ? { "x-rabiroute-webgui-token": credential } : {},
      socket: { remoteAddress, localAddress } } as unknown as http.IncomingMessage;
    return context.allowed(request, new URL(path, "http://fixture.invalid")) as boolean;
  }, scans: () => enumerations, revoke: () => { token = "changed-synthetic-token"; } };
}

test("local socket identity, loopback, static files and current credentials avoid synchronous interface enumeration", () => {
  const f = fixture();
  assert.equal(f.request("::ffff:192.0.2.5", "192.0.2.5"), true);
  assert.equal(f.request("127.0.0.1", "127.0.0.1"), true);
  assert.equal(f.request("192.0.2.9", "192.0.2.5", "/assets/main.js"), true);
  assert.equal(f.request("192.0.2.9", "192.0.2.5", "/api/roles", "synthetic-access-token"), true);
  assert.equal(f.scans(), 0);
});

test("revocation is rechecked and interface fallback retains its existing local-machine behavior", () => {
  const f = fixture();
  assert.equal(f.request("192.0.2.9", "192.0.2.5", "/api/roles", "synthetic-access-token"), true);
  f.revoke();
  assert.equal(f.request("192.0.2.9", "192.0.2.5", "/api/roles", "synthetic-access-token"), false);
  assert.equal(f.request("192.0.2.5", "192.0.2.6"), true);
  assert.equal(f.request("192.0.2.9", "192.0.2.5"), false);
  assert.equal(f.scans(), 3);
});

function connectionGuard(kind: "agent" | "unrelated", revoked = false, webAllowed = false) {
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "markAuthenticatedConnectionRequest") {
      const candidate = node.arguments[1];
      if (candidate && ts.isArrowFunction(candidate) && candidate.getText(ast).includes("Authenticated Manager connection was revoked.")) callback = candidate;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  let webChecks = 0, agentChecks = 0;
  const context = vm.createContext({ lanAgentAccess: { kind }, request: {}, requestUrl: {}, admittedRabiLink: false,
    assertTrustedLanAgentPrincipal: () => { agentChecks++; if (revoked) throw new Error("revoked agent"); },
    webguiLanRequestAllowed: () => { webChecks++; return webAllowed; }
  });
  const guard = vm.runInContext(`(${callback.getText(ast)})`, context) as () => void;
  return { guard, counts: () => ({ webChecks, agentChecks }) };
}

test("an authenticated Agent revalidates its lease without probing WebGUI network interfaces", () => {
  const f = connectionGuard("agent");
  for (let index = 0; index < 20; index++) f.guard();
  assert.deepEqual(f.counts(), { webChecks: 0, agentChecks: 20 });
  assert.throws(connectionGuard("agent", true).guard, /revoked agent/);
});

test("browser connection revalidation still rejects a revoked credential", () => {
  assert.throws(connectionGuard("unrelated").guard, /connection was revoked/);
  const f = connectionGuard("unrelated", false, true);
  f.guard();
  assert.deepEqual(f.counts(), { webChecks: 1, agentChecks: 0 });
});
