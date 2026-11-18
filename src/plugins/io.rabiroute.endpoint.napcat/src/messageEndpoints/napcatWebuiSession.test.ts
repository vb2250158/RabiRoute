import assert from "node:assert/strict";
import http from "node:http";
import {createHash} from "node:crypto";
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

test("extended typed GET encodes only declared query fields under original credential and reverse-proxy prefix", async t => {
  const seen: string[] = [];
  const base = await serverFor(t, (request, response) => {
    seen.push(request.url!);response.setHeader("content-type", "application/json");
    if(request.url === "/prefix/api/auth/login")response.end(JSON.stringify({code:0,data:{Credential:"PRIVATE_FIXTURE"}}));
    else {assert.equal(request.headers.authorization,"Bearer PRIVATE_FIXTURE");response.end(JSON.stringify({code:0,data:{versions:[],pagination:{page:1,pageSize:20,total:0,totalPages:0}}}));}
  });
  const session=await new NapcatWebuiSessions().open(base+"/prefix","PRIVATE_FIXTURE_TOKEN");assert.ok(session);
  await session.requestManagement("GET","/api/base/getAllReleases",{page:1,search:"a & b"},AbortSignal.timeout(1000));
  assert.equal(seen[1],"/prefix/api/base/getAllReleases?page=1&search=a+%26+b");
  assert.throws(()=>session.requestManagement("GET","/api/base/getAllReleases",{url:"https://outside.example"},AbortSignal.timeout(1000)));
  assert.throws(()=>session.requestManagement("GET","/api/base/getAllReleases?search=x",{},AbortSignal.timeout(1000)));
  assert.equal(seen.length,2);
});

test("session auth owners retain credentials internally, reuse login and invalidate only the logged-out credential",async t=>{
 let logins=0;const paths:string[]=[];
 const base=await serverFor(t,(request,response)=>{paths.push(request.url!);response.setHeader("content-type","application/json");if(request.url==="/api/auth/login"){logins++;response.end(JSON.stringify({code:0,data:{Credential:"PRIVATE_FIXTURE_CREDENTIAL_"+logins}}));}else response.end(JSON.stringify({code:0,data:null}));});
 const sessions=new NapcatWebuiSessions(),session=await sessions.open(base,"PRIVATE_FIXTURE_TOKEN");assert.ok(session);
 const login=await session.requestManagement("POST","/api/auth/login",{},AbortSignal.timeout(1000));assert.deepEqual(await login.json(),{code:0,data:{authenticated:true}});assert.equal(logins,1);
 const check=await session.requestManagement("POST","/api/auth/check",{},AbortSignal.timeout(1000));assert.deepEqual(await check.json(),{code:0,data:{authenticated:true}});
 const logout=await session.requestManagement("POST","/api/auth/logout",{},AbortSignal.timeout(1000));assert.deepEqual(await logout.json(),{code:0,data:{authenticated:false}});assert.equal(logins,1);
 await sessions.open(base,"PRIVATE_FIXTURE_TOKEN");assert.equal(logins,2);assert(paths.includes("/api/auth/logout"));
 assert.throws(()=>session.requestManagement("POST","/api/auth/login",{hash:"PRIVATE_FIXTURE"},AbortSignal.timeout(1000)));
});

test("native passkey Credential is consumed only by the original session cache and token rotation injects the original secret privately",async t=>{
 let auth=0,expected="ORIGINAL_TOKEN_123",rotations=0;const assertions:Record<string,unknown>[]=[];
 const base=await serverFor(t,(request,response)=>{response.setHeader("content-type","application/json");let text="";request.on("data",b=>text+=b);request.on("end",()=>{const body=JSON.parse(text||"{}");if(request.url==="/api/auth/login"){auth++;assert.equal(body.hash,createHash("sha256").update(expected+".napcat").digest("hex"));response.end(JSON.stringify({code:0,data:{Credential:"PRIVATE_SESSION_"+auth}}));}
 else if(request.url==="/api/auth/passkey/verify-authentication"){assertions.push(body);response.end(JSON.stringify({code:0,data:{Credential:"PRIVATE_PASSKEY_SESSION"}}));}
 else if(request.url==="/api/auth/update_token"){rotations++;assert.equal(body.oldToken,expected);expected=body.newToken;response.end(JSON.stringify({code:0,data:"Token updated"}));}
 else{assert.equal(request.headers.authorization,"Bearer PRIVATE_PASSKEY_SESSION");response.end(JSON.stringify({code:0,data:null}));}});});
 const session=await new NapcatWebuiSessions().open(base,expected);assert.ok(session);const native=await session.requestManagement("POST","/api/auth/passkey/verify-authentication",{response:{id:"id",rawId:"YQ",type:"public-key",response:{clientDataJSON:"YQ",signature:"YQ",authenticatorData:"YQ"}}},AbortSignal.timeout(1000));assert.deepEqual(await native.json(),{code:0,data:{authenticated:true}});assert.equal(assertions.length,1);await session.requestManagement("POST","/api/auth/check",{},AbortSignal.timeout(1000));
 const rotated=await session.requestManagement("POST","/api/auth/update_token",{newToken:"REPLACED_TOKEN_456"},AbortSignal.timeout(1000));assert.deepEqual(await rotated.json(),{code:0,data:{changed:true}});assert.equal(rotations,1);assert.equal(auth,2);
 assert.throws(()=>session.requestManagement("POST","/api/auth/update_token",{oldToken:"guess",newToken:"VALID_TOKEN_123"},AbortSignal.timeout(1000)));
});

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
  for (const url of [base + "#fragment", base + "?token=private", "http://user:private@localhost", "file:///tmp/fixture"]) {
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

test("reverse-proxy prefixes retain original authentication, reads, legacy actions and management writes", async t => {
  const calls: Array<{ path: string; authorization?: string; body: unknown }> = [];
  const base = await serverFor(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const pathname = request.url!;
    calls.push({ path: pathname, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (pathname.endsWith("/api/auth/login")) response.end(JSON.stringify({ code: 0, data: { Credential: `fixture-${pathname.split("/api/")[0]}` } }));
    else response.end(JSON.stringify({ code: 0, data: true }));
  });
  const sessions = new NapcatWebuiSessions();
  const first = await sessions.open(base + "/tenant-a/napcat///", "fixture");
  assert.ok(first);
  assert.equal(first.baseUrl, base + "/tenant-a/napcat");
  const signal = AbortSignal.timeout(2000);
  await first.requestFixed("GET", "/api/base/GetNapCatVersion", signal);
  await first.request("/api/QQLogin/CheckLoginStatus");
  await first.requestManagement("POST", "/api/QQLogin/SetQuickLoginQQ", { uin: "" }, signal);
  const repeated = await sessions.open(base + "/tenant-a/napcat", "fixture");
  assert.ok(repeated);
  const second = await sessions.open(base + "/tenant-b/napcat", "fixture");
  assert.ok(second);
  await second.requestFixed("GET", "/api/base/GetNapCatVersion", signal);
  assert.equal(calls.filter(item => item.path.endsWith("/api/auth/login")).length, 2);
  assert.deepEqual(calls.map(item => item.path), ["/tenant-a/napcat/api/auth/login", "/tenant-a/napcat/api/base/GetNapCatVersion",
    "/tenant-a/napcat/api/QQLogin/CheckLoginStatus", "/tenant-a/napcat/api/QQLogin/SetQuickLoginQQ", "/tenant-b/napcat/api/auth/login", "/tenant-b/napcat/api/base/GetNapCatVersion"]);
  assert.equal(calls[3]!.authorization, "Bearer fixture-/tenant-a/napcat");
  assert.deepEqual(calls[3]!.body, { uin: "" });
  assert.equal(calls[5]!.authorization, "Bearer fixture-/tenant-b/napcat");
  const count = calls.length;
  for (const pathname of ["/api/../outside", "/api/%2e%2e/outside", "/api/%2f..%2foutside", "/api/QQLogin/CheckLoginStatus#fragment", "//outside/api/test"]) {
    await assert.rejects(() => first.request(pathname));
  }
  assert.equal(calls.length, count);
});

test("authentication JSON is bounded by the original QQ JSON budget", async t => {
  let logins = 0;
  const base = await serverFor(t, (_request, response) => {
    logins++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 0, data: { Credential: "fixture", padding: "x".repeat(1000) } }));
  });
  const sessions = new NapcatWebuiSessions();
  const previous = process.env.RABIROUTE_QQ_JSON_MAX_BYTES;
  process.env.RABIROUTE_QQ_JSON_MAX_BYTES = "200";
  try { await assert.rejects(() => sessions.open(base + "/napcat", "fixture"), /QQ_RESPONSE_TOO_LARGE/); }
  finally { if (previous === undefined) delete process.env.RABIROUTE_QQ_JSON_MAX_BYTES; else process.env.RABIROUTE_QQ_JSON_MAX_BYTES = previous; }
  assert.ok(await sessions.open(base + "/napcat", "fixture"));
  assert.equal(logins, 2);
});
