import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { handleLanAgentApiFixture as handleLanAgentApi } from "./lanAgentRouteTestSupport.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { AgentResourceCatalog } from "./agentResourceCatalog.js";

test("HTTP enrollment and credential recovery expose public resources without any Agent registration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-access-http-"));
  fs.mkdirSync(path.join(root, "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example fixture\n---\nRead the API contract.");
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const binding = { agentId: "worker", name: "Fixture", provider: "dsh", enabled: true, sessionId: "session-fixture" };
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ schemaVersion: 2, nodes: [{ nodeId: "node-fixture", version: "1", platform: "fixture", agents: [binding] }], tasks: [] }));
  const registry = new LanAgentRegistry({ statePath: path.join(root, "registry.json") });
  const server = http.createServer((request, response) => {
    if (request.url === "/.well-known/rabiroute-manager" || request.url === "/meta") {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (request.url === "/meta" && !authority.authenticate(token)) { response.writeHead(401).end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0, data: { protocolVersion: "1", guid: "fixture-stable-guid", rabiGuid: "fixture-stable-guid",
        applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance", health: { live: true, requiredReady: true, state: "healthy" } } }));
      return;
    }
    const handled = handleLanAgentApi(request, new URL(request.url!, "http://fixture.invalid"), response, {
      authority, registry, resources: new AgentResourceCatalog({ rootDir: root, publicDocs: [] }), enabled: () => true,
      managerIdentity: () => ({ guid: "fixture-stable-guid", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance", health: { live: true, requiredReady: true, state: "healthy" } }),
      releases: { manifest: () => ({version:"fixture",publicKeySha256:"a".repeat(64)}),
        nodeReleaseDigests: (ids: readonly string[]) => new Map(ids.map(id => [id, "b".repeat(64)])) } as unknown as LanAgentReleaseStore,
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
    const headers = { authorization: `Bearer ${token}`, "x-rabiroute-agent-type":"dsh", "x-rabiroute-session-id":"never-registered" };
    const listed=await fetch(`${base}/api/lan-agent/resources`,{headers});assert.equal(listed.status,200);assert.equal((await listed.json()).data[0].id,"skills/example/SKILL.md");
    assert.equal((await fetch(`${base}/api/lan-agent/nodes`,{headers})).status,200);
    assert.equal((await fetch(`${base}/api/lan-agent/resources/read?id=..%2Fauthority.json`,{headers})).status,400);
    assert.equal((await fetch(`${base}/api/lan-agent/instances/node-fixture/agents/worker/authorization`,{method:"PUT",headers:{"x-rabiroute-webgui-token":"fixture-admin"}})).status,404);
    const renamed=await fetch(`${base}/api/lan-agent/instances/node-fixture/name`,{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({name:"Test computer",expectedName:""})});assert.equal(renamed.status,200,"enrollment credential renames a computer without browser login");
    const instanceView=await (await fetch(`${base}/api/lan-agent/instances`,{headers})).json();assert.equal(instanceView.instances.find((n:any)=>n.instanceId==="node-fixture").enabled,true);
    const off=await fetch(`${base}/api/lan-agent/instances/node-fixture/enabled`,{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({enabled:false,expectedEnabled:true})});assert.equal(off.status,403,"Production response authority suppresses results after self-revocation.");assert.equal((await off.json()).uncertain,true);assert.equal(authority.isNodeEnabled("node-fixture"),false,"The original mutation committed; do not resend it.");assert.equal((await fetch(`${base}/api/lan-agent/resources`,{headers})).status,403);
    const on=await fetch(`${base}/api/lan-agent/instances/node-fixture/enabled`,{method:"PUT",headers:{"x-rabiroute-webgui-token":"fixture-admin","content-type":"application/json"},body:JSON.stringify({enabled:true,expectedEnabled:false})});assert.equal(on.status,200);assert.equal((await fetch(`${base}/api/lan-agent/resources`,{headers})).status,200);
    const repairTicket=authority.issueBootstrapTicket().ticket;
    const repair=await fetch(`${base}/api/lan-agent/enroll`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ticket:repairTicket,nodeId:"node-fixture",enrollmentSecret:"r".repeat(43)})});assert.equal(repair.status,201);
    assert.equal((await fetch(`${base}/api/lan-agent/self`,{headers:{authorization:`Bearer ${token}`}})).status,403);
    const clientModuleUrl = pathToFileURL(path.resolve("apps/rabi-agent/rabi-agent.mjs")).href;
    const { __test: client } = await import(clientModuleUrl);
    const configPath = path.join(root, "client-config.json");
    const saved = { schemaVersion: 1, managerUrl: base, managerGuid: "fixture-stable-guid", nodeId: "node-fixture", nodeCredential: token,
      agents: [binding], defaultWorkspace: fs.realpathSync(root), allowedWorkspaces: [fs.realpathSync(root)], releasePublicKeySha256: "a".repeat(64) };
    fs.writeFileSync(configPath, JSON.stringify(saved));
    const variables: Record<string, string | undefined> = { RABI_MANAGER_URL: base, RABI_AGENT_BOOTSTRAP_TICKET: authority.issueBootstrapTicket().ticket,
      RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256: "a".repeat(64), RABI_AGENT_TYPE: undefined, RABI_AGENT_CODEX_THREAD_ID: undefined };
    const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(variables)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    let exchanges = 0;
    try {
      const connected = await client.bootstrapConfig(configPath, async (url: string, init: RequestInit) => {
        const result = await fetch(url, init);
        if (String(url).endsWith("/enroll")) { exchanges++; assert.equal(result.status, 201); await result.arrayBuffer(); throw new Error("Fixture lost exchange response"); }
        return result;
      });
      assert.equal(connected.nodeId, saved.nodeId); assert.equal(connected.agents[0].sessionId, undefined);
      assert.deepEqual(authority.authenticate(connected.nodeCredential), { nodeId: saved.nodeId });
      assert.ok(authority.acquireConnectionLease(connected.nodeCredential));
      assert.equal(exchanges, 1); assert.equal(fs.existsSync(`${configPath}.enrollment.json`), false);
      assert.equal(authority.getSnapshot().nodes.length, 1);
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  } finally {
    registry.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
