import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { createLanAgentManagementOperations, type LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { createLanAgentReadOperations } from "./lanAgentReadOperations.js";
import { createLanAgentConnectionOperation } from "./lanAgentConnectionOperation.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
test("headless instance lists sessions and dispatches an explicit target without rebinding the Agent", { timeout: 30_000 }, async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rabi-instance-e2e-")));
  const sessions: string[] = [];
  const httpDiagnostic: string[] = [];
  const read = async <T>(request: http.IncomingMessage): Promise<T> => { let raw = ""; for await (const chunk of request) raw += chunk; return JSON.parse(raw || "{}"); };
  const dsh = http.createServer(async (request, response) => {
    const body = await read<{ rpcId: string; method: string; payload: { sessionId: string } }>(request);
    if (body.method === "session.prompt") sessions.push(body.payload.sessionId);
    const value = body.method === "session/list" ? { items: ["session-11111111-1111-4111-8111-111111111111", "session-22222222-2222-4222-8222-222222222222", "session-33333333-3333-4333-8333-333333333333"].map(sessionId => ({ sessionId, cwd: directory, updatedAt: Date.now(), projections: { values: { title: sessionId === "session-33333333-3333-4333-8333-333333333333" ? "Managed task" : sessionId } } })) } : {};
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } }));
  });
  const dshUrl = await listen(dsh);
  const authority = new LanAgentAuthority({ statePath: path.join(directory, "authority.json") });
  const nodeId = "remote-fixture";
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, nodeId);
  const registry = new LanAgentRegistry({
    statePath: path.join(directory, "registry.json"),
    authenticateNode: token => authority.authenticate(token),
  });
  const identity = { guid: "headless-fixture-guid", applicationGenerationId: "headless-fixture-generation", managerInstanceId: "headless-fixture-manager", pluginGenerationId: "headless-fixture-plugins" };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const context: LanAgentRoutesContext = {
    authority, enabled: () => true, registry, releases: {} as LanAgentReleaseStore, readJsonBody: read,
    managerIdentity: () => ({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } }),
    isReleaseRequestAuthorized: () => false,
    isManagementRequestAuthorized: request => request.headers.authorization === "Bearer test-instance",
    jsonResponse: (response, code, body) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
  };
  const operations = api.registerOperations("fixture.connector", [...createLanAgentReadOperations(context), ...createLanAgentManagementOperations(context)]);
  const upgrades = api.registerUpgrades("fixture.connector", [createLanAgentConnectionOperation(registry, { enabled: () => true, getToken: () => "test-instance" })]);
  const discovery = api.registerOperations("fixture.discovery", createApiDiscoveryOperations(api));
  const manager = http.createServer((request, response) => {
    response.once("finish", () => { httpDiagnostic.push(`${request.method} ${new URL(request.url!, "http://fixture.invalid").pathname} ${response.statusCode}`); });
    if (request.url === "/.well-known/rabiroute-manager") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: { protocolVersion: 1, guid: "headless-fixture-guid", applicationGenerationId: "headless-fixture-generation", managerInstanceId: "headless-fixture-manager" } }));
      return;
    }
    if (request.url === "/meta") {
      const access = evaluateLanAgentRequest(request, authority, true);
      const allowed = access.kind === "agent" || (access.kind === "unrelated" && request.headers.authorization === `Bearer ${credential.token}`);
      response.writeHead(allowed ? 200 : 403, { "content-type": "application/json" });
      response.end(JSON.stringify(allowed
        ? { rabiGuid: "headless-fixture-guid", applicationGenerationId: "headless-fixture-generation", managerInstanceId: "headless-fixture-manager", health: { live: true, requiredReady: true, state: "healthy" } }
        : { code: -1 }));
      return;
    }
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind === "denied") { response.writeHead(access.status).end(); return; }
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!api.handle(request, url, response)) response.writeHead(404).end();
  });
  manager.on("upgrade", (request, socket, head) => {
    if (!api.handleUpgrade(request, new URL(request.url!, "http://localhost"), socket, head)) socket.destroy();
  });
  const managerUrl = await listen(manager);
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, managerUrl, nodeCredential: credential.token, nodeId, releasePublicKeySha256: "a".repeat(64), agents: [], defaultWorkspace: directory, allowedWorkspaces: [directory] }));
  // The test owns the actual connector through IPC, rather than observing only a launcher parent.
  const worker = spawn(process.execPath, [path.resolve("apps/rabi-agent/rabi-agent.mjs"), "--run", "--config", configPath], {
    windowsHide: true, env: { ...process.env, RABI_AGENT_SUPERVISED: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let workerDiagnostic = "";
  for (const stream of [worker.stdout!, worker.stderr!]) stream.on("data", chunk => { workerDiagnostic = (workerDiagnostic + String(chunk)).slice(-4096).replaceAll(credential.token, "<redacted>"); });
  // Observe completion immediately; an early configuration failure must not leave
  // finally waiting for an event that already happened.
  let workerEnded = false;
  const workerStopped = new Promise<void>(resolve => {
    worker.once("close", () => { workerEnded = true; resolve(); });
    worker.once("error", error => { workerEnded = true; workerDiagnostic = (workerDiagnostic + error.message).slice(-4096).replaceAll(credential.token, "<redacted>"); resolve(); });
  });
  const request = async (suffix: string, body: unknown) => {
    const response = await fetch(`${managerUrl}/api/lan-agent/instances/remote-fixture/agents${suffix}`, { method: "POST", headers: { authorization: "Bearer test-instance", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { response, body: await response.json() as any };
  };
  try {
    const help = await fetch(`${managerUrl}/api/agent/help`, { headers: { authorization: `Bearer ${credential.token}` } });
    assert.equal(help.status, 200);
    const published = (await help.json() as any).data;
    assert.equal(published.applicationGenerationId, identity.applicationGenerationId);
    assert.equal(published.managerInstanceId, identity.managerInstanceId);
    assert.equal(published.operations.find((entry: any) => entry.id === "manager.lan-agent.connect")?.contract.transport, "websocket");
    const connectingAt = Date.now();
    const deadline = Date.now() + 20_000;
    while (!registry.listNodes()[0]?.connected && !workerEnded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(registry.listNodes()[0]?.connected, true, JSON.stringify({ workerDiagnostic, exitCode: worker.exitCode, signalCode: worker.signalCode, httpDiagnostic }));
    const connectorReadyMs = Date.now() - connectingAt;
    const created = await request("", { provider: "dsh", dshBaseUrl: dshUrl, name: "Second Agent", workspace: directory });
    assert.equal(created.body.code, 0);
    const second = created.body.result.find((agent: any) => agent.name === "Second Agent");
    assert.ok(second.agentId);
    for (const body of [{ message: "missing type", threadId: "session-explicit" }, { message: "missing id", provider: "dsh" }]) {
      assert.equal((await request(`/${second.agentId}/tasks`, body)).response.status, 400);
    }
    const sent = await request(`/${second.agentId}/tasks`, { message: "fixture message", provider: "dsh", threadId: "session-33333333-3333-4333-8333-333333333333", idempotencyKey: "delivery-1" });
    assert.equal(sent.body.result.status, "progress");
    await request(`/${second.agentId}/tasks`, { message: "fixture message", provider: "dsh", threadId: "session-33333333-3333-4333-8333-333333333333", idempotencyKey: "delivery-1" });
    assert.deepEqual(sessions, ["session-33333333-3333-4333-8333-333333333333"]);
    const legacyTarget = await fetch(`${managerUrl}/api/lan-agent/nodes/${nodeId}/tasks`, { method: "POST",
      headers: { authorization: "Bearer test-instance", "content-type": "application/json" },
      body: JSON.stringify({ agentId: second.agentId, threadId: "session-33333333-3333-4333-8333-333333333333", message: "missing provider" }) });
    assert.equal(legacyTarget.status, 400);
    assert.deepEqual(sessions, ["session-33333333-3333-4333-8333-333333333333"]);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.find((agent: any) => agent.agentId === second.agentId).sessionId, undefined);
    const listed = await request(`/${second.agentId}/threads`, { action: "list", agentAdapter: "dsh", limit: 100, offset: 0 });
    assert.equal(listed.body.result.statusCode, 200, JSON.stringify(listed.body));
    assert.ok(JSON.stringify(listed.body.result.data).includes("session-33333333-3333-4333-8333-333333333333"));
    assert.equal((await request(`/${second.agentId}/threads`, { action: "list" })).response.status, 400);
    const readTask = await request(`/${second.agentId}/threads`, { action: "read", agentAdapter: "dsh", threadId: "session-22222222-2222-4222-8222-222222222222" });
    assert.equal(readTask.body.code, 0, JSON.stringify(readTask.body));
    assert.equal(readTask.body.result.statusCode, 200);
    assert.equal(readTask.body.result.data.thread.id, "session-22222222-2222-4222-8222-222222222222");
    const managed = await request(`/${second.agentId}/threads`, { action: "resolve", agentAdapter: "dsh", title: "Managed task", cwd: directory, createIfMissing: false });
    assert.equal(managed.body.code, 0, JSON.stringify(managed.body));
    assert.equal(managed.body.result.statusCode, 200);
    assert.equal(managed.body.result.data.thread.id, "session-33333333-3333-4333-8333-333333333333");
    assert.deepEqual(registry.getInstanceAgent("remote-fixture", second.agentId)?.managedSessionIds, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.find((agent: any) => agent.agentId === second.agentId).managedSessionIds, undefined);
    const changed = await request(`/${second.agentId}/configure`, { enabled: false });
    assert.equal(changed.response.status, 200);
    assert.equal(authority.authenticate(credential.token)?.nodeId, nodeId, "backend settings never revoke public API access");
    const retired = await fetch(`${managerUrl}/api/lan-agent/instances/${nodeId}/agents/${second.agentId}/authorization`, {method:"PUT",headers:{authorization:"Bearer test-instance"}});
    assert.equal(retired.status,404);
    assert.deepEqual(sessions,["session-33333333-3333-4333-8333-333333333333"]);
    t.diagnostic(JSON.stringify({ managerUrl, identity, connectorReadyMs, dispatchedSession: sessions[0], dispatchCount: sessions.length,
      configuredSession: JSON.parse(fs.readFileSync(configPath, "utf8")).agents.find((agent: any) => agent.agentId === second.agentId).sessionId ?? null }));
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await workerStopped;
    upgrades.stopAccepting();
    await operations.dispose(); await discovery.dispose(); await upgrades.dispose();
    registry.close();
    await Promise.all([new Promise(resolve => manager.close(resolve)), new Promise(resolve => dsh.close(resolve))]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
