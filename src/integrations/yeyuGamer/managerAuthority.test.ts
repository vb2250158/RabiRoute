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
import { createYeYuGamerManagerOperations } from "./managerRoutes.js";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "../../manager/lanAgentBodyAuthority.js";

const health = { status: "ok", manager: "ok", storage: "ok", eventStream: "ok", checkedAt: "2026-08-27T00:00:00.000Z", checks: {} };
const snapshot = { stateVersion: 7777777, generatedAt: "2026-08-27T00:00:00.000Z", eventCursor: "sensitive-cursor", manager: {}, health: {}, gameDay: "2026-08-27", activeBatch: null, recentBatches: [], games: [], counters: {} };
const receipt = { commandId: "sensitive-command", idempotencyKey: "dispatch-1", requestId: null, statusUrl: "/api/v1/agent/work-items/sensitive-command", acceptedStateVersion: 8, state: "accepted", message: "accepted", result: {}, submittedAt: "2026-08-27T00:00:00.000Z", completedAt: null, replayed: false };
const body = { workItem: { kind: "observation", note: "fixture" }, idempotencyKey: "dispatch-1", expectedStateVersion: 7 };
function requestOwned(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method, headers: options.headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode! })));
    });
    request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned YeYu authority fixture timed out."))); request.end(options.body);
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Mode = "node-aba" | "node-reenroll" | "global-aba";
type Stage = "body" | "credential" | "credential-reject" | "fetch" | "fetch-reject" | "json";

async function fixture(t: TestContext, stage?: Stage, mutation = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-yeyu-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const binding = { agentId: "worker", provider: "dsh", sessionId: "fixture-session" };
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
  const owner = createYeYuGamerManagerOperations({ getConfig: () => ({}), createClient: () => client });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("yeyu-authority-fixture", owner.operations.map(definition => ({ ...definition,
    prepare: async input => {
      const prepared = await definition.prepare!(input);
      return typeof prepared === "function" ? async fullInput => { await pause("body"); return prepared(fullInput); } : prepared;
    }
  })));
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true, () => config.getLanAgentAdmissionPolicy());
    if (access.kind !== "agent") { response.writeHead(403); response.end("denied"); return; }
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => {
    const retired = registration.dispose(); await owner.stop(); await retired;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    url: `http://127.0.0.1:${address.port}`, entered, gate, dispatches: () => dispatches,
    headers: { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" },
    revoke(mode: Mode) {
      if (mode === "node-aba") {
        authority.setNodeEnabled("fixture-node", false);
        authority.setNodeEnabled("fixture-node", true);
        assert.ok(authority.authenticate(credential.token), "Restored node admits fresh authentication while the original lease remains revoked.");
      }
      else if (mode === "global-aba") { config.patch({ webguiLan: { enabled: false } }); config.patch({ webguiLan: { enabled: true } }); }
      else {
        authority.revokeNode("fixture-node");
        const replacement = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
      }
    }
  };
}

for (const mode of ["node-aba", "node-reenroll", "global-aba"] as const) {
  for (const stage of ["body", "credential", "credential-reject", "fetch", "fetch-reject", "json"] as const) {
    test(`YeYu original ${mode} lease is fenced across ${stage}`, { timeout: 10000 }, async t => {
      const f = await fixture(t, stage, true);
      const pending = requestOwned(`${f.url}/api/agent/yeyu-gamer/work-items`, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
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
    const pending = requestOwned(`${f.url}/api/agent/yeyu-gamer/snapshot`, { headers: f.headers });
    await f.entered.promise; f.revoke(mode); f.gate.resolve();
    const response = await pending; const result = await response.text();
    assert.equal(response.status, 403); assert.doesNotMatch(result, /7777777|sensitive-cursor|data/);
  });
}

test("enabled authenticated YeYu Agent retains read and work-item contracts", async t => {
  const f = await fixture(t);
  const response = await requestOwned(`${f.url}/api/agent/yeyu-gamer/snapshot`, { headers: f.headers });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, snapshot);
  const g = await fixture(t, undefined, true);
  const posted = await requestOwned(`${g.url}/api/agent/yeyu-gamer/work-items`, { method: "POST", headers: g.headers, body: JSON.stringify(body) });
  assert.equal(posted.status, 202); assert.deepEqual((await posted.json()).data, receipt);
});

test("unauthenticated YeYu local access enforces Host, Origin and forwarding checks", async () => {
  for (const headers of [{}, { host: "attacker.invalid" }, { host: "127.0.0.1", origin: "http://attacker.invalid" }, { host: "127.0.0.1", forwarded: "for=127.0.0.1" }, { host: "127.0.0.1", "sec-fetch-site": "cross-site" }]) {
    let reads = 0;
    const request = { method: "GET", headers, socket: { remoteAddress: "127.0.0.1" } } as http.IncomingMessage;
    const owner = createYeYuGamerManagerOperations({ getConfig: () => { reads++; return {}; }, createClient: () => ({ getHealth: async () => health } as never) });
    const result = await owner.operations[0]!.prepare!({ request, url: new URL("http://localhost/api/agent/yeyu-gamer/health"), response: {} as http.ServerResponse, path: {}, query: {} });
    assert.notEqual(typeof result, "function");
    if (typeof result !== "function") assert.equal(result.status, 403);
    assert.equal(reads, 0); await owner.stop();
  }
});
