import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";
import { fetchAccountHost, proxyAccountHost, type AccountProxyRelay } from "./rabiLinkHostAccountProxy.js";

const relay: AccountProxyRelay = { url: "https://relay.invalid", token: "token", accountId: "account" };

function relayReply(structuredContent: unknown) {
  return new Response(JSON.stringify({ code: 0, data: { structuredContent } }), { headers: { "content-type": "application/json" } });
}

function proxyFixture() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) { state.status = status; state.headers = headers; return response; },
    end(body?: string | Uint8Array) { state.body = typeof body === "string" ? body : ""; return response; }
  } as unknown as http.ServerResponse;
  const input = {
    request: { method: "GET", headers: {} } as unknown as http.IncomingMessage,
    response, url: new URL("https://manager.invalid/api/rabilink/peer/http/pc-b/manager/meta"),
    path: { deviceId: "pc-b", service: "manager", path: "meta" }, query: {},
    signal: AbortSignal.timeout(5_000), assertCurrent() {},
    prepareResponse(status: number, headers: Record<string, unknown>) { state.status = status; state.headers = headers; }
  };
  return { state, input };
}

test("an older Relay target keeps its original code instead of a generic unavailable answer", async t => {
  t.mock.method(globalThis, "fetch", async () => relayReply({ ok: false, uncertain: false, code: "API_TRANSPORT_UNCONFIRMED" }));
  const { state, input } = proxyFixture();
  await proxyAccountHost(input, relay, () => {});
  assert.equal(state.status, 502);
  const body = JSON.parse(state.body) as { error?: string; message?: string; uncertain?: boolean };
  assert.equal(body.error, "API_TRANSPORT_UNCONFIRMED");
  assert.match(String(body.message), /API_TRANSPORT_UNCONFIRMED/);
  assert.equal(body.uncertain, false);
  assert.ok(!state.body.includes("Remote response unavailable"), "The replacement sentence must not swallow the real cause");
});

test("an unconfirmed write keeps the Relay code and its uncertainty", async t => {
  t.mock.method(globalThis, "fetch", async () => relayReply({ ok: false, uncertain: true, code: "API_READBACK_REQUIRED", operationId: "op-1", state: "pending" }));
  const response = await fetchAccountHost(relay, "pc-b", "manager", "/api/roles", { method: "GET" }, () => {});
  assert.equal(response.status, 502);
  const body = await response.json() as { error?: string; message?: string; uncertain?: boolean };
  assert.equal(body.error, "API_READBACK_REQUIRED");
  assert.equal(body.uncertain, true);
});

test("a normal Relay status still passes the original response through", async t => {
  const payload = Buffer.from(JSON.stringify({ code: 0, data: { roles: [] } })).toString("base64");
  t.mock.method(globalThis, "fetch", async () => relayReply({ statusCode: 200, headers: { "content-type": "application/json", etag: '"v1"' },
    data: { bodyBase64: payload, contentType: "application/json" } }));
  const response = await fetchAccountHost(relay, "pc-b", "manager", "/api/roles", { method: "GET" }, () => {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"v1"');
  assert.equal((await response.json() as { code: number }).code, 0);
});
