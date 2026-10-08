import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { handleAgentQqDiagnostics, type AgentQqDiagnosticsContext } from "./agentQqDiagnostics.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

const source = { nodeId: "fixture-node", agentId: "fixture-agent", provider: "dsh" as const,
  sessionId: "fixture-session", sessionName: "Fixture" };
const route = { id: "fixture-route", enabled: true, gatewayPort: 9000,
  messageAdapters: ["napcat"], agentAdapters: ["dsh"], primaryAgentAdapter: "dsh",
  primaryAgentTarget: "remote:fixture-node:fixture-agent",
  remoteAgentTargets: [{ id: "remote:fixture-node:fixture-agent", instanceId: "fixture-node", agentId: "fixture-agent", provider: "dsh" }],
  napcatInstances: [{ id: "fixture-instance", gatewayPort: 9001, httpUrl: "http://127.0.0.1:9002", accessToken: ["fixture", "secret"].join("-"), enabled: true }] } as GatewayDefinition;

function fixture(overrides: Partial<AgentQqDiagnosticsContext> = {}) {
  const results: Array<{ status: number; body: any }> = [];
  let probes = 0;
  let statusReads = 0;
  const context: AgentQqDiagnosticsContext = {
    route: id => id === route.id ? route : undefined,
    approvedBinding: () => ({ provider: source.provider, sessionId: source.sessionId }),
    isAgentEnabled: () => true,
    routeRunning: () => true,
    routeStartedAt: () => "2026-01-02T00:00:00.000Z",
    readStatus: () => { statusReads++; return { napcatInstances: { "fixture-instance": { connected: true, activeConnections: 1, lastConnectedAt: "2026-01-02T00:01:00.000Z" } } }; },
    jsonResponse: (_response, status, body) => results.push({ status, body }),
    probe: async (url, options) => {
      probes++;
      assert.equal(String(url), "http://127.0.0.1:9002/get_status");
      assert.equal(options?.method, "GET");
      assert.equal(options?.redirect, "error");
      assert.equal(options?.cache, "no-store");
      assert.equal((options?.headers as Record<string, string>).authorization, "Bearer fixture-secret");
      return new Response(JSON.stringify({ status: "ok", retcode: 0,
        data: { online: true, good: true, user_id: "sensitive-id", nickname: "sensitive-name" } }), { status: 200 });
    }, ...overrides
  };
  return { context, results, counts: () => ({ probes, statusReads }) };
}
async function run(context: AgentQqDiagnosticsContext, query = "?routeId=fixture-route", trusted = true, headers = {}) {
  const request = { method: "GET", headers } as http.IncomingMessage;
  if (trusted) setTrustedLanAgentSource(request, source);
  const response = new EventEmitter() as http.ServerResponse;
  response.setHeader = () => response;
  assert.equal(await handleAgentQqDiagnostics(request, new URL(`http://localhost/api/agent/qq/diagnostics${query}`), response, context), true);
}

test("trusted exact primary Route projects only WS and OneBot booleans", async () => {
  const value = fixture();
  await run(value.context);
  assert.deepEqual(value.counts(), { probes: 1, statusReads: 1 });
  assert.deepEqual(value.results, [{ status: 200, body: { code: 0,
    data: { routeId: "fixture-route", instanceId: "fixture-instance", wsConnected: true,
      oneBot: { reachable: true, online: true, good: true } } } }]);
  assert.ok(!JSON.stringify(value.results).includes("sensitive"));
});

test("missing LAN identity, revoked/rebound principal, wrong Route and GET body fail before any read", async () => {
  for (const [trusted, query, headers, overrides] of [
    [false, "?routeId=fixture-route", {}, {}],
    [true, "?routeId=other-route", {}, {}],
    [true, "?routeId=fixture-route", { "content-length": "2" }, {}],
    [true, "?routeId=fixture-route", {}, { isAgentEnabled: () => false }],
    [true, "?routeId=fixture-route", {}, { approvedBinding: () => ({ provider: "dsh", sessionId: "changed" }) }],
    [true, "?routeId=fixture-route&url=http://localhost", {}, {}],
    [true, "?routeId=fixture-route&routeId=other", {}, {}]
  ] as const) {
    const value = fixture(overrides);
    await run(value.context, query, trusted, headers);
    assert.ok(value.results[0].status >= 400, JSON.stringify({ overrides: Object.keys(overrides), result: value.results[0] }));
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
});

test("ambiguous instances, stopped Route, disabled NapCat and non-loopback endpoint do not probe", async () => {
  for (const overrides of [
    { route: () => ({ ...route, napcatInstances: [...route.napcatInstances!, { ...route.napcatInstances![0], id: "second" }] }) },
    { routeRunning: () => false },
    { route: () => ({ ...route, messageAdapters: ["heartbeat"] }) },
    { route: () => ({ ...route, napcatInstances: [{ ...route.napcatInstances![0], httpUrl: "http://remote.invalid:9002" }] }) }
  ]) {
    const value = fixture(overrides as Partial<AgentQqDiagnosticsContext>);
    await run(value.context);
    assert.ok(value.results[0].status >= 400, JSON.stringify({ overrides: Object.keys(overrides), result: value.results[0] }));
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
});

test("stale or unversioned Gateway WS status cannot indicate a live connection", async () => {
  for (const status of [
    { connected: true, activeConnections: 1, lastConnectedAt: "2026-01-01T00:00:00.000Z" },
    { connected: true, activeConnections: 1 }
  ]) {
    const value = fixture({ readStatus: () => ({ napcatInstances: { "fixture-instance": status } }) });
    await run(value.context);
    assert.equal(value.results[0].status, 200);
    assert.equal(value.results[0].body.data.wsConnected, false);
  }
});

test("revocation during probe suppresses even the projected result", async () => {
  let enabled = true;
  const value = fixture({ isAgentEnabled: () => enabled,
    probe: async () => { enabled = false; return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { online: true, good: true } })); } });
  await run(value.context);
  assert.deepEqual(value.results, [{ status: 403, body: { code: -1, errorCode: "QQ_DIAGNOSTICS_NOT_AUTHORIZED" } }]);
});

test("probe failure reports unavailable rather than offline", async () => {
  const value = fixture({ probe: async () => { throw new Error("private fixture endpoint"); } });
  await run(value.context);
  assert.deepEqual(value.results, [{ status: 503, body: { code: -1, errorCode: "QQ_DIAGNOSTICS_PROBE_UNAVAILABLE" } }]);
});
