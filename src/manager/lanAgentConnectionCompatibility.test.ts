import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

function fixture(t: { after: (cleanup: () => void) => void }, enabled?: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-connection-compat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "credentials.json");
  const secret = randomBytes(32).toString("base64url");
  const node = { nodeId: "computer-fixture", secretHash: createHash("sha256").update(secret).digest("hex"),
    connectionIncarnation: "a".repeat(64), ...(enabled !== undefined ? { enabled } : {}) };
  const state = { schemaVersion: 2, nodes: [node] };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  return { statePath, state, token: `lan1:${node.nodeId}:${secret}`, authority: new LanAgentAuthority({ statePath }) };
}

test("existing v2 credentials load without migration, implicit grants or byte changes", t => {
  const f = fixture(t); const before = fs.readFileSync(f.statePath);
  assert.deepEqual(f.authority.authenticate(f.token), { nodeId: "computer-fixture" });
  assert(f.authority.acquireConnectionLease(f.token));
  // A legacy facade may expose catalog/grant methods; they must never rewrite v2.
  const legacy = f.authority as unknown as { isAgentEnabled?: (nodeId: string, agentId: string) => boolean;
    registerAgentCatalog?: (token: string, agents: []) => void; setAgentEnabled?: (nodeId: string, agentId: string, enabled: boolean) => void };
  if (legacy.isAgentEnabled) assert.equal(legacy.isAgentEnabled("computer-fixture", "unregistered-provider"), true);
  legacy.registerAgentCatalog?.(f.token, []);
  assert.equal(f.authority.getSnapshot().nodes[0]?.enabled, true);
  if (legacy.setAgentEnabled) assert.throws(() => legacy.setAgentEnabled!("computer-fixture", "worker", false), /do not apply/);
  assert.deepEqual(fs.readFileSync(f.statePath), before);
  assert.equal(fs.readdirSync(path.dirname(f.statePath)).length, 1);
});

test("v2 enrollment and revocation retain credential format, existing incarnation and explicit disables", t => {
  const f = fixture(t, false);
  const credential = f.authority.enroll(f.authority.issueBootstrapTicket().ticket, "second-fixture");
  const written = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(written.schemaVersion, 2);
  assert.deepEqual(written.nodes[0], f.state.nodes[0]);
  assert.deepEqual(Object.keys(written.nodes[1]).sort(), ["connectionIncarnation", "nodeId", "secretHash"]);
  assert(f.authority.authenticate(credential.token));
  assert.deepEqual(f.authority.authenticate(f.token), { nodeId: "computer-fixture" });
  assert.equal(f.authority.acquireConnectionLease(f.token), null);
  f.authority.revokeNode("second-fixture");
  assert.equal(f.authority.authenticate(credential.token), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath, "utf8")), f.state);
});

test("v2 leases fail after disable, credential replacement or revocation, without an Agent profile", t => {
  const f = fixture(t); const lease = f.authority.acquireConnectionLease(f.token)!;
  assert(lease); f.authority.assertConnectionLease(f.token, lease);
  fs.writeFileSync(f.statePath, JSON.stringify({ ...f.state, nodes: [{ ...f.state.nodes[0], enabled: false }] }));
  assert.throws(() => f.authority.assertConnectionLease(f.token, lease), /disabled, revoked or replaced/);
  fs.writeFileSync(f.statePath, JSON.stringify({ ...f.state, nodes: [{ ...f.state.nodes[0], connectionIncarnation: "b".repeat(64) }] }));
  assert.throws(() => f.authority.assertConnectionLease(f.token, lease), /disabled, revoked or replaced/);
  f.authority.revokeNode("computer-fixture");
  assert.equal(f.authority.acquireConnectionLease(f.token), null);
});

test("v2 isolates malformed nodes without resetting credentials or accepting unknown policy fields", t => {
  const f = fixture(t);
  for (const nodes of [[{ ...f.state.nodes[0], connectionIncarnation: "invalid" }],
    [{ ...f.state.nodes[0], enabledAgentIds: ["worker"] }], [f.state.nodes[0], f.state.nodes[0]]]) {
    const bytes = JSON.stringify({ schemaVersion: 2, nodes }); fs.writeFileSync(f.statePath, bytes);
    const isolated = new LanAgentAuthority({ statePath: f.statePath });
    assert.equal(isolated.authenticate(f.token), null);
    assert.equal(isolated.getSnapshot().diagnostics.length, nodes.length);
    assert.equal(fs.readFileSync(f.statePath, "utf8"), bytes);
  }
});

test("real HTTP v2 bare credentials retain shared reads, writes and pinned asset targets without profile headers", async t => {
  const f = fixture(t); let writes = 0;
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, f.authority, true);
    if (access.kind !== "agent") { response.writeHead(access.kind === "denied" ? access.status : 401).end(); return; }
    assertTrustedLanAgentPrincipal(request);
    if (request.method === "POST") writes++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ nodeId: access.nodeId }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`; const headers = { authorization: `Bearer ${f.token}` };
  for (const target of ["/api/roles/role-fixture/plans", "/api/plugins/catalog", "/api/lan-agent/releases/manifest",
    "/api/lan-agent/releases/1.0.0/node/lib/client.mjs?release=" + "a".repeat(64)]) {
    const response = await fetch(base + target, { headers }); assert.equal(response.status, 200, target);
    assert.equal((await response.json() as { nodeId: string }).nodeId, "computer-fixture");
  }
  assert.equal((await fetch(base + "/api/roles/role-fixture/plans", { method: "POST", headers, body: "{}" })).status, 200);
  f.authority.revokeNode("computer-fixture");
  assert.equal((await fetch(base + "/api/roles/role-fixture/plans", { method: "POST", headers, body: "{}" })).status, 403);
  assert.equal(writes, 1);
});

test("v2 explicit invocation source is frozen and binds business payloads without persisted session grants", t => {
  const f = fixture(t); const request = { method: "POST", url: "/api/agent/send", headers: {
    authorization: `Bearer ${f.token}`, "x-rabiroute-agent-type": "codex", "x-rabiroute-session-id": "session-fixture" } } as unknown as IncomingMessage;
  const before = fs.readFileSync(f.statePath);
  assert.equal(evaluateLanAgentRequest(request, f.authority, true).kind, "agent");
  const principal = assertTrustedLanAgentPrincipal(request)!;
  const projected = principal as { binding?: { provider: string; sessionId?: string }; source?: { provider: string; sessionId: string } };
  const source = projected.binding ?? projected.source;
  assert.deepEqual({ provider: source?.provider, sessionId: source?.sessionId }, { provider: "codex", sessionId: "session-fixture" });
  const verified = { agentId: "codex", provider: "codex" as const, sessionId: "session-fixture" };
  assert.doesNotThrow(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "session-fixture" } }, verified));
  assert.throws(() => assertLanAgentBodyAuthority("/api/agent/send", { sender: { sessionId: "foreign-fixture" } }, verified), /does not match this request's explicit ID/);
  request.headers["x-rabiroute-session-id"] = "foreign-fixture";
  assert.equal(evaluateLanAgentRequest(request, f.authority, true).kind, "denied");
  assert.throws(() => assertTrustedLanAgentPrincipal(request), /principal is unavailable/);
  assert.deepEqual(fs.readFileSync(f.statePath), before);
});

test("v2 incomplete source metadata, malformed targets and disabled ingress remain rejected", t => {
  const f = fixture(t);
  const request = (url: string, extra: Record<string, string> = {}) => ({ method: "GET", url,
    headers: { authorization: `Bearer ${f.token}`, ...extra } }) as unknown as IncomingMessage;
  assert.equal(evaluateLanAgentRequest(request("/api/plugins/catalog", { "x-rabiroute-agent-type": "codex" }), f.authority, true).kind, "denied");
  assert.equal(evaluateLanAgentRequest(request("//manager.invalid/api/plugins/catalog"), f.authority, true).kind, "denied");
  assert.equal(evaluateLanAgentRequest(request("/api/plugins/catalog"), f.authority, false).kind, "denied");
});
