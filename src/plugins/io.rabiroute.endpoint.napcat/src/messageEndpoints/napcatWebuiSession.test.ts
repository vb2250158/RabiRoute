import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { NapcatWebuiSessions } from "./napcatWebuiSession.js";

async function serverFor(t: test.TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD" && request.url === "/__fixture_ready") response.writeHead(204).end();
    else handler(request, response);
  });
  t.after(() => { server.closeAllConnections(); if (server.listening) return new Promise<void>(resolve => server.close(() => resolve())); });
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(base + "/__fixture_ready", { method: "HEAD", signal: AbortSignal.timeout(1000) });
      return base;
    } catch (error) {
      if (!(error instanceof TypeError && error.cause instanceof Error && error.cause.message === "bad port")) throw error;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  throw new Error("No Fetch-compatible test listener was assigned after 16 attempts");
}

test("parallel panels and repeated status reads reuse one authentication request under login rate limiting", async t => {
  let logins = 0;
  let reads = 0;
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") {
      logins++;
      response.statusCode = logins > 1 ? 429 : 200;
      response.end(JSON.stringify(logins > 1 ? { code: -1 } : { code: 0, data: { Credential: "test-credential" } }));
    } else { reads++; response.end(JSON.stringify({ code: 0, data: { isLogin: true } })); }
  });
  const sessions = new NapcatWebuiSessions();
  const panels = await Promise.all(Array.from({ length: 12 }, () => sessions.open(base, "test-token")));
  for (const panel of panels) {
    assert.ok(panel);
    assert.equal((await (await panel.request("/api/QQLogin/CheckLoginStatus")).json()).data.isLogin, true);
  }
  assert.equal(logins, 1);
  assert.equal(reads, 12);
  assert.equal(JSON.stringify(panels).includes("test-credential"), false);
});

test("expired server credentials refresh once for concurrent requests without replaying accepted actions", async t => {
  let logins = 0;
  let accepted = 0;
  let requiredCredential = "credential-1";
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") {
      logins++;
      response.end(JSON.stringify({ code: 0, data: { Credential: `credential-${logins}` } }));
    } else if (request.headers.authorization !== `Bearer ${requiredCredential}`) {
      response.statusCode = 401; response.end(JSON.stringify({ code: -1, message: "Unauthorized" }));
    } else {
      accepted++;
      response.end(JSON.stringify({ code: -1, message: "ordinary action failure" }));
    }
  });
  const sessions = new NapcatWebuiSessions();
  const panel = await sessions.open(base, "test-token");
  assert.ok(panel);
  requiredCredential = "credential-2";
  await Promise.all(Array.from({ length: 3 }, () => panel.request("/api/QQLogin/SetQuickLogin", { uin: "10000" })));
  assert.equal(logins, 2);
  assert.equal(accepted, 3);
  await sessions.open(base, "rotated-test-token");
  assert.equal(logins, 3);
});

test("fixed GET reads share the original credential and streams return before completion", async t => {
  let logins = 0;
  const calls: Array<{ method?: string; path?: string; authorization?: string }> = [];
  const base = await serverFor(t, (request, response) => {
    if (request.url === "/api/auth/login") {
      logins++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 0, data: { Credential: "fixture-credential" } })); return;
    }
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    if (request.url === "/api/Log/GetLogRealTime") {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: fixture\n\n");
    } else if (request.url === "/api/Plugin/Icon/fixture") {
      response.writeHead(200, { "content-type": "image/png" }); response.write("fixture");
    } else {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 0, data: { version: "fixture" } }));
    }
  });
  const panel = await new NapcatWebuiSessions().open(base, "example-token"); assert.ok(panel);
  for (const path of ["/api/base/GetNapCatVersion", "/api/Log/GetLogRealTime", "/api/Plugin/Icon/fixture"]) {
    const controller = new AbortController();
    const response = await panel.requestFixed("GET", path, controller.signal);
    assert.equal(response.status, 200);
    await response.body?.cancel(); controller.abort();
  }
  assert.equal(logins, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === "GET" && call.authorization === "Bearer fixture-credential"));
});

test("fixed request rejects arbitrary targets, secret queries and host paths before dispatch", async t => {
  let actions = 0;
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url !== "/api/auth/login") actions++;
    response.end(JSON.stringify({ code: 0, data: { Credential: "fixture" } }));
  });
  const panel = await new NapcatWebuiSessions().open(base, "fixture"); assert.ok(panel);
  for (const path of ["http://other/api/test", "//other/api/test", "/api/base/proxy?url=http://private", "/api/Debug/call",
    "/api/base/GetNapCatVersion?webui_token=private", "/api/Log/GetLog?id=C%3A%5Csecret", "/api/Log/GetLog?id=..%2Fsecret",
    "/api/Plugin/page/fixture/..%2Fsecret", "/api/Plugin/Store/List?url=http://private", "/api/unregistered"]) {
    await assert.rejects(async () => panel.requestFixed("GET", path, AbortSignal.timeout(1000)), /FIXED_REQUEST_INVALID/);
  }
  await assert.rejects(async () => panel.requestFixed("POST", "/api/base/GetNapCatVersion", AbortSignal.timeout(1000)), /FIXED_REQUEST_INVALID/);
  assert.equal(actions, 0);
});

test("JSON authentication rejections refresh while ordinary credential errors retain a single execution", async t => {
  let logins = 0, executed = 0;
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") { logins++; response.end(JSON.stringify({ code: 0, data: { Credential: `fixture-${logins}` } })); }
    else if (request.headers.authorization === "Bearer fixture-1") response.end(JSON.stringify({ code: -1, message: "Unauthorized" }));
    else { executed++; response.end(JSON.stringify({ code: -1, message: "credential operation expired after execution" })); }
  });
  const panel = await new NapcatWebuiSessions().open(base, "fixture"); assert.ok(panel);
  const result = await panel.request("/api/QQLogin/SetQuickLogin", { uin: "fixture" });
  assert.equal((await result.json()).message, "credential operation expired after execution");
  assert.equal(logins, 2); assert.equal(executed, 1);
});

test("credential requests reject redirects and unsafe base URLs", async t => {
  let redirected = 0;
  const base = await serverFor(t, (request, response) => {
    if (request.url === "/api/auth/login") response.writeHead(302, { location: "/captured" }).end();
    else { redirected++; response.end(); }
  });
  const sessions = new NapcatWebuiSessions();
  await assert.rejects(() => sessions.open(base, "fixture"));
  assert.equal(redirected, 0);
  for (const url of [base + "/webui", base + "?token=private", "http://user:private@localhost", "file:///tmp/fixture"]) {
    await assert.rejects(() => sessions.open(url, "fixture"), /BASE_URL_INVALID/);
  }
});

test("bounded JSON peeking enforces the existing quota and cancellation retains valid cached auth", async t => {
  let logins = 0;
  const base = await serverFor(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") { logins++; response.end(JSON.stringify({ code: 0, data: { Credential: "fixture" } })); }
    else if (request.url === "/api/base/GetNapCatVersion") response.end(JSON.stringify({ code: 0, data: "x".repeat(1000) }));
    else response.end(JSON.stringify({ code: 0, data: true }));
  });
  const panel = await new NapcatWebuiSessions().open(base, "fixture"); assert.ok(panel);
  const previous = process.env.RABIROUTE_QQ_JSON_MAX_BYTES;
  process.env.RABIROUTE_QQ_JSON_MAX_BYTES = "200";
  try { await assert.rejects(() => panel.requestFixed("GET", "/api/base/GetNapCatVersion", AbortSignal.timeout(1000)), /QQ_RESPONSE_TOO_LARGE/); }
  finally { if (previous === undefined) delete process.env.RABIROUTE_QQ_JSON_MAX_BYTES; else process.env.RABIROUTE_QQ_JSON_MAX_BYTES = previous; }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => panel.requestFixed("POST", "/api/test", controller.signal));
  await panel.requestFixed("POST", "/api/test", AbortSignal.timeout(1000));
  assert.equal(logins, 1);
});
