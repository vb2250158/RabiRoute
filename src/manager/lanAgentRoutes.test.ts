import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";
import { LanAgentNodeNameConflictError, type LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentReleaseStore, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";
import { handleLanAgentApi } from "./lanAgentRoutes.js";
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
      return { nodeId, name };
    },
    requestUpdate: (nodeId: string, version: string) => {
      updateRequests += 1;
      return { nodeId, targetVersion: version, updateState: "requested" };
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
    handle: (request: http.IncomingMessage) => {
      let status = 0;
      let body = "";
      const response = {
        set statusCode(value: number) { status = value; },
        setHeader() {},
        writeHead(value: number) { status = value; },
        end(value: Buffer | string) { body = String(value); }
      } as unknown as http.ServerResponse;
      assert.equal(handleLanAgentApi(request, new URL(request.url!, "http://manager.invalid"), response, context), true);
      return { status, body };
    }
  };
}

test("release manifest and assets reuse authenticated local and RabiLink connections", () => {
  for (const kind of ["local", "rabilink"]) {
    const fixture = releaseFixture();
    let active = true;
    for (const target of releaseTargets) {
      const request = fixture.request(target);
      markAuthenticatedConnectionRequest(request, () => { if (!active) throw new Error(`${kind} connection revoked`); });
      const result = fixture.handle(request);
      assert.equal(result.status, 200);
      assert.match(result.body, target.endsWith("manifest") ? /"version":"0.2.0"/ : /export const release/);
      active = false;
      const before = fixture.reads();
      assert.throws(() => fixture.handle(request), /connection revoked/);
      assert.equal(fixture.reads(), before);
      active = true;
    }
  }
});

test("release endpoints reject bare or forged requests and preserve bootstrap/node authorization", () => {
  const fixture = releaseFixture();
  for (const target of releaseTargets) {
    assert.equal(fixture.handle(fixture.request(target)).status, 401);
    assert.equal(fixture.handle(fixture.request(target, { "x-rabiroute-authenticated": "true" })).status, 401);
  }
  assert.equal(fixture.reads(), 0);
  fixture.allowRelease();
  for (const target of releaseTargets) assert.equal(fixture.handle(fixture.request(target)).status, 200);
  assert.equal(fixture.reads(), 2);
});

test("release endpoints admit enabled Agents but reject disabled and revoked leases before reading", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-release-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "custom-provider" }]);
  const fixture = releaseFixture(authority);
  const admit = (target: string) => {
    const request = fixture.request(target, { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" });
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    return request;
  };
  for (const target of releaseTargets) assert.equal(fixture.handle(admit(target)).status, 200);
  const disabled = releaseTargets.map(admit);
  authority.setAgentEnabled("node-fixture", "worker", false);
  fixture.allowRelease(); // The node download channel must not override an explicitly disabled Agent identity.
  for (const request of disabled) assert.equal(fixture.handle(request).status, 403);
  authority.setAgentEnabled("node-fixture", "worker", true);
  for (const request of disabled) assert.equal(fixture.handle(request).status, 403);
  const revoked = releaseTargets.map(admit);
  authority.revokeNode("node-fixture");
  for (const request of revoked) assert.equal(fixture.handle(request).status, 403);
  assert.equal(fixture.reads(), 2);
});

test("native release selection uses one signed owner, stable snapshot URLs and the existing admission contract", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-native-node-release-test-"));
  const commonRoot = path.join(root, "common"), candidateRoot = path.join(root, "candidate");
  for (const directory of [commonRoot, candidateRoot]) {
    fs.mkdirSync(path.join(directory, "lib"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "0.9.1" }));
    fs.writeFileSync(path.join(directory, "rabi-agent.mjs"), "export const fixture = true;\n");
    fs.writeFileSync(path.join(directory, "lib", "worker.mjs"), directory === commonRoot ? "export const fix = false;\n" : "export const fix = true;\n");
  }
  const releases = new LanAgentReleaseStore({ rootDir: root, agentRoot: commonRoot });
  releases.manifest(); // Provision the fixture key before comparing the ordinary persisted-key path.
  const commonManifest = releases.manifest(), commonPublication = releases.publication();
  const selected = releases.importRelease(candidateRoot);
  assert.equal(selected.version, commonPublication.version);
  assert.notEqual(selected.releaseDigest, commonPublication.releaseDigest);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const enroll = (nodeId: string) => authority.enroll(authority.issueBootstrapTicket().ticket, nodeId).token;
  const alpha = enroll("fixture-alpha"), beta = enroll("fixture-beta");
  const unregistered = enroll("fixture-unregistered");
  // HEAD records the source Agent catalog before issuing its original request lease; newer authority owners do not require it.
  for (const token of [alpha, beta]) authority.registerAgentCatalog?.(token, [{ agentId: "fixture-worker", provider: "custom-provider" }]);
  const notifications: Array<{ nodeId: string; version: string }> = [];
  let failNotification = false;
  let accessEnabled = true;
  // Controlled native notification boundary; no remote Agent socket or business operation exists.
  const registry = {
    listNodes: () => [{ nodeId: "fixture-alpha", connected: true }, { nodeId: "fixture-beta", connected: true }],
    listTasks: () => [], listInstances: () => [],
    requestUpdate(nodeId: string, version: string) {
      if (failNotification) throw new Error("Fixture notification unavailable");
      notifications.push({ nodeId, version });
      return { nodeId, targetVersion: version, updateState: "requested" };
    }
  } as unknown as LanAgentRegistry;
  const server = http.createServer((request, response) => {
    try {
      const access = evaluateLanAgentRequest(request, authority, accessEnabled);
      if (access.kind === "denied") { jsonResponse(response, access.status, { code: -1, error: access.error }); return; }
      if (access.kind === "agent") markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
      if (!handleLanAgentApi(request, new URL(request.url ?? "/", "http://localhost"), response, {
        readJsonBody, jsonResponse, authority, enabled: () => accessEnabled, registry, releases,
        isManagementRequestAuthorized: () => false,
        isReleaseRequestAuthorized: candidate => {
          const token = String(candidate.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
          return Boolean(authority.authenticate(token)) || authority.validateBootstrapTicket(token);
        }
      })) response.writeHead(404).end();
    } catch (error) { jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }); }
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`,
    ...(token === alpha || token === beta ? { "x-rabiroute-agent-id": "fixture-worker" } : {}) });
  const readManifest = async (token: string, query = "") => {
    const response = await fetch(base + "/api/lan-agent/releases/manifest" + query, { headers: headers(token) });
    assert.equal(response.status, 200);
    return (await response.json() as { release: ReturnType<LanAgentReleaseStore["manifest"]> }).release;
  };
  const update = async (body: Record<string, unknown>, token = beta) => {
    const response = await fetch(base + "/api/lan-agent/nodes/fixture-alpha/update", {
      method: "POST", headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as { uncertain?: boolean } };
  };
  assert.equal((await fetch(base + "/api/lan-agent/nodes")).status, 401);
  assert.equal((await fetch(base + "/api/lan-agent/releases/manifest", { headers: { "x-rabiroute-authenticated": "true" } })).status, 401);
  assert.equal((await fetch(base + "/api/lan-agent/nodes/fixture-alpha/update", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "0.9.1" })
  })).status, 401);
  assert.equal(notifications.length, 0);
  const unregisteredManifest = await fetch(base + "/api/lan-agent/releases/manifest", { headers: { authorization: `Bearer ${unregistered}` } });
  assert.equal(unregisteredManifest.status, 200);
  assert.deepEqual((await unregisteredManifest.json() as { release: ReturnType<LanAgentReleaseStore["manifest"]> }).release, commonManifest);
  assert.deepEqual(await readManifest(alpha), commonManifest);
  assert.equal((await update({ releaseDigest: selected.releaseDigest, expectedReleaseDigest: commonPublication.releaseDigest })).status, 202);
  const assigned = await readManifest(alpha);
  assert.equal(verifyLanAgentReleaseManifest(assigned, commonManifest.publicKeySha256), true);
  assert.deepEqual(await readManifest(beta, "?nodeId=fixture-alpha"), commonManifest);
  assert.deepEqual(await readManifest(authority.issueBootstrapTicket().ticket), commonManifest);
  const listed = await fetch(base + "/api/lan-agent/nodes", { headers: headers(beta) }); assert.equal(listed.status, 200);
  const nodes = (await listed.json() as { nodes: Array<{ nodeId: string; releaseDigest: string }> }).nodes;
  assert.equal(nodes.find(node => node.nodeId === "fixture-alpha")?.releaseDigest, selected.releaseDigest);
  assert.equal(nodes.find(node => node.nodeId === "fixture-beta")?.releaseDigest, commonPublication.releaseDigest);
  const asset = assigned.files.find(file => file.path === "lib/worker.mjs"); assert.ok(asset);
  assert.ok(new URL(asset.downloadUrl, base).searchParams.has("release"));
  const bytes = fs.readFileSync(path.join(candidateRoot, asset.path));
  // The official SDK sends only Bearer nodeCredential: it has no Agent profile/header.
  // Do not manufacture a trusted principal in the fixture; the real release ingress must establish it.
  const bareManifestResponse = await fetch(base + "/api/lan-agent/releases/manifest", { headers: { authorization: `Bearer ${alpha}` } });
  const bareManifestBody = await bareManifestResponse.json() as { release?: ReturnType<LanAgentReleaseStore["manifest"]> };
  const bareAssetResponse = await fetch(base + asset.downloadUrl, { headers: { authorization: `Bearer ${alpha}` } });
  const bareAssetBytes = Buffer.from(await bareAssetResponse.arrayBuffer());
  assert.deepEqual({ manifestStatus: bareManifestResponse.status,
    selectedManifest: JSON.stringify(bareManifestBody.release) === JSON.stringify(assigned),
    pinnedAssetStatus: bareAssetResponse.status, pinnedAssetBytes: bareAssetBytes.equals(bytes) },
    { manifestStatus: 200, selectedManifest: true, pinnedAssetStatus: 200, pinnedAssetBytes: true });
  const { __test: sdk } = await import(new URL("../../apps/rabi-agent/rabi-agent.mjs", import.meta.url).href);
  const sdkConfig = { managerUrl: base, nodeCredential: alpha };
  for (const file of assigned.files) {
    const response = await sdk.authorizedFetch(sdkConfig, file.downloadUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(candidateRoot, file.path)), file.path);
  }
  const bareBeta = await fetch(base + "/api/lan-agent/releases/manifest", { headers: { authorization: `Bearer ${beta}` } });
  assert.equal(bareBeta.status, 200);
  assert.deepEqual((await bareBeta.json() as { release: ReturnType<LanAgentReleaseStore["manifest"]> }).release, commonManifest);
  const commonAsset = commonManifest.files.find(file => file.path === asset.path); assert.ok(commonAsset);
  const bareBetaAsset = await fetch(base + commonAsset.downloadUrl, { headers: { authorization: `Bearer ${beta}` } });
  assert.equal(bareBetaAsset.status, 200); assert.deepEqual(Buffer.from(await bareBetaAsset.arrayBuffer()), fs.readFileSync(path.join(commonRoot, asset.path)));

  const download = await fetch(base + asset.downloadUrl, { headers: headers(alpha) });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await update({ releaseDigest: null, expectedReleaseDigest: commonPublication.releaseDigest })).status, 409);
  assert.equal(releases.publication("fixture-alpha").releaseDigest, selected.releaseDigest);
  assert.equal(notifications.length, 1);
  assert.equal((await update({ version: "0.9.1" })).status, 202);
  assert.equal(releases.publication("fixture-alpha").releaseDigest, selected.releaseDigest);
  assert.deepEqual(notifications, [{ nodeId: "fixture-alpha", version: "0.9.1" }, { nodeId: "fixture-alpha", version: "0.9.1" }]);
  failNotification = true;
  const uncertain = await update({ releaseDigest: null, expectedReleaseDigest: selected.releaseDigest });
  assert.equal(uncertain.status, 400); assert.equal(uncertain.body.uncertain, true);
  assert.deepEqual(releases.publication("fixture-alpha"), commonPublication);
  const stable = await fetch(base + asset.downloadUrl, { headers: headers(alpha) });
  assert.equal(stable.status, 200); assert.deepEqual(Buffer.from(await stable.arrayBuffer()), bytes);
  const bareStable = await fetch(base + asset.downloadUrl, { headers: { authorization: `Bearer ${alpha}` } });
  assert.equal(bareStable.status, 200); assert.deepEqual(Buffer.from(await bareStable.arrayBuffer()), bytes);
  for (const query of ["?release=invalid", "?release=" + "a".repeat(64) + "&release=" + "a".repeat(64), "?token=fixture"]) {
    const invalidSnapshotUrl: URL = new URL(asset.downloadUrl, base); invalidSnapshotUrl.search = query;
    assert.equal((await fetch(invalidSnapshotUrl, { headers: { authorization: `Bearer ${alpha}` } })).status, 401);
  }
  accessEnabled = false;
  assert.equal((await fetch(base + asset.downloadUrl, { headers: { authorization: `Bearer ${beta}` } })).status, 401);
  accessEnabled = true;
  assert.deepEqual(releases.manifest(), commonManifest);
  const readback = await fetch(base + "/api/lan-agent/nodes", { headers: headers(beta) }); assert.equal(readback.status, 200);
  assert.equal((await readback.json() as { nodes: Array<{ nodeId: string; releaseDigest: string }> }).nodes.find(node => node.nodeId === "fixture-alpha")?.releaseDigest, commonPublication.releaseDigest);
  authority.revokeNode("fixture-alpha");
  assert.equal((await fetch(base + asset.downloadUrl, { headers: headers(alpha) })).status, 403);
  assert.ok([401, 403].includes((await fetch(base + asset.downloadUrl, { headers: { authorization: `Bearer ${alpha}` } })).status));
  assert.deepEqual(await readManifest(beta), commonManifest);
});
