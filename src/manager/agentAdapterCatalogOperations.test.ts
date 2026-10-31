import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { AgentAdapterCatalogService } from "./agentAdapterCatalog.js";
import { createAgentAdapterCatalogOperations } from "./agentAdapterCatalogOperations.js";
import type { AgentAdapterCatalogWorkerPool } from "./agentAdapterCatalogWorkerPool.js";
import type { AgentAdapterCatalogWorkerTask } from "./agentAdapterCatalogWorker.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { DshConnectionStore } from "../dshConnectionStore.js";
import { handleDshConnectionRequest } from "./dshConnectionRoutes.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

test("executable adapter catalog and connection routes share owner normalization, revision fences and authenticated remote success", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-adapter-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: value => Buffer.from(value).toString("base64"), unprotect: value => Buffer.from(value, "base64").toString()
  });
  const origin = "http://127.0.0.1:39277";
  store.connect(origin, { cookie: "dsh-auth-fixture=fixture", expiresAt: Date.now() + 60000 }, 0);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "agents.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const observed: AgentAdapterCatalogWorkerTask[] = [];
  const manifest = { type: "codex" as const, label: "Fixture", maturity: "experimental" as const,
    transport: { protocol: "fixture", mode: "request" }, capabilities: {} };
  const service = new AgentAdapterCatalogService({ rootDir: root, getRuntimes: () => [], listManifests: async () => [manifest],
    workerPool: { async query(task: AgentAdapterCatalogWorkerTask) {
      observed.push(task);
      const kind = task.kind === "all" ? "codex" : task.kind;
      return { agents: { [kind]: { ...manifest, type: kind, installed: true, sessions: [{ id: "original", name: "Original task" }], models: [] } }, cwdOptions: [] };
    }, async stop() {}, async drain() {} } as unknown as AgentAdapterCatalogWorkerPool });
  service.connectionOperation = (request, url, body) => handleDshConnectionRequest(request, url, store, undefined, body);
  let hookUpdates = 0;
  service.updateHooks = async adapter => { assert.equal(adapter, "codex"); hookUpdates++; return { message: "fixture update completed" }; };
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("adapter-catalog", createAgentAdapterCatalogOperations(service));
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://localhost").pathname, body,
      assertTrustedLanAgentPrincipal(request)?.source));
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${credential.token}` };
  const call = (target: string, options?: RequestInit) => fetch(base + target, { ...options, headers: { ...headers, ...options?.headers } });
  const catalog = await call("/api/agent-adapters/catalog"); assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).data.adapters, [manifest]);
  for (const target of ["/api/scan/agents?codexLimit=12&dshOffset=2", "/api/scan/agents/dsh?dshLimit=9", "/api/scan/agents/grokBot?grokBotOffset=20"]) {
    const response = await call(target); assert.equal(response.status, 200); assert.ok((await response.json()).agents);
  }
  const [all, dsh, grok] = observed;
  assert.ok(all?.kind === "all"); assert.ok(dsh?.kind === "dsh"); assert.ok(grok?.kind === "grokBot");
  assert.equal(all.options.codexLimit, 12); assert.equal(all.options.dshOffset, 2);
  assert.equal(dsh.options.dshLimit, 9); assert.equal(grok.options.grokBotOffset, 20);
  const list = await call("/api/agent-adapters/dsh/connections"); assert.equal(list.status, 200);
  const wire = await list.text(); assert.ok(!wire.includes("dsh-auth") && !wire.includes("fixture"));
  assert.equal(JSON.parse(wire).endpoints[0].state, "saved");
  const target = "/api/agent-adapters/dsh/connection";
  const read = await call(`${target}?baseUrl=${encodeURIComponent(origin)}`); assert.equal(read.status, 200);
  assert.equal((await read.json()).connection.baseUrl, origin);
  const disconnect = (expectedRevision: number) => call(target, { method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: origin, expectedRevision }) });
  assert.equal((await disconnect(0)).status, 409);
  const removed = await disconnect(1); assert.equal(removed.status, 200); assert.equal((await removed.json()).revision, 2);
  assert.equal(store.resolve(origin)?.state, "disconnected");
  const invalid = await call(target, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: origin, launchUrl: "invalid", expectedRevision: 2 }) });
  assert.equal(invalid.status, 400); assert.equal(store.readMetadata().revision, 2);
  const oversized = await call(target, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ launchUrl: "x".repeat(16384), expectedRevision: 2 }) }); assert.equal(oversized.status, 413);
  const update = await call("/api/agent-adapters/hooks/update?adapter=codex", { method: "POST" }); assert.equal(update.status, 200); assert.equal(hookUpdates, 1);
  assert.equal((await call("/api/scan/agents?codexLimit=1&codexLimit=2")).status, 400); assert.equal(observed.length, 3);
  authority.revokeNode("fixture-node");
  assert.equal((await disconnect(2)).status, 403); assert.equal(store.readMetadata().revision, 2);
});

test("a real closed scan response cancels even after Node marks it destroyed", async t => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const service = { scanAll: async (_options: unknown, signal: AbortSignal) => {
    started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true }));
    return { agents: {}, cwdOptions: [] };
  } } as unknown as AgentAdapterCatalogService;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("scan-cancel", createAgentAdapterCatalogOperations(service));
  const server = http.createServer((request, response) => { registry.handle(request, new URL(request.url!, "http://localhost"), response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = http.get(`http://127.0.0.1:${address.port}/api/scan/agents`); request.on("error", () => undefined);
  await running; request.destroy();
  await Promise.race([stopped, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Client close did not cancel the owner scan")), 2000); timer.unref(); })]);
  await registration.dispose(); assert.equal(registration.activeOperationCount(), 0);
});
