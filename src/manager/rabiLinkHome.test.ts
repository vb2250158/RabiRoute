import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { handleRabiApi, type RabiApiContext } from "./rabiApi.js";
import { readRabiLinkHome, RabiLinkHomeError } from "./rabiLinkHome.js";
import type { RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { authorizeAgentApiOperation } from "./agentApiPolicy.js";

test("route-control declares the read-only home route behind existing Manager authorization", () => {
  const plugin = fs.readFileSync(new URL("../../plugins/builtin/io.rabiroute.manager.route-control/1.0.0/manager.mjs", import.meta.url), "utf8");
  assert.match(plugin, /routeId: "rabi-link-home", kind: "exact", path: "\/api\/rabi\/link-home", methods: \["GET"\]/);
});

test("remote Agent authorization does not grant access to link home", () => {
  assert.deepEqual(authorizeAgentApiOperation("GET", "/api/rabi/link-home"), { allowed: false, reason: "operation_not_allowed" });
});

async function server(t: TestContext, handler: http.RequestListener): Promise<string> {
  const instance = http.createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
function config(url: string): RabiLinkRelayGlobalConfig {
  return { enabled: true, url, token: "test-only-app-token", deviceId: "test-device", claimWaitMs: 1000, replyIdleTimeoutMs: 1000, speechProxyEnabled: false, speechServiceUrl: "" };
}
const peer = { id: "device-a", guid: "guid-a", name: "Device A", online: true, capabilities: ["peer-rpc-v1"] };
function send(response: http.ServerResponse, body: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
async function manager(t: TestContext, read: () => RabiLinkRelayGlobalConfig): Promise<string> {
  const context = { applicationGenerationId: "test-generation", managerInstanceId: "test-manager", globalConfig: { read: () => ({ rabiLinkRelay: read() }) } } as unknown as RabiApiContext;
  return server(t, (request, response) => {
    if (!handleRabiApi(request, new URL(request.url || "/", "http://localhost"), response, context)) { response.statusCode = 404; response.end(); }
  });
}

test("link home uses only saved app header and returns a positive allowlist", async t => {
  let calls = 0;
  const upstream = await server(t, (request, response) => {
    calls++;
    assert.equal(request.url, "/api/rabilink/peers");
    assert.equal(request.headers["x-rabilink-token"], "test-only-app-token");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    send(response, { code: 0, ok: true, appId: "private-app", peers: [{ ...peer, token: "private", tokenPreview: "private", appTokenPreview: "private", ownerAccountId: "private", notes: "private", deviceBindings: ["private"], peerUrls: ["http://private.invalid"] }] });
  });
  const base = await manager(t, () => config(upstream));
  const response = await fetch(`${base}/api/rabi/link-home`, { headers: { cookie: "private-cookie", authorization: "Bearer private-caller", "x-rabilink-token": "caller-token" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 0);
  assert.deepEqual(body.data.devices, [peer]);
  assert.ok(Number.isFinite(Date.parse(body.data.checkedAt)));
  assert.doesNotMatch(JSON.stringify(body), /private|token|cookie|peerUrls|appId/);
  assert.equal(calls, 1);
  const invalid = await fetch(`${base}/api/rabi/link-home?url=http://example.invalid&token=caller`);
  assert.equal(invalid.status, 400);
  assert.equal(calls, 1);
});

test("disabled and missing configuration fail explicitly without an empty success", async t => {
  for (const saved of [{ ...config(""), enabled: false }, config("")]) {
    const base = await manager(t, () => saved);
    const response = await fetch(`${base}/api/rabi/link-home`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, -1);
    assert.equal(body.data, undefined);
  }
});

test("redirect is rejected without leaking the app token to its target", async t => {
  let targetCalls = 0;
  const target = await server(t, (_request, response) => { targetCalls++; response.end("unexpected"); });
  const upstream = await server(t, (_request, response) => { response.writeHead(302, { location: target }); response.end(); });
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 502);
  assert.equal(targetCalls, 0);
});

test("deadline includes an unfinished response body", async t => {
  const upstream = await server(t, (_request, response) => { response.writeHead(200); response.write('{"code":0,'); });
  const start = Date.now();
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 504);
  assert.ok(Date.now() - start < 6000);
});

test("upstream failures, malformed JSON and invalid contracts never become zero devices", async t => {
  const cases = ["not json", { code: -1, ok: false, peers: [] }, { code: 0, ok: true }, { code: 0, ok: true, peers: [{ ...peer, online: "true" }] }];
  for (const payload of cases) {
    const upstream = await server(t, (_request, response) => { if (typeof payload === "string") response.end(payload); else send(response, payload); });
    await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.statusCode === 502);
  }
  const upstream = await server(t, (_request, response) => { response.statusCode = 401; response.end("private-token-cookie-raw-error"); });
  const base = await manager(t, () => config(upstream));
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /private-token-cookie-raw-error|devices/);
  assert.equal(JSON.parse(text).code, -1);
});

test("streaming oversized body is bounded even without content length", async t => {
  const upstream = await server(t, (_request, response) => { response.writeHead(200); response.write(" ".repeat(256 * 1024)); response.end("extra"); });
  await assert.rejects(readRabiLinkHome(config(upstream)), (error: unknown) => error instanceof RabiLinkHomeError && error.errorCode === "RABILINK_HOME_RESPONSE_TOO_LARGE");
});

test("configuration changes during discovery reject the old authorization result", async t => {
  let saved: RabiLinkRelayGlobalConfig;
  const upstream = await server(t, (_request, response) => { saved = { ...saved, token: "changed-test-token" }; send(response, { code: 0, ok: true, peers: [peer] }); });
  saved = config(upstream);
  const base = await manager(t, () => saved);
  const response = await fetch(`${base}/api/rabi/link-home`);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.errorCode, "RABILINK_HOME_CONFIG_CHANGED");
  assert.equal(body.data, undefined);
});
