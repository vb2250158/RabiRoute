import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { AgentResourceCatalog } from "./agentResourceCatalog.js";

test("HTTP enrollment, explicit admin grant, resources and offline revocation share authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-access-http-"));
  fs.mkdirSync(path.join(root, "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example fixture\n---\nRead the API contract.");
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const binding = { agentId: "worker", name: "Fixture", provider: "dsh", enabled: true, sessionId: "session-fixture" };
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ schemaVersion: 2, nodes: [{ nodeId: "node-fixture", version: "1", platform: "fixture", agents: [binding] }], tasks: [] }));
  const registry = new LanAgentRegistry({ statePath: path.join(root, "registry.json") });
  const server = http.createServer((request, response) => {
    const handled = handleLanAgentApi(request, new URL(request.url!, "http://fixture.invalid"), response, {
      authority, registry, resources: new AgentResourceCatalog({ rootDir: root, publicDocs: [] }), enabled: () => true,
      releases: {} as LanAgentReleaseStore,
      isManagementRequestAuthorized: req => req.headers["x-rabiroute-webgui-token"] === "fixture-admin",
      isReleaseRequestAuthorized: () => false,
      jsonResponse: (res, status, data) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); },
      readJsonBody: async <T>(req: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T; }
    });
    if (!handled) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const ticketResponse = await fetch(`${base}/api/lan-agent/enrollments`, { method: "POST", headers: { "x-rabiroute-webgui-token": "fixture-admin" } });
    assert.equal(ticketResponse.status, 201);
    const ticket = (await ticketResponse.json()).data.ticket;
    const enroll = () => fetch(`${base}/api/lan-agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket, nodeId: "node-fixture" }) });
    const enrolled = await enroll();
    assert.equal(enrolled.status, 201);
    const token = (await enrolled.json()).data.token;
    assert.equal((await enroll()).status, 400);
    const headers = { authorization: `Bearer ${token}`, "x-rabiroute-agent-id": "worker" };
    assert.equal((await fetch(`${base}/api/lan-agent/resources`, { headers })).status, 403);
    const adminHeaders = { "x-rabiroute-webgui-token": "fixture-admin" };
    const catalog = await fetch(`${base}/api/lan-agent/instances`, { headers: adminHeaders });
    const revision = catalog.headers.get("etag")!;
    const enabled = await fetch(`${base}/api/lan-agent/instances/node-fixture/agents/worker/authorization`, {
      method: "PUT", headers: { ...adminHeaders, "content-type": "application/json", "if-match": revision, "idempotency-key": "fixture-enable-1" },
      body: JSON.stringify({ enabled: true, binding: { provider: "dsh", sessionId: "session-fixture" } })
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.headers.get("idempotency-key"), "fixture-enable-1");
    const replay = await fetch(`${base}/api/lan-agent/instances/node-fixture/agents/worker/authorization`, {
      method: "PUT", headers: { ...adminHeaders, "content-type": "application/json", "if-match": revision, "idempotency-key": "fixture-enable-1" },
      body: JSON.stringify({ enabled: true, binding: { provider: "dsh", sessionId: "session-fixture" } })
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).receipt.replayed, true);
    assert.equal(authority.getApprovedAgentBinding("node-fixture", "worker")?.sessionId, "session-fixture");
    const stale = await fetch(`${base}/api/lan-agent/instances/node-fixture/agents/worker/authorization`, {
      method: "PUT", headers: { ...adminHeaders, "content-type": "application/json", "if-match": revision, "idempotency-key": "fixture-disable-1" }, body: JSON.stringify({ enabled: false })
    });
    assert.equal(stale.status, 412);
    const listed = await fetch(`${base}/api/lan-agent/resources`, { headers });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).data[0].id, "skills/example/SKILL.md");
    // No remote-only operation denial: the handler still requires management authentication.
    assert.equal((await fetch(`${base}/api/lan-agent/nodes`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/api/lan-agent/resources/read?id=..%2Fauthority.json`, { headers })).status, 400);
    authority.setAgentEnabled("node-fixture", "worker", false);
    assert.equal((await fetch(`${base}/api/lan-agent/resources`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/lan-agent/self`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    registry.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
