import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { createAgentCommunicationRoutes, type AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import { registerLanAgentBodyGuard, setTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { authorizeAgentApiOperation } from "./agentApiPolicy.js";

const originalRequest = { deliveryId: "maintenance-test", sender: { agentType: "agent", sessionId: "test-session" }, routeId: "test-route", channel: "napcat", params: {}, payload: { type: "text", text: "test" } };
function fixture(body: unknown = { originalRequest }, maintenance?: AgentCommunicationRoutesContext["maintenance"]) {
  const results: Array<{ status: number; body: unknown }> = [];
  let sends = 0;
  const context = {
    readJsonBody: async <T>() => body as T,
    jsonResponse: (_response: http.ServerResponse, status: number, value: unknown) => results.push({ status, body: value }),
    send: async () => { sends++; throw new Error("send must not run"); },
    maintenance
  } as unknown as AgentCommunicationRoutesContext;
  const routes = createAgentCommunicationRoutes(context);
  const request = { method: "POST" } as http.IncomingMessage;
  const response = new EventEmitter() as http.ServerResponse;
  return { routes, request, response, results, sends: () => sends,
    start(action = "verify", id = originalRequest.deliveryId) {
      return routes.handler(request, new URL(`http://localhost/api/agent/send/receipts/${id}/${action}`), response);
    },
    async drain() { response.emit("close"); await routes.stopAcceptingAndDrain(); assert.equal(sends, 0); }
  };
}
const success = async () => ({ statusCode: 200, body: { ok: true } });
test("maintenance absent fails closed without parsing or sending", async () => {
  const f = fixture();
  f.start(); await f.drain(); assert.equal(f.results[0].status, 503);
});
test("verify and settle use distinct injected handlers and trusted source", async () => {
  const source: TrustedLanAgentSource = { nodeId: "test-node", agentId: "test-agent", provider: "dsh", sessionId: "test-session", sessionName: "test" };
  for (const action of ["verify", "settle"]) {
    const called: string[] = [];
    const handler = (name: string) => async (id: string, request: unknown, options: unknown) => {
      called.push(name); assert.equal(id, originalRequest.deliveryId); assert.deepEqual(request, originalRequest); assert.deepEqual(options, { remoteSource: source });
      return { statusCode: 403, body: { ok: false, errorCode: "TEST_FORBIDDEN" } };
    };
    const f = fixture({ originalRequest }, { verify: handler("verify"), settle: handler("settle") });
    setTrustedLanAgentSource(f.request, source); registerLanAgentBodyGuard(f.request, () => undefined);
    f.start(action); await f.drain(); assert.deepEqual(called, [action]); assert.equal(f.results[0].status, 403);
  }
});
test("maintenance rejects malformed IDs, original requests and client authority", async () => {
  const bodies: unknown[] = [null, [], {}, { originalRequest: null }, { originalRequest: [] },
    ...["evidence", "verifier", "result", "currentAccount", "remoteSource"].map(key => ({ originalRequest, [key]: {} })),
    { originalRequest: { ...originalRequest, deliveryId: "different" } },
    { originalRequest: { ...originalRequest, verifier: {} } },
    { originalRequest: { ...originalRequest, sender: { ...originalRequest.sender, currentAccount: "forged" } } },
    { originalRequest: { ...originalRequest, params: null } }];
  for (const body of bodies) {
    const f = fixture(body, { verify: async () => { assert.fail("invalid input reached handler"); }, settle: success });
    f.start(); await f.drain(); assert.equal(f.results[0].status, 400);
  }
  for (const id of ["%ZZ", "%2F", "%20", "x".repeat(201)]) {
    const f = fixture({ originalRequest }, { verify: success, settle: success });
    f.start("verify", id); await f.drain(); assert.equal(f.results[0].status, 400);
  }
});
test("remote guard without trusted session denies maintenance", async () => {
  const f = fixture({ originalRequest }, { verify: async () => { assert.fail("unauthenticated handler"); }, settle: success });
  registerLanAgentBodyGuard(f.request, () => undefined);
  f.start(); await f.drain(); assert.equal(f.results[0].status, 403);
});
test("injected exceptions are redacted and drain waits after response closes", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const f = fixture({ originalRequest }, { verify: () => pending, settle: success });
  f.start(); f.response.emit("close");
  let drained = false;
  const stopping = f.routes.stopAcceptingAndDrain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  reject(new Error("fake-sensitive-request-text")); await stopping;
  assert.equal(f.sends(), 0); assert.equal(f.results[0].status, 400);
  assert.equal(JSON.stringify(f.results).includes("fake-sensitive-request-text"), false);
});
test("missing action capability fails closed and unknown suffix is not handled", async () => {
  const f = fixture({ originalRequest }, { settle: success } as unknown as AgentCommunicationRoutesContext["maintenance"]);
  assert.equal(f.start("retry"), false);
  f.start(); await f.drain(); assert.equal(f.results[0].status, 503);
});
test("body parser exceptions are redacted", async () => {
  const results: unknown[] = [];
  const f = fixture({ originalRequest }, { verify: success, settle: success });
  const routes = createAgentCommunicationRoutes({
    readJsonBody: async () => { throw new Error("fake-sensitive-parser-text"); },
    jsonResponse: (_res: http.ServerResponse, _status: number, body: unknown) => { results.push(body); },
    maintenance: { verify: success, settle: success }
  } as unknown as AgentCommunicationRoutesContext);
  routes.handler(f.request, new URL("http://localhost/api/agent/send/receipts/maintenance-test/verify"), f.response);
  f.response.emit("close"); await routes.stopAcceptingAndDrain();
  assert.equal(JSON.stringify(results).includes("fake-sensitive-parser-text"), false);
  assert.equal(results.length, 1);
});
test("maintenance policy permits only explicit paths without query and distinguishes effects", () => {
  for (const action of ["verify", "settle"]) {
    const path = `/api/agent/send/receipts/maintenance-test/${action}`;
    const policy = authorizeAgentApiOperation("POST", path);
    assert.equal(policy.allowed, true);
    if (policy.allowed) {
      assert.equal(policy.operation.help.effects.mode, action === "verify" ? "readOnly" : "mutating");
      assert.match(policy.operation.help.auth.source, /计划绑定非必须/);
    }
    assert.equal(authorizeAgentApiOperation("POST", `${path}?result=sent`).allowed, false);
  }
  assert.equal(authorizeAgentApiOperation("POST", "/api/agent/send/receipts/maintenance-test/retry").allowed, false);
});
