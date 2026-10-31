import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";
import { LanAgentNodeNameConflictError, type LanAgentRegistry } from "./lanAgentRegistry.js";
import type { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { handleLanAgentApiFixture as handleLanAgentApi } from "./lanAgentRouteTestSupport.js";
import { createLanAgentReadOperations } from "./lanAgentReadOperations.js";
import { parseApiPathTemplate } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { webguiRequestToken, webguiTokenMatches } from "./webguiLanAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

const PLACEHOLDER_REQUEST_VALUE = "test-only-placeholder-lan-management";

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T;
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength)
  });
  response.end(payload);
}

async function startServer(verifiedConnection = false) {
  let updateRequests = 0;
  let name = "";
  const registry = {
    listNodes: () => [{ nodeId: "node-a", connected: true }],
    listTasks: () => [],
    listInstances: () => [{ instanceId: "node-a", name, local: false, connected: false, agents: [] }],
    setNodeName: (nodeId: string, nextName: unknown, expectedName: string) => {
      if (name !== expectedName) throw new LanAgentNodeNameConflictError();
      if (typeof nextName !== "string") throw new Error("Invalid name");
      name = nextName.trim();
      return { nodeId, name, connected: false };
    },
    requestUpdate: (nodeId: string, version: string) => {
      updateRequests += 1;
      return { nodeId, targetVersion: version, updateState: "requested", connected: true };
    },
    assignTask: () => { throw new Error("not used"); }
  } as unknown as LanAgentRegistry;
  const releases = {
    manifest: () => ({ version: "0.1.0", publicKeySha256: "a".repeat(64) }),
    nodeReleaseDigests: (nodeIds: readonly string[]) => new Map(nodeIds.map(nodeId => [nodeId, "a".repeat(64)]))
  } as unknown as LanAgentReleaseStore;
  const server = http.createServer((request, response) => {
    if (verifiedConnection) markAuthenticatedConnectionRequest(request);
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!handleLanAgentApi(request, requestUrl, response, {
      readJsonBody,
      jsonResponse,
      isReleaseRequestAuthorized: () => false,
      isManagementRequestAuthorized: (candidate, candidateUrl) => (
        webguiTokenMatches(webguiRequestToken(candidate, candidateUrl), PLACEHOLDER_REQUEST_VALUE)
      ),
      registry,
      releases
    })) response.writeHead(404).end();
  });
  const endpoint = await listenManagerEndpoint({
    server,
    host: "127.0.0.1",
    policy: { mode: "auto" }
  });
  return {
    baseUrl: endpoint.baseUrl,
    updateRequests: () => updateRequests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

test("LAN Agent management reuses an authenticated connection without another WebGUI token", async () => {
  const app = await startServer(true);
  try {
    assert.equal((await fetch(`${app.baseUrl}/api/lan-agent/nodes`)).status, 200);
    const result = await fetch(`${app.baseUrl}/api/lan-agent/nodes/node-a/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "0.2.0" }) });
    assert.equal(result.status, 202);
    assert.equal(app.updateRequests(), 1);
  } finally { await app.close(); }
});

test("LAN Agent management rejects unauthenticated loopback reads and writes", async () => {
  const app = await startServer();
  try {
    const nodes = await fetch(`${app.baseUrl}/api/lan-agent/nodes`);
    assert.equal(nodes.status, 401);
    assert.equal((await nodes.json() as { error?: unknown }).error, "LAN_AGENT_MANAGEMENT_AUTH_REQUIRED");

    const update = await fetch(`${app.baseUrl}/api/lan-agent/nodes/node-a/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.0" })
    });
    assert.equal(update.status, 401);
    assert.equal(app.updateRequests(), 0);
  } finally {
    await app.close();
  }
});

test("LAN Agent management accepts the explicit WebGUI token", async () => {
  const app = await startServer();
  try {
    const nodes = await fetch(`${app.baseUrl}/api/lan-agent/nodes`, {
      headers: { "x-rabiroute-webgui-token": PLACEHOLDER_REQUEST_VALUE }
    });
    assert.equal(nodes.status, 200);
    assert.deepEqual((await nodes.json() as { nodes?: unknown }).nodes, [{ nodeId: "node-a", connected: true, releaseDigest: "a".repeat(64) }]);

    const update = await fetch(`${app.baseUrl}/api/lan-agent/nodes/node-a/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rabiroute-webgui-token": PLACEHOLDER_REQUEST_VALUE
      },
      body: JSON.stringify({ version: "0.2.0" })
    });
    assert.equal(update.status, 202);
    assert.equal(app.updateRequests(), 1);
  } finally {
    await app.close();
  }
});

test("node renaming requires management auth and a current name, with independent catalog readback", async () => {
  const app = await startServer();
  const url = `${app.baseUrl}/api/lan-agent/instances/node-a/name`;
  const headers = { "content-type": "application/json", "x-rabiroute-webgui-token": PLACEHOLDER_REQUEST_VALUE };
  try {
    const denied = await fetch(url, { method: "PUT", body: JSON.stringify({ name: "Worker PC", expectedName: "" }) });
    assert.equal(denied.status, 401);
    const missingVersion = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ name: "Worker PC" }) });
    assert.equal(missingVersion.status, 400);
    const renamed = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ name: "Worker PC", expectedName: "" }) });
    assert.equal(renamed.status, 200);
    const stale = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ name: "Stale PC", expectedName: "" }) });
    assert.equal(stale.status, 409);
    const catalog = await fetch(`${app.baseUrl}/api/lan-agent/instances`, { headers });
    assert.equal((await catalog.json() as { instances: Array<{ name: string }> }).instances[0]?.name, "Worker PC");
  } finally { await app.close(); }
});

const releaseTargets = ["/api/lan-agent/releases/manifest", "/api/lan-agent/releases/0.2.0/node/rabi-agent.mjs"];

function releaseFixture(authority?: LanAgentAuthority) {
  let reads = 0;
  let releaseAuthorized = false;
  const context = {
    readJsonBody, jsonResponse, authority, enabled: () => true,
    isManagementRequestAuthorized: () => false,
    isReleaseRequestAuthorized: () => releaseAuthorized,
    registry: {} as LanAgentRegistry,
    releases: {
      manifest: () => { reads++; return { version: "0.2.0" }; },
      readAsset: (version: string, platform: string, assetPath: string) => {
        reads++;
        assert.deepEqual([version, platform, assetPath], ["0.2.0", "node", "rabi-agent.mjs"]);
        return Buffer.from("export const release = 'fixture';");
      }
    } as unknown as LanAgentReleaseStore
  };
  return {
    reads: () => reads,
    allowRelease: () => { releaseAuthorized = true; },
    request: (target: string, headers: http.IncomingHttpHeaders = {}) => ({
      method: "GET", url: target, headers, socket: { remoteAddress: "127.0.0.1" }
    } as http.IncomingMessage),
    handle: async (request: http.IncomingMessage) => {
      const url = new URL(request.url!, "http://manager.invalid");
      const operation = createLanAgentReadOperations(context).find(value => parseApiPathTemplate(value.contract.pathTemplate, value.contract.request.pathTails).pattern.test(url.pathname))!;
      const template = parseApiPathTemplate(operation.contract.pathTemplate, operation.contract.request.pathTails), match = template.pattern.exec(url.pathname)!;
      const path = Object.fromEntries(template.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
      const result = await operation.handler({ request, response: {} as http.ServerResponse, url, path, query: {}, body: undefined });
      return { status: result.status, body: Buffer.isBuffer(result.body) ? result.body.toString() : JSON.stringify(result.body) };
    }
  };
}

test("release manifest and assets reuse authenticated local and RabiLink connections", async () => {
  for (const kind of ["local", "rabilink"]) {
    const fixture = releaseFixture();
    let active = true;
    for (const target of releaseTargets) {
      const request = fixture.request(target);
      markAuthenticatedConnectionRequest(request, () => { if (!active) throw new Error(`${kind} connection revoked`); });
      const result = await fixture.handle(request);
      assert.equal(result.status, 200);
      assert.match(result.body, target.endsWith("manifest") ? /"version":"0.2.0"/ : /export const release/);
      active = false;
      const before = fixture.reads();
      await assert.rejects(() => fixture.handle(request), /connection revoked/);
      assert.equal(fixture.reads(), before);
      active = true;
    }
  }
});

test("release endpoints reject bare or forged requests and preserve bootstrap/node authorization", async () => {
  const fixture = releaseFixture();
  for (const target of releaseTargets) {
    assert.equal((await fixture.handle(fixture.request(target))).status, 401);
    assert.equal((await fixture.handle(fixture.request(target, { "x-rabiroute-authenticated": "true" }))).status, 401);
  }
  assert.equal(fixture.reads(), 0);
  fixture.allowRelease();
  for (const target of releaseTargets) assert.equal((await fixture.handle(fixture.request(target))).status, 200);
  assert.equal(fixture.reads(), 2);
});

test("release endpoints admit enabled Agents but reject disabled and revoked leases before reading", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-release-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  const fixture = releaseFixture(authority);
  const admit = (target: string) => {
    const request = fixture.request(target, { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" });
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    return request;
  };
  for (const target of releaseTargets) assert.equal((await fixture.handle(admit(target))).status, 200);
  const disabled = releaseTargets.map(admit);
  authority.setNodeEnabled("node-fixture", false);
  fixture.allowRelease(); // The node download channel must not override an explicitly disabled Agent identity.
  authority.setNodeEnabled("node-fixture", true);
  for (const request of disabled) assert.equal((await fixture.handle(request)).status, 403);
  for (const request of disabled) assert.equal((await fixture.handle(request)).status, 403);
  const revoked = releaseTargets.map(admit);
  authority.revokeNode("node-fixture");
  for (const request of revoked) assert.equal((await fixture.handle(request)).status, 403);
  assert.equal(fixture.reads(), 2);
});
