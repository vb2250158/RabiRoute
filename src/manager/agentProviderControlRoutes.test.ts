import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAstrbotControlOperations, createCopilotControlOperations, type CopilotControlOperationsContext, type CopilotLoginResult } from "./agentProviderControlRoutes.js";
import { testAstrbotLogin } from "../agentAdapters/managerApi.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext, overrides: Partial<CopilotControlOperationsContext> = {}, astrbot = testAstrbotLogin) {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-operations-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "provider-node");
  const events: unknown[] = [], calls: string[] = []; let loginResult: CopilotLoginResult = { kind: "completed" };
  const context: CopilotControlOperationsContext = { installCopilot: async () => { calls.push("install"); return { stdout: " installed \n", stderr: " detail \n" }; },
    startCopilotLogin: async ({ onExit }) => { calls.push("login"); if (loginResult.kind === "completed") onExit({ done: true, exitCode: 0, error: "" }); return loginResult; },
    getCopilotStatus: async () => ({ installed: true, binPath: "fixture-copilot", loggedIn: false, copilotHome: "fixture-home" }),
    publishEvent: (eventType, data) => { events.push({ eventType, data }); }, ...overrides };
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("providers", [...createCopilotControlOperations(context), ...createAstrbotControlOperations(astrbot)]);
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const begin = (endpoint: string, signal?: AbortSignal) => {
    let request!: http.ClientRequest;
    const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request = http.request(base + "/api/agent/" + endpoint + "?ignored=yes", { method: endpoint === "copilot-status" ? "GET" : "POST", signal,
      headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on("error", reject); request.setTimeout(12000, () => request.destroy(new Error("Owned provider HTTP fixture timeout.")));
  });
    return { request, result };
  };
  const send = (endpoint: string, body?: unknown, signal?: AbortSignal) => { const pending = begin(endpoint, signal); pending.request.end(body === undefined ? undefined : JSON.stringify(body)); return pending.result; };
  return { registration, send, begin, events, calls, result: (value: CopilotLoginResult) => { loginResult = value; }, disable: () => authority.setNodeEnabled(credential.nodeId, false, true) };
}

test("unbound authenticated node reaches original install/login/status operations and native DTOs", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.send("copilot-install"), { status: 200, body: { ok: true, stdout: "installed", stderr: "detail" } });
  assert.deepEqual(await f.send("copilot-status"), { status: 200, body: { installed: true, binPath: "fixture-copilot", loggedIn: false, copilotHome: "fixture-home" } });
  assert.deepEqual(await f.send("copilot-login"), { status: 200, body: { ok: true, done: true } });
  assert.equal(f.events.length, 1); assert.deepEqual(f.calls, ["install", "login"]);
  f.result({ kind: "device-code", code: "ABCD-EFGH", url: null, pid: 123 });
  assert.deepEqual(await f.send("copilot-login"), { status: 200, body: { ok: true, code: "ABCD-EFGH", url: null, pid: 123 } });
  f.result({ kind: "timeout" }); assert.equal((await f.send("copilot-login")).status, 408);
  f.result({ kind: "failed", error: "controlled login failure" }); assert.equal((await f.send("copilot-login")).status, 500);
});

test("native owner rejections retain install error details and status/login errors", async t => {
  const f = await fixture(t, { installCopilot: async () => { throw Object.assign(new Error("controlled install failure"), { stderr: "controlled stderr" }); },
    startCopilotLogin: async () => { throw new Error("controlled login failure"); }, getCopilotStatus: async () => { throw new Error("controlled status failure"); } });
  assert.deepEqual(await f.send("copilot-install"), { status: 500, body: { ok: false, error: "controlled install failure", stderr: "controlled stderr" } });
  assert.equal((await f.send("copilot-login")).status, 500); assert.equal((await f.send("copilot-status")).status, 500);
});

test("Copilot install and login preserve ignored POST JSON object bodies", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("copilot-install", {})).status, 200);
  assert.equal((await f.send("copilot-login", {})).status, 200);
  assert.deepEqual(f.calls, ["install", "login"]);
});

test("Copilot install and login preserve ignored non-JSON request bytes", async t => {
  const f = await fixture(t);
  for (const endpoint of ["copilot-install", "copilot-login"]) {
    const pending = f.begin(endpoint); pending.request.end("not JSON: { incomplete"); assert.equal((await pending.result).status, 200);
  }
  assert.deepEqual(f.calls, ["install", "login"]);
});

test("Copilot native owner executes without waiting for an ignored body to end", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const endpoint of ["copilot-install", "copilot-login"]) {
    const pending = f.begin(endpoint); t.after(() => pending.request.destroy()); pending.request.write("unterminated body");
    assert.equal((await pending.result).status, 200); assert.equal(pending.request.writableFinished, false); pending.request.end();
  }
  assert.deepEqual(f.calls, ["install", "login"]);
});

test("original connection revocation suppresses an accepted install result", async t => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { installCopilot: async () => { entered(); await gate; return {}; } });
  const pending = f.send("copilot-install"); await started; f.disable(); release(); assert.equal((await pending).status, 403);
});

test("retirement joins an accepted provider operation after HTTP disconnect", async t => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { installCopilot: async () => { entered(); await gate; return {}; } });
  const controller = new AbortController(), pending = f.send("copilot-install", undefined, controller.signal).catch(() => undefined); await started; controller.abort(); await pending;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  release(); await retirement;
});

test("AstrBot native owner verifies only the owned local fixture and keeps its transient token out of response", async t => {
  const paths: string[] = [];
  const dashboard = http.createServer((request, response) => {
    paths.push(request.url!); request.resume(); response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") response.end(JSON.stringify({ status: "ok", data: { token: "public-fixture-token" } }));
    else response.end(JSON.stringify({ status: "ok", data: [] }));
  });
  t.after(async () => { dashboard.closeAllConnections(); await new Promise<void>(resolve => dashboard.close(() => resolve())); });
  await new Promise<void>(resolve => dashboard.listen(0, "127.0.0.1", resolve));
  const f = await fixture(t), url = `http://127.0.0.1:${(dashboard.address() as import("node:net").AddressInfo).port}`;
  const result = await f.send("astrbot-login-test", { url, username: "fixture-user", password: "public-fixture-password" /* Public test-only fixture; not a real credential. */ });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.status, 200);
  assert.ok(!JSON.stringify(result).includes("public-fixture-token"));
  assert.deepEqual(paths, ["/api/auth/login", "/api/chatui_project/list", "/api/chat/sessions?platform_id=webchat"]);
});

test("AstrBot field type validation rejects before native login and failed native result remains 400", async t => {
  let calls = 0;
  const f = await fixture(t, {}, async () => { calls++; return { ok: false, status: 401, message: "Controlled fixture rejected login." }; });
  assert.equal((await f.send("astrbot-login-test", { password: 3 })).status, 400); assert.equal(calls, 0);
  assert.deepEqual(await f.send("astrbot-login-test", { password: null }), { status: 400, body: { ok: false, status: 401, message: "Controlled fixture rejected login." } }); assert.equal(calls, 1);
});
