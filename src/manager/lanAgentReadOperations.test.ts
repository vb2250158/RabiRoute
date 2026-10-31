import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { createLanAgentReadOperations } from "./lanAgentReadOperations.js";
import { AgentResourceCatalog } from "./agentResourceCatalog.js";
import { LanAgentReleaseStore, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lan-agent-read-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const agentRoot = path.join(root, "agent"); await fs.mkdir(path.join(agentRoot, "lib", "nested"), { recursive: true }); await fs.mkdir(path.join(root, "docs"));
  const bytes = Buffer.from("export const text = 'nested bytes';\n");
  await fs.writeFile(path.join(agentRoot, "package.json"), JSON.stringify({ version: "0.9.1" }));
  await fs.writeFile(path.join(agentRoot, "rabi-agent.mjs"), "export const fixture = true;\n");
  await fs.writeFile(path.join(agentRoot, "lib", "nested", "资料 #.mjs"), bytes);
  await fs.writeFile(path.join(root, "docs", "public.md"), "fixture public document\n");
  await fs.writeFile(path.join(root, "docs", "not-published.md"), "unpublished fixture text\n");
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-read-node");
  const releases = new LanAgentReleaseStore({ rootDir: root, agentRoot });
  const resources = new AgentResourceCatalog({ rootDir: root, publicDocs: ["public.md"] });
  const identity = { applicationGenerationId: "read-fixture-generation", managerInstanceId: "read-fixture-manager", pluginGenerationId: "read-fixture-plugins" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  const registration = registry.registerOperations("reads", createLanAgentReadOperations({ authority, enabled: () => true, releases, resources,
    isManagementRequestAuthorized: () => false,
    isReleaseRequestAuthorized: request => authority.validateBootstrapTicket(String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "")) }));
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  let linkActive = true;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization === "Bearer fixture-rabilink-connection") {
      markAuthenticatedConnectionRequest(request, () => { if (!linkActive) throw new Error("Fixture connection revoked."); });
    } else {
      const access = evaluateLanAgentRequest(request, authority, true);
      if (access.kind === "denied") { response.writeHead(access.status).end(); return; }
      if (access.kind === "agent") markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    }
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await Promise.all([registration.dispose(), discovery.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "dsh", sessionId: "fixture-full-unregistered-session" });
  return { root, agentRoot, authority, releases, resources, registry, registration, credential, client, base, bytes, revokeLink: () => { linkActive = false; } };
}

test("four discovered reads use real resource boundaries and signed nested release bytes without Agent registration", async t => {
  const f = await fixture(t);
  const ids = f.registry.catalogSnapshot().operations.filter(row => row.contract.operationId.startsWith("manager.lan-agent.")); assert.equal(ids.length, 4);
  const listed = await f.client.invokeOperation("manager.lan-agent.resources.list"); assert.equal(listed.statusCode, 200);
  assert.equal(JSON.parse(String(listed.body)).data[0].id, "docs/public.md");
  const read = await f.client.invokeOperation("manager.lan-agent.resources.read", { query: { id: "docs/public.md" } }); assert.equal(read.statusCode, 200);
  const content = JSON.parse(String(read.body)).data; assert.equal(content.content, "fixture public document\n"); assert.equal(content.sha256, createHash("sha256").update(content.content).digest("hex"));
  assert.equal((await f.client.invokeOperation("manager.lan-agent.resources.read", { query: { id: "docs/not-published.md" } })).statusCode, 400);
  const manifestResponse = await f.client.invokeOperation("manager.lan-agent.releases.manifest"); assert.equal(manifestResponse.statusCode, 200);
  const manifest = JSON.parse(String(manifestResponse.body)).release; assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
  const assetPath = "lib/nested/资料 #.mjs";
  const downloaded = await f.client.invokeOperation("manager.lan-agent.releases.asset", { path: { version: manifest.version, platform: manifest.platform, assetPath }, responseMode: "bytes" });
  assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.bodyBytes, f.bytes); assert.equal(downloaded.headers!["content-type"], "text/javascript; charset=utf-8");
  const advertised = manifest.files.find((file: { path: string }) => file.path === assetPath);
  const raw = await fetch(f.base + advertised.downloadUrl, { headers: { authorization: `Bearer ${f.credential.token}` } });
  assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), f.bytes);
  assert.equal((await f.client.invokeOperation("manager.lan-agent.releases.asset", { path: { version: manifest.version, platform: "node", assetPath: "lib/missing.mjs" }, responseMode: "bytes" })).statusCode, 404);
  const ticket = f.authority.issueBootstrapTicket().ticket;
  assert.equal((await fetch(f.base + advertised.downloadUrl, { headers: { authorization: `Bearer ${ticket}` } })).status, 200);
  assert.equal((await fetch(f.base + "/api/lan-agent/resources", { headers: { authorization: `Bearer ${ticket}` } })).status, 401);
  assert.equal((await fetch(f.base + "/api/lan-agent/resources", { headers: { authorization: "Bearer fixture-rabilink-connection" } })).status, 200);
  assert.equal((await fetch(f.base + "/api/lan-agent/resources")).status, 401);
  const serialized = JSON.stringify(f.registry.catalogSnapshot()); assert.equal(serialized.includes(f.credential.token), false); assert.equal(serialized.includes(f.root), false);
});

test("revocation after an awaited resource read suppresses its contents without local fallback", async t => {
  const f = await fixture(t); const original = f.resources.read.bind(f.resources);
  t.mock.method(f.resources, "read", async (id: string) => { const result = await original(id); f.authority.setNodeEnabled("fixture-read-node", false); f.authority.setNodeEnabled("fixture-read-node", true); return result; });
  const response = await f.client.invokeOperation("manager.lan-agent.resources.read", { query: { id: "docs/public.md" } });
  assert.equal(response.statusCode, 403); assert.equal(String(response.body).includes("fixture public document"), false);
});

test("read registration retirement joins an awaited resource owner after client abort", { timeout: 15000 }, async t => {
  const f = await fixture(t); let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { finish = resolve; });
  t.after(() => finish()); const original = f.resources.read.bind(f.resources);
  t.mock.method(f.resources, "read", async (id: string) => { started(); await blocked; return original(id); });
  const controller = new AbortController(); const request = f.client.invokeOperation("manager.lan-agent.resources.read", { query: { id: "docs/public.md" }, signal: controller.signal });
  await entered; controller.abort(); await request;
  let retired = false; const stopped = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false); assert.ok(f.registration.activeOperationCount() > 0);
  finish(); await stopped; assert.equal(f.registration.activeOperationCount(), 0);
});

test("authenticated node selection isolates manifests and immutable downloads without restricting public access", async t => {
  const f = await fixture(t);
  const original = f.releases.publication(), common = f.releases.manifest();
  const candidate = path.join(f.root, "candidate"); await fs.cp(f.agentRoot, candidate, { recursive: true });
  const fixed = Buffer.from("export const nodeOnlyFix = true;\n");
  await fs.writeFile(path.join(candidate, "lib/nested/资料 #.mjs"), fixed);
  const imported = f.releases.importRelease(candidate);
  f.releases.assignRelease(f.credential.nodeId, imported.releaseDigest, original.releaseDigest);
  const other = f.authority.enroll(f.authority.issueBootstrapTicket().ticket, "fixture-other-node");
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const readManifest = async (token: string, query = "") => {
    const response = await fetch(f.base + "/api/lan-agent/releases/manifest" + query, { headers: headers(token) });
    assert.equal(response.status, 200); return (await response.json() as { release: typeof common }).release;
  };
  const selected = await readManifest(f.credential.token);
  assert.equal(verifyLanAgentReleaseManifest(selected, common.publicKeySha256), true);
  assert.deepEqual(await readManifest(other.token, "?nodeId=fixture-read-node"), common);
  assert.deepEqual(await readManifest(f.authority.issueBootstrapTicket().ticket), common);
  assert.deepEqual(await readManifest("fixture-rabilink-connection"), common);
  const entry = selected.files.find(file => file.path === "lib/nested/资料 #.mjs"); assert.ok(entry);
  const selectedBytes = await fetch(f.base + entry.downloadUrl, { headers: headers(f.credential.token) });
  assert.equal(selectedBytes.status, 200); assert.deepEqual(Buffer.from(await selectedBytes.arrayBuffer()), fixed);
  f.releases.assignRelease(f.credential.nodeId, null, imported.releaseDigest);
  const inFlight = await fetch(f.base + entry.downloadUrl, { headers: headers(f.credential.token) });
  assert.equal(inFlight.status, 200); assert.deepEqual(Buffer.from(await inFlight.arrayBuffer()), fixed);
  const commonEntry = common.files.find(file => file.path === entry.path); assert.ok(commonEntry);
  const unchanged = await fetch(f.base + commonEntry.downloadUrl, { headers: headers(other.token) });
  assert.equal(unchanged.status, 200); assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()), f.bytes);
  assert.equal((await fetch(f.base + commonEntry.downloadUrl + "?release=" + "f".repeat(64), { headers: headers(other.token) })).status, 404);
  // Version selection is not a per-feature grant: other authenticated nodes retain every public read.
  assert.equal((await fetch(f.base + "/api/lan-agent/resources", { headers: headers(other.token) })).status, 200);
  f.authority.setNodeEnabled(f.credential.nodeId, false);
  assert.equal((await fetch(f.base + entry.downloadUrl, { headers: headers(f.credential.token) })).status, 403);
});
