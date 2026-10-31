import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import test, { type TestContext } from "node:test";
import { getTrustedLanAgentSource, setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { createAgentQqDiagnosticsOperation, handleAgentQqDiagnostics, type AgentQqDiagnosticsContext } from "./agentQqDiagnostics.js";
import { compileApiOperation, readApiOperationInput, validateApiOperationResult } from "./apiOperationContract.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

const route = (): GatewayDefinition => ({ id: "fixture-route", enabled: true, gatewayPort: 9000,
  messageAdapters: ["napcat"], agentAdapters: ["dsh"], primaryAgentAdapter: "dsh",
  primaryAgentTarget: "remote:other-node:other-agent",
  remoteAgentTargets: [{ id: "remote:other-node:other-agent", instanceId: "other-node", agentId: "other-agent", provider: "dsh" }],
  napcatInstances: [{ id: "fixture-instance", gatewayPort: 9001, httpUrl: "http://127.0.0.1:9002", accessToken: ["fixture", "secret"].join("-"), enabled: true }] });
const success = () => new Response(JSON.stringify({ status: "ok", retcode: 0,
  data: { online: true, good: true, user_id: "sensitive-id", nickname: "sensitive-name" } }), { status: 200 });

function fixture(t: TestContext, options: { remote?: boolean; headers?: Record<string, string | undefined>; query?: string; address?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-qq-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const target = `/api/agent/qq/diagnostics${options.query ?? "?routeId=fixture-route"}`;
  const request = { method: "GET", url: target, headers: { host: "localhost:8000", ...options.headers },
    socket: { remoteAddress: options.address ?? (options.remote === false ? "127.0.0.1" : "192.0.2.1") } } as unknown as http.IncomingMessage;
  if (options.remote !== false) {
    request.headers.authorization = `Bearer ${credential.token}`;
    request.headers["x-rabiroute-agent-id"] = "fixture-agent";
    assert.equal(evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    assert.equal(getTrustedLanAgentSource(request), undefined); // No provider-specific plan source.
  }
  let definition = route();
  let probes = 0;
  let statusReads = 0;
  const results: Array<{ status: number; body: any }> = [];
  const context: AgentQqDiagnosticsContext = {
    route: id => id === definition.id ? definition : undefined,
    routeRunning: () => true,
    routeStartedAt: () => "2026-01-02T00:00:00.000Z",
    readStatus: () => { statusReads++; return { napcatInstances: { "fixture-instance": { connected: true, activeConnections: 1, lastConnectedAt: "2026-01-02T00:01:00.000Z" } } }; },
    jsonResponse: (_response, status, body) => results.push({ status, body }),
    probe: async (url, settings) => {
      probes++;
      assert.equal(String(url), "http://127.0.0.1:9002/get_status");
      assert.equal(settings?.method, "GET");
      assert.equal(settings?.redirect, "error");
      assert.equal(settings?.cache, "no-store");
      assert.equal((settings?.headers as Record<string, string>).authorization, "Bearer fixture-secret");
      return success();
    }
  };
  return { authority, config, credential, request, context, results, definition,
    replaceRoute: (next: GatewayDefinition) => { definition = next; },
    counts: () => ({ probes, statusReads }),
    run: () => handleAgentQqDiagnostics(request, new URL(target, "http://localhost:8000"), { setHeader() {} } as unknown as http.ServerResponse, context) };
}

test("authenticated Relay and Peer diagnostics use the original connection lease", async t => {
  for (const header of ["x-rabilink-tunnel-local", "x-rabiroute-peer-proxy"]) {
    const value = fixture(t, { remote: false, address: "192.0.2.2", headers: { [header]: "1" } });
    let revoked = false;
    markAuthenticatedConnectionRequest(value.request, () => { if (revoked) throw new Error("revoked"); });
    await value.run(); assert.equal(value.results[0].status, 200);
    revoked = true;
    await value.run(); assert.equal(value.results[1].status, 403); assert.equal(value.counts().probes, 1);
  }
});

test("diagnostics use the user configured remote HTTP(S) endpoint", async t => {
  for (const httpUrl of ["http://192.0.2.5:3000", "https://napcat.example:8443"]) {
    const value = fixture(t);
    value.definition.napcatInstances![0]!.httpUrl = httpUrl;
    let called = false;
    value.context.probe = async url => { called = true; assert.equal(String(url), httpUrl + "/get_status"); return success(); };
    await value.run(); assert.equal(value.results[0].status, 200); assert.equal(called, true);
  }
});

test("authenticated enabled custom provider without source can diagnose a different Route primary, just like local", async t => {
  for (const remote of [true, false]) {
    const value = fixture(t, { remote });
    assert.equal(await value.run(), true);
    assert.deepEqual(value.counts(), { probes: 1, statusReads: 1 });
    assert.deepEqual(value.results, [{ status: 200, body: { code: 0,
      data: { routeId: "fixture-route", instanceId: "fixture-instance", wsConnected: true,
        oneBot: { reachable: true, online: true, good: true } } } }]);
    assert.doesNotMatch(JSON.stringify(value.results), /sensitive|fixture-secret/);
  }
});

test("executable diagnostics validates its published query and response while preserving remote and local access", async t => {
  for (const remote of [true, false]) {
    const value = fixture(t, { remote });
    const definition = createAgentQqDiagnosticsOperation(value.context);
    const operation = compileApiOperation(definition);
    const url = new URL(value.request.url!, "http://localhost:8000");
    const input = await readApiOperationInput(operation, value.request, url, { setHeader() {} } as unknown as http.ServerResponse);
    const result = await definition.handler(input);
    assert.equal(result.status, 200);
    assert.equal(validateApiOperationResult(operation, result).mediaType, "application/json");
    assert.deepEqual(value.counts(), { probes: 1, statusReads: 1 });
    await assert.rejects(readApiOperationInput(operation, value.request, new URL(url + "&unexpected=1"), input.response), { field: "query" });
    assert.deepEqual(value.counts(), { probes: 1, statusReads: 1 });
  }
});

test("missing ingress principal, forged Agent header and source-only marker cannot access diagnostics", async t => {
  for (const variant of ["nonlocal", "forged", "source"]) {
    const value = fixture(t, { remote: false, address: variant === "nonlocal" ? "192.0.2.1" : "127.0.0.1" });
    if (variant === "forged") value.request.headers["x-rabiroute-agent-id"] = "fixture-agent";
    if (variant === "source") setTrustedLanAgentSource(value.request, { nodeId: "fixture-node", agentId: "fixture-agent", provider: "dsh", sessionId: "fixture-session", sessionName: "Fixture" });
    await value.run();
    assert.equal(value.results[0].status, 403);
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
});

test("revoked original principal never falls back even on loopback", async t => {
  const value = fixture(t, { address: "127.0.0.1" });
  value.authority.setNodeEnabled("fixture-node", false);
  delete value.request.headers["x-rabiroute-agent-id"];
  await value.run();
  assert.equal(value.results[0].status, 403);
  assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
});

test("invalid query, GET body, ambiguous instance, stopped Route and unsafe endpoint fail before status or probe", async t => {
  for (const query of ["?routeId=other-route", "?routeId=fixture-route&url=http://localhost", "?routeId=fixture-route&routeId=other"]) {
    const value = fixture(t, { query });
    await value.run();
    assert.ok(value.results[0].status >= 400);
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
  for (const change of ["body", "ambiguous", "stopped", "disabled", "unsafe"]) {
    const value = fixture(t);
    if (change === "body") value.request.headers["content-length"] = "2";
    if (change === "ambiguous") value.definition.napcatInstances!.push({ ...value.definition.napcatInstances![0], id: "second" });
    if (change === "stopped") value.context.routeRunning = () => false;
    if (change === "disabled") value.definition.messageAdapters = ["heartbeat"];
    if (change === "unsafe") value.definition.napcatInstances![0]!.httpUrl = "file:///unsupported";
    await value.run();
    assert.ok(value.results[0].status >= 400);
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
});

test("safe local fallback rejects proxy, hostile Host/Origin and cross-site fetch", async t => {
  for (const headers of [{ "x-forwarded-for": "192.0.2.1" }, { host: "remote.invalid" }, { origin: "http://remote.invalid" },
    { "sec-fetch-site": "cross-site" }, { "x-rabiroute-peer-proxy": "1" }, { "x-rabilink-tunnel-local": "1" }]) {
    const value = fixture(t, { remote: false, headers });
    await value.run();
    assert.equal(value.results[0].status, 403);
    assert.deepEqual(value.counts(), { probes: 0, statusReads: 0 });
  }
});

test("stale or unversioned WS status cannot indicate live connection", async t => {
  for (const status of [{ connected: true, activeConnections: 1, lastConnectedAt: "2026-01-01T00:00:00.000Z" }, { connected: true, activeConnections: 1 }]) {
    const value = fixture(t);
    value.context.readStatus = () => ({ napcatInstances: { "fixture-instance": status } });
    await value.run();
    assert.equal(value.results[0].status, 200);
    assert.equal(value.results[0].body.data.wsConnected, false);
  }
});

test("revocation between status read and network probe stops upstream access", async t => {
  const value = fixture(t);
  value.context.readStatus = () => { value.authority.setNodeEnabled("fixture-node", false); return {}; };
  await value.run();
  assert.equal(value.results[0].status, 403);
  assert.equal(value.counts().probes, 0);
});

test("revocation and node/global ABA during a pending probe suppress projected result", async t => {
  for (const change of ["disable", "node-aba", "global-aba", "credential"]) {
    const value = fixture(t, { address: "127.0.0.1" });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    value.context.probe = () => { started(); return new Promise<Response>(resolve => { finish = resolve; }); };
    const operation = value.run();
    await waiting;
    if (change === "global-aba") {
      value.config.patch({ webguiLan: { enabled: false } });
      value.config.patch({ webguiLan: { enabled: true } });
    } else if (change === "credential") {
      value.authority.revokeNode("fixture-node");
      const replacement = value.authority.enroll(value.authority.issueBootstrapTicket().ticket, "fixture-node");
    } else {
      value.authority.setNodeEnabled("fixture-node", false);
      if (change === "node-aba") {
        value.authority.setNodeEnabled("fixture-node", true);
        assert.ok(value.authority.authenticate(value.request.headers.authorization!.toString().replace(/^Bearer /, "")), "Restored node accepts fresh authentication while the original request lease remains revoked.");
      }
    }
    delete value.request.headers["x-rabiroute-agent-id"];
    finish(success());
    await operation;
    assert.deepEqual(value.results, [{ status: 403, body: { code: -1, errorCode: "QQ_DIAGNOSTICS_NOT_AUTHORIZED" } }]);
  }
});

test("in-place endpoint changes during status read prevent network probe", async t => {
  const value = fixture(t);
  value.context.readStatus = () => { value.definition.napcatInstances![0]!.httpUrl = "http://remote.invalid"; return {}; };
  await value.run();
  assert.equal(value.results[0].status, 403);
  assert.equal(value.counts().probes, 0);
});

test("valid principal is authoritative even when untrusted proxy markers are present", async t => {
  const value = fixture(t, { headers: { "x-rabiroute-peer-proxy": "1", "x-rabilink-tunnel-local": "1" } });
  await value.run();
  assert.equal(value.results[0].status, 200);
});

test("in-place endpoint changes during probe fail closed", async t => {
  for (const field of ["id", "httpUrl", "accessToken"] as const) {
    const value = fixture(t);
    value.context.probe = async () => { value.definition.napcatInstances![0]![field] = "changed"; return success(); };
    await value.run();
    assert.equal(value.results[0].status, 403);
  }
});

test("bounded get_status probe failure hides upstream details", async t => {
  for (const probe of [async () => { throw new Error("private fixture endpoint"); }, async () => new Response("x".repeat(5000))]) {
    const value = fixture(t);
    value.context.probe = probe;
    await value.run();
    assert.doesNotMatch(JSON.stringify(value.results), /private fixture endpoint/);
    if (value.results[0].status === 200) assert.equal(value.results[0].body.data.oneBot.reachable, false);
    else assert.equal(value.results[0].status, 503);
  }
});

test("status replies above the former 4 KiB probe cap remain reachable", async t => {
  const value = fixture(t);
  value.context.probe = async () => Response.json({ status: "ok", retcode: 0, data: { online: true, good: true, diagnostics: "x".repeat(8192) } });
  await value.run();
  assert.equal(value.results[0].status, 200);
  assert.deepEqual(value.results[0].body.data.oneBot, { reachable: true, online: true, good: true });
});
