import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
import { AgentResourceCatalog } from "./agentResourceCatalog.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

const hookModuleUrl = new URL("../../apps/rabi-agent/lib/instance-hook.mjs", import.meta.url).href;

test("real Hook discovery GET guidance reaches authorized API and public Skill contracts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-discovery-flow-"));
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const registry = new LanAgentRegistry({ statePath: path.join(root, "registry.json") });
  const nodeId = "discovery-fixture-node";
  const agent = { agentId: "worker", provider: "dsh", sessionId: "session-discovery-fixture", enabled: true };
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, nodeId);
  authority.approveAndEnableAgent(nodeId, agent, authority.getSnapshot().revision);
  const resources = new AgentResourceCatalog({ rootDir: repoRoot });
  const dispatched: string[] = [];
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { json(response, 403, { code: -1 }); return; }
    const url = new URL(request.url!, "http://fixture.invalid");
    if (request.method === "GET" && url.pathname === "/meta") {
      json(response, 200, { health: { state: "healthy", requiredReady: true }, applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }); return;
    }
    if (request.method === "POST" && url.pathname === `/api/lan-agent/instances/${nodeId}/agents/${agent.agentId}/context`) {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        const value = JSON.parse(body) as { session_id?: string };
        json(response, value.session_id === agent.sessionId ? 200 : 403, { code: 0, data: { action: "none", additionalContext: "Fixture context." } });
      });
      return;
    }
    dispatched.push(url.pathname);
    if (!handleLanAgentApi(request, url, response, {
      authority, registry, resources, enabled: () => true, releases: {} as LanAgentReleaseStore,
      isManagementRequestAuthorized: () => false, isReleaseRequestAuthorized: () => false,
      jsonResponse: json,
      readJsonBody: async () => { throw new Error("Discovery must not enter a business mutation reader."); }
    })) json(response, 404, { code: -1 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP.");
  const base = `http://127.0.0.1:${address.port}`;
  const configPath = path.join(root, "connector.json");
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: base, nodeId, nodeCredential: credential.token, agents: [agent] }));
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": agent.agentId };
  try {
    const { requestInstanceHook } = await import(hookModuleUrl) as { requestInstanceHook: (input: unknown, configPath: string) => Promise<{ additionalContext: string }> };
    const decision = await requestInstanceHook({ session_id: agent.sessionId }, configPath);
    const targets = [...decision.additionalContext.matchAll(/\bGET\s+(\/[^\s`]+)/g)].map(match => match[1]);
    assert.ok(targets.includes("/api/lan-agent/capabilities"));
    assert.ok(targets.includes("/api/lan-agent/resources"));
    const results = new Map<string, Record<string, any>>();
    for (const target of targets) {
      const response = await fetch(base + target, { headers });
      assert.equal(response.status, 200, target);
      results.set(target, await response.json());
    }
    assert.ok(results.get("/api/lan-agent/capabilities")!.operations.some((item: { pathTemplate: string }) => item.pathTemplate === "/api/agent/uploads/:uploadId"));
    const entries = results.get("/api/lan-agent/resources")!.data as Array<{ id: string }>;
    for (const id of ["docs/rabi-agent-interfaces.md", "skills/plan-task-orchestration/SKILL.md"]) {
      assert.ok(entries.some(entry => entry.id === id), id);
      const response = await fetch(`${base}/api/lan-agent/resources/read?id=${encodeURIComponent(id)}`, { headers });
      assert.equal(response.status, 200);
      const { data } = await response.json() as { data: { id: string; content: string } };
      assert.equal(data.id, id);
      if (id.startsWith("docs/")) { assert.match(data.content, /fileSha256/); assert.match(data.content, /\/api\/agent\/uploads/); }
      else { assert.match(data.content, /计划/); assert.match(data.content, /plan/i); }
    }
    assert.ok(dispatched.includes("/api/lan-agent/capabilities"));
    assert.ok(dispatched.includes("/api/lan-agent/resources/read"));
    for (const old of ["/api/agent/resources", "/api/agent/capabilities"]) {
      assert.equal((await fetch(base + old, { headers })).status, 403);
      assert.ok(!dispatched.includes(old), "obsolete URI must fail authorization, not act as an alias");
    }
    authority.setAgentEnabled(nodeId, agent.agentId, false);
    assert.equal((await fetch(`${base}/api/lan-agent/resources`, { headers })).status, 403);
  } finally {
    registry.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
