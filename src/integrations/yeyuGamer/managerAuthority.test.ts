import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { LanAgentAuthority } from "../../manager/lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "../../manager/globalConfig.js";
import { evaluateLanAgentRequest } from "../../manager/lanAgentRequestAccess.js";
import { YeYuGamerManagerApiClient } from "./managerApi.js";
import { handleYeYuGamerManagerApi } from "./managerRoutes.js";

const health = { status: "ok", manager: "ok", storage: "ok", eventStream: "ok", checkedAt: "2026-08-27T00:00:00.000Z", checks: {} };
const snapshot = { stateVersion: 7777777, generatedAt: "2026-08-27T00:00:00.000Z", eventCursor: "sensitive-cursor", manager: {}, health: {}, gameDay: "2026-08-27", activeBatch: null, recentBatches: [], games: [], counters: {} };
const receipt = { commandId: "sensitive-command", idempotencyKey: "dispatch-1", requestId: null, statusUrl: "/api/v1/agent/work-items/sensitive-command", acceptedStateVersion: 8, state: "accepted", message: "accepted", result: {}, submittedAt: "2026-08-27T00:00:00.000Z", completedAt: null, replayed: false };
const body = { workItem: { kind: "observation", note: "fixture" }, idempotencyKey: "dispatch-1", expectedStateVersion: 7 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Mode = "agent-aba" | "node-reenroll" | "global-aba";
type Stage = "body" | "credential" | "credential-reject" | "fetch" | "fetch-reject" | "json";

async function fixture(t: TestContext, stage?: Stage, mutation = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-yeyu-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
  authority.registerAgentCatalog(credential.token, [binding]);
  const entered = deferred(); const gate = deferred(); t.after(gate.resolve);
  let dispatches = 0;
  const pause = async (at: Stage) => {
    if (stage === at) { entered.resolve(); await gate.promise; }
  };
  const client = new YeYuGamerManagerApiClient({ runtimeDir: root }, {
    readFile: async () => {
      await pause(stage === "credential-reject" ? "credential-reject" : "credential");
      if (stage === "credential-reject") throw new Error("credential-failure-secret");
      return "A".repeat(48);
    },
    fetch: async () => {
      dispatches++;
      await pause(stage === "fetch-reject" ? "fetch-reject" : "fetch");
      if (stage === "fetch-reject") throw new Error("fetch-failure-secret");
      return {
        ok: true, status: 200,
        json: async () => { await pause("json"); return mutation ? receipt : snapshot; }
      } as Response;
    }
  });
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy());
    if (access.kind !== "agent") { response.writeHead(403); response.end("denied"); return; }
    handleYeYuGamerManagerApi(request, new URL(request.url!, "http://fixture.invalid"), response, {
      getConfig: () => ({}), createClient: () => client,
      readJsonBody: async <T>() => { await pause("body"); return body as T; },
      jsonResponse: (res, status, result) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(result)); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${address.port}`, entered, gate, dispatches: () => dispatches,
    headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" },
    revoke(mode: Mode) {
      if (mode === "agent-aba") { authority.setAgentEnabled("fixture-node", "worker", false); authority.setAgentEnabled("fixture-node", "worker", true); }
      else if (mode === "global-aba") { config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } }); }
      else {
        authority.revokeNode("fixture-node");
        const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
        authority.registerAgentCatalog(replacement.token, [binding]);
      }
    }
  };
}

for (const mode of ["agent-aba", "node-reenroll", "global-aba"] as const) {
  for (const stage of ["body", "credential", "credential-reject", "fetch", "fetch-reject", "json"] as const) {
    test(`YeYu original ${mode} lease is fenced across ${stage}`, { timeout: 10000 }, async t => {
      const f = await fixture(t, stage, true);
      const pending = fetch(`${f.url}/api/agent/yeyu-gamer/work-items`, { method: "POST", headers: f.headers, body: "{}" });
      await f.entered.promise; f.revoke(mode); f.gate.resolve();
      const response = await pending; const result = await response.json();
      const afterDispatch = ["fetch", "fetch-reject", "json"].includes(stage);
      assert.equal(response.status, 403);
      assert.equal(result.mutationOutcome, afterDispatch ? "unknown" : "not_started");
      assert.equal(result.uncertain, afterDispatch);
      assert.equal(f.dispatches(), afterDispatch ? 1 : 0);
      assert.equal(result.data, undefined);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-command|credential-failure-secret|fetch-failure-secret|statusUrl|acceptedStateVersion/);
    });
  }
  test(`YeYu read response withholds original ${mode} lease data`, { timeout: 10000 }, async t => {
    const f = await fixture(t, "json");
    const pending = fetch(`${f.url}/api/agent/yeyu-gamer/snapshot`, { headers: f.headers });
    await f.entered.promise; f.revoke(mode); f.gate.resolve();
    const response = await pending; const result = await response.text();
    assert.equal(response.status, 403); assert.doesNotMatch(result, /7777777|sensitive-cursor|data/);
  });
}

test("enabled authenticated YeYu Agent retains read and work-item contracts", async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/agent/yeyu-gamer/snapshot`, { headers: f.headers });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, snapshot);
  const g = await fixture(t, undefined, true);
  const posted = await fetch(`${g.url}/api/agent/yeyu-gamer/work-items`, { method: "POST", headers: g.headers, body: "{}" });
  assert.equal(posted.status, 202); assert.deepEqual((await posted.json()).data, receipt);
});

test("unauthenticated YeYu local access enforces Host, Origin and forwarding checks", () => {
  for (const headers of [{}, { host: "attacker.invalid" }, { host: "127.0.0.1", origin: "http://attacker.invalid" }, { host: "127.0.0.1", forwarded: "for=127.0.0.1" }, { host: "127.0.0.1", "sec-fetch-site": "cross-site" }]) {
    let reads = 0; let status = 0;
    const request = { method: "GET", headers, socket: { remoteAddress: "127.0.0.1" } } as http.IncomingMessage;
    handleYeYuGamerManagerApi(request, new URL("http://localhost/api/agent/yeyu-gamer/health"), {} as http.ServerResponse, {
      getConfig: () => { reads++; return {}; }, readJsonBody: async () => ({} as never),
      jsonResponse: (_res, code) => { status = code; }, createClient: () => ({ getHealth: async () => health } as never)
    });
    assert.equal(status, 403); assert.equal(reads, 0);
  }
});
