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
import { handleLanAgentApi, summarizeAgentCapabilityCoverage } from "./lanAgentRoutes.js";
import { AgentResourceCatalog } from "./agentResourceCatalog.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

const hookModuleUrl = new URL("../../apps/rabi-agent/lib/instance-hook.mjs", import.meta.url).href;

test("capability coverage summary distinguishes baseline and verified contracts", () => {
  const operation = { help: { contractLevel: "verified", coverage: { exactRequestSchema: true, exactResponseSchema: true, missing: [] } } } as any;
  const baseline = { help: { contractLevel: "baseline", coverage: { missing: ["request-body-schema"] } } } as any;
  assert.deepEqual(summarizeAgentCapabilityCoverage([operation, baseline]), {
    operationCount: 2, baselineCount: 1, verifiedCount: 1, unverifiedCount: 0, missing: ["request-body-schema"]
  });
});

test("unknown levels and inconsistent verified labels never inflate verified coverage", () => {
  const entries = [
    { help: { contractLevel: "future-level", coverage: { exactRequestSchema: true, exactResponseSchema: true, missing: [] } } },
    { help: { contractLevel: "verified", coverage: { exactRequestSchema: false, exactResponseSchema: true, missing: [] } } },
    { help: { contractLevel: "verified", coverage: { exactRequestSchema: true, exactResponseSchema: true, missing: ["response-schema"] } } }
  ] as any;
  const summary = summarizeAgentCapabilityCoverage(entries);
  assert.equal(summary.verifiedCount, 0);
  assert.equal(summary.unverifiedCount, 3);
  assert.equal(summary.operationCount, summary.baselineCount + summary.verifiedCount + summary.unverifiedCount);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.missing));
});

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
      json(response, 200, { health: { state: "healthy", requiredReady: true, live: true }, applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }); return;
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
    const targets = [...decision.additionalContext.matchAll(/--api GET\s+(\/[^\s`]+)/g)].map(match => match[1]);
    assert.ok(targets.includes("/api/lan-agent/capabilities"));
    assert.ok(targets.includes("/api/lan-agent/resources"));
    const results = new Map<string, Record<string, any>>();
    for (const target of targets) {
      // This is a documented template, not a discovered resource in this fixture.
      if (target === "/api/roles/ROLE_ID/skills/SKILL_ID/download") continue;
      const response = await fetch(base + target, { headers });
      assert.equal(response.status, 200, target);
      results.set(target, await response.json());
    }
    const capabilityBody = results.get("/api/lan-agent/capabilities")!;
    assert.equal(capabilityBody.schemaVersion, "1");
    assert.equal(capabilityBody.contractRevision, "agent-api-help-1");
    assert.match(String(capabilityBody.generatedAt), /T/);
    assert.equal(capabilityBody.coverage.operationCount, capabilityBody.operations.length);
    assert.equal(capabilityBody.coverage.baselineCount, capabilityBody.operations.length);
    assert.equal(capabilityBody.coverage.verifiedCount, 0);
    const declaredMissing = capabilityBody.operations.flatMap((item: { help: { coverage: { missing: string[] } } }) => item.help.coverage.missing);
    assert.deepEqual(capabilityBody.coverage.missing, [...new Set(declaredMissing)]);
    assert.ok(capabilityBody.coverage.missing.includes("request-body-schema"));
    assert.ok(capabilityBody.coverage.missing.includes("response-schema"));
    assert.ok(capabilityBody.coverage.missing.includes("error-response-schemas"));
    assert.ok(capabilityBody.operations.every((item: { help?: { operationId?: string; request?: unknown; response?: unknown; errors?: unknown; nextStep?: string } }) => item.help?.operationId && item.help.request && item.help.response && item.help.errors && item.help.nextStep));
    assert.ok(capabilityBody.operations.some((item: { pathTemplate: string }) => item.pathTemplate === "/api/agent/uploads/:uploadId"));
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
      assert.ok([403, 404].includes((await fetch(base + old, { headers })).status), old);
    }
    authority.setAgentEnabled(nodeId, agent.agentId, false);
    assert.equal((await fetch(`${base}/api/lan-agent/resources`, { headers })).status, 403);
  } finally {
    registry.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
