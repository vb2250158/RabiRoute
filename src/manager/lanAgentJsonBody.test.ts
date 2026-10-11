import assert from "node:assert/strict";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import ts from "typescript";
import test from "node:test";

// Exercise the actual reader without importing the Manager startup/lifecycle module.
const source = fs.readFileSync(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
const reader = source.slice(source.indexOf("function readJsonBody<T>"), source.indexOf("function singleRequestHeader"));
const javascript = ts.transpileModule(reader, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("local and remote JSON bodies share endpoint limits without a remote-only ceiling", async () => {
  for (const remote of [false, true]) {
    let validations = 0;
    const read = vm.runInNewContext(`${javascript}; readJsonBody`, {
      Buffer, hasLanAgentBodyGuard: () => remote,
      validateLanAgentRequestBody: () => { validations++; }
    }) as (request: PassThrough, maxBytes?: number) => Promise<{ text: string }>;
    const body = { text: "x".repeat(1024 * 1024 + 1) };
    const request = new PassThrough();
    const result = read(request);
    request.end(JSON.stringify(body));
    assert.deepEqual((await result).text, body.text);
    assert.equal(validations, 1);
    const bounded = new PassThrough();
    const failure = read(bounded, 16);
    bounded.end(JSON.stringify(body));
    await assert.rejects(failure, /Request body exceeds 16 bytes/);
    assert.equal(validations, 1);
  }
});

test("authenticated Agent uses the existing connection while unrelated requests still authenticate", () => {
  const gate = source.indexOf("const managementAccessAllowed");
  assert.ok(gate > 0);
  const section = source.slice(gate, source.indexOf("if (managerReadOnly", gate));
  assert.match(section, /lanAgentAccess.kind === "agent"/);
  assert.doesNotMatch(section, /requiresManagementAuth/);
  assert.match(section, /if \(!managementAccessAllowed\)/);
  assert.match(section, /WEBGUI_TOKEN_REQUIRED/);
});

test("the actual JSON response boundary revalidates authority and suppresses sensitive output after revocation", () => {
  const responder = source.slice(source.indexOf("function jsonResponse("), source.indexOf("function readJsonBody<T>"));
  const compiled = ts.transpileModule(responder, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let revoked = false;
  const context = { pathname: () => "/api/settings", startedAt: Date.now(),
    assertResponseAuthority: () => { if (revoked) throw new Error("fixture revoked"); } };
  const json = vm.runInNewContext(`${compiled}; jsonResponse`, {
    managerRequestContexts: { get: () => context },
    errorResponsePresentation: (body: unknown) => body,
    managerOperationalLog: { record: () => undefined },
    managerOperationalError: () => ({}), rootDir: ".", Buffer,
    PERFORMANCE_OPERATIONS: { managerHttpJsonSerialize: "fixture" },
    measureSyncPerformanceOperation: (_name: string, work: () => string) => work()
  }) as (response: unknown, status: number, body: unknown) => void;
  const statuses: number[] = [];
  const bodies: string[] = [];
  const headers: Record<string, string> = {};
  const response = { writeHead: (status: number) => statuses.push(status), end: (text: string) => bodies.push(text),
    setHeader: (key: string, value: string) => { headers[key] = value; } };
  json(response, 200, { secret: "fixture-sensitive" });
  revoked = true;
  json(response, 200, { secret: "fixture-sensitive" });
  assert.deepEqual(statuses, [200, 403]);
  assert.match(bodies[0], /fixture-sensitive/);
  assert.doesNotMatch(bodies[1], /fixture-sensitive/);
  assert.equal(JSON.parse(bodies[1]).error, "LAN_AGENT_AUTHORIZATION_REVOKED");
  assert.equal(JSON.parse(bodies[1]).uncertain, true);
  assert.equal(headers["cache-control"], "no-store");
});

test("the actual public management gate accepts authenticated Agents without a second admin token", () => {
  const gate = source.indexOf("const managementAccessAllowed");
  const section = source.slice(gate, source.indexOf("if (!managementAccessAllowed)", gate));
  const compiled = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const request = {};
  let valid = true;
  let browserAllowed = false;
  let browserChecks = 0;
  const context = { request, requestUrl: new URL("http://manager.invalid/api/unknown-business"), enrollmentAccess: false,
    lanAgentAccess: { kind: "agent" }, assertTrustedLanAgentPrincipal: (input: unknown) => {
      assert.equal(input, request); if (!valid) throw new Error("fixture revoked"); return { agentId: "fixture" };
    }, webguiLanRequestAllowed: () => { browserChecks++; return browserAllowed; } };
  const allowed = () => vm.runInNewContext(`(() => { ${compiled}; return managementAccessAllowed; })()`, context);
  assert.equal(allowed(), true);
  assert.equal(browserChecks, 0);
  valid = false;
  assert.throws(allowed, /fixture revoked/);
  assert.equal(browserChecks, 0);
  context.lanAgentAccess = { kind: "unrelated" };
  assert.equal(allowed(), false);
  browserAllowed = true;
  assert.equal(allowed(), true);
});
