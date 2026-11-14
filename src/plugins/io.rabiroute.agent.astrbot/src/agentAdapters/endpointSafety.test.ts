import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { testAstrbotLogin, scanAstrbotAgentAdapter } from "./astrbotManagerApi.js";
import { notifyAstrbot } from "./astrbotAdapter.js";
import { requireAstrbotUrl } from "./astrbotEndpoint.js";

function environment(t: test.TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test("AstrBot without an endpoint does not probe, authenticate or deliver", async t => {
  environment(t, { ASTRBOT_URL: undefined, ASTRBOT_PASSWORD: "test-only-password", ASTRBOT_SESSION_ID: "fixture", GATEWAY_MANAGER_URL: undefined });
  t.mock.method(console, "error", () => undefined);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network request is allowed"); });
  await assert.rejects(notifyAstrbot("fixture"), /ASTRBOT_URL is required/);
  assert.equal((await testAstrbotLogin({ password: "test-only-password" })).status, 400);
  const result = await scanAstrbotAgentAdapter({ rootDir: process.cwd(), checkHttpEndpoint: async () => { throw new Error("No guessed probe"); } });
  assert.deepEqual(result.agents.astrbot.endpoints, []);
  assert.match(result.agents.astrbot.auth.message ?? "", /未配置/);
});

test("AstrBot never borrows environment credentials for another explicit target", async t => {
  environment(t, { ASTRBOT_URL: "http://127.0.0.1:49101", ASTRBOT_USERNAME: "fixture-environment", ASTRBOT_PASSWORD: "fixture-environment-password" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("No credentials should be sent"); });
  const result = await testAstrbotLogin({ url: "http://127.0.0.1:49102" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(requests, 0);
});

test("AstrBot multi-target scan retains each URL and does not select an account", async t => {
  environment(t, { ASTRBOT_URL: undefined, ASTRBOT_PASSWORD: undefined, ASTRBOT_USERNAME: undefined });
  const probes: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Ambiguous accounts must not log in"); });
  const result = await scanAstrbotAgentAdapter({ rootDir: process.cwd(), runtimes: [
    { definition: { astrbotUrl: "http://127.0.0.1:49103" } },
    { definition: { astrbotUrl: "http://127.0.0.1:49104", astrbotUsername: "fixture", astrbotPassword: "test-only-password" } }
  ], checkHttpEndpoint: async url => { probes.push(url); return true; } });
  assert.deepEqual(probes, ["http://127.0.0.1:49103", "http://127.0.0.1:49104"]);
  assert.equal(result.agents.astrbot.auth.loggedIn, false);
  assert.match(result.agents.astrbot.auth.message ?? "", /多个/);
});

test("AstrBot token cache stays with the captured URL and account", async t => {
  environment(t, { ASTRBOT_URL: "http://127.0.0.1:49105", ASTRBOT_USERNAME: "fixture-a", ASTRBOT_PASSWORD: "test-only-password", ASTRBOT_SESSION_ID: "fixture-session", GATEWAY_MANAGER_URL: undefined });
  t.mock.method(console, "log", () => undefined);
  const calls: Array<{ url: string; body: Record<string, string>; token: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = JSON.parse(String(init?.body));
    assert.equal(init?.redirect, "error");
    calls.push({ url, body, token: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/api/auth/login")) return Response.json({ data: { token: new URL(url).port + ":" + body.username } });
    return new Response('data: {"type":"plain","data":"fixture"}\n\n');
  });
  await notifyAstrbot("fixture-a");
  process.env.ASTRBOT_URL = "http://127.0.0.1:49106";
  await notifyAstrbot("fixture-b");
  process.env.ASTRBOT_USERNAME = "fixture-b";
  await notifyAstrbot("fixture-c");
  assert.equal(calls.filter(call => call.url.endsWith("/api/auth/login")).length, 3);
  assert.deepEqual(calls.filter(call => call.url.endsWith("/api/chat/send")).map(call => call.token), ["Bearer 49105:fixture-a", "Bearer 49106:fixture-a", "Bearer 49106:fixture-b"]);
});

test("AstrBot rejects invalid or zero-port endpoint configuration before credentials", () => {
  for (const url of ["", "http://127.0.0.1:0", "http://fixture:secret@127.0.0.1:49101", "file:///fixture", "http://127.0.0.1:49101/?key=fixture"]) assert.throws(() => requireAstrbotUrl(url));
  assert.equal(requireAstrbotUrl("https://explicit.example.invalid/base/"), "https://explicit.example.invalid/base");
});

test("AstrBot same endpoint with a different account does not inherit the environment password or auto-login", async t => {
  environment(t, { ASTRBOT_URL: "http://127.0.0.1:49151", ASTRBOT_USERNAME: "test-only-account-a", ASTRBOT_PASSWORD: "test-only-password-a" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Cross-account credentials must not be sent"); });
  const login = await testAstrbotLogin({ url: "http://127.0.0.1:49151", username: "test-only-account-b" });
  assert.equal(login.ok, false);
  assert.equal(login.status, 400);
  assert.match(String(login.message), /密码/);
  const scan = await scanAstrbotAgentAdapter({ rootDir: process.cwd(), runtimes: [
    { definition: { astrbotUrl: "http://127.0.0.1:49151", astrbotUsername: "test-only-account-b" } }
  ], checkHttpEndpoint: async () => true });
  assert.equal(scan.agents.astrbot.auth.loggedIn, false);
  assert.equal(requests, 0);
});

test("AstrBot keeps a successful remote empty-session catalog isolated from the unrelated local database", async t => {
  environment(t, { ASTRBOT_URL: undefined, ASTRBOT_USERNAME: undefined, ASTRBOT_PASSWORD: undefined });
  let localDatabaseChecks = 0;
  const originalExists = fs.existsSync;
  t.mock.method(fs, "existsSync", (target: fs.PathLike) => {
    if (/[\\/]\.astrbot[\\/]data[\\/]data_v4\.db$/.test(String(target))) {
      localDatabaseChecks++;
      return false; // No real local database is inspected by this fixture.
    }
    return originalExists(target);
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    assert.ok(url.startsWith("https://remote.example.invalid/"));
    requests.push(url);
    const data = url.endsWith("/api/auth/login") ? { token: "test-only-remote-token" }
      : url.endsWith("/api/chatui_project/list") ? [{ project_id: "remote-project", title: "test-only-remote-project" }]
      : [];
    return Response.json({ status: "ok", data });
  });
  const result = await scanAstrbotAgentAdapter({ rootDir: process.cwd(), runtimes: [
    { definition: { astrbotUrl: "https://remote.example.invalid", astrbotUsername: "test-only-remote-user", astrbotPassword: "test-only-remote-password" } }
  ], checkHttpEndpoint: async () => true });
  assert.equal(result.agents.astrbot.auth.loggedIn, true);
  assert.deepEqual(result.agents.astrbot.projects.map(project => project.id), ["remote-project"]);
  assert.deepEqual(result.agents.astrbot.sessions, []);
  assert.equal(localDatabaseChecks, 0, "An API catalog must not consult a database without the same native owner identity");
  assert.equal(requests.length, 4);
  assert.doesNotMatch(result.agents.astrbot.warnings.join(" "), /本机 AstrBot 数据库/);
});
