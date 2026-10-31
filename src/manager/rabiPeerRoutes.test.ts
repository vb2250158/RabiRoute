import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createRabiPeerRuntime } from "./rabiPeerRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PEER_RPC_PATH, sealPeerPacket, openPeerPacket } from "../rabiPeerProtocol.js";

function discover(runtime: ReturnType<typeof createRabiPeerRuntime>, request: IncomingMessage, url = new URL("http://localhost/api/rabilink/peer/list")) {
  return runtime.discoveryOperation.handler({ request, url, response: {} as ServerResponse, path: {}, query: {}, body: undefined });
}

test("Peer discovery reuses authenticated connection identity and rejects anonymous remote callers", async () => {
  let result = 0;
  let discoveries = 0;
  const runtime = createRabiPeerRuntime({
    identity: () => ({ deviceId: "device", generation: "generation", instanceId: "instance" }),
    token: () => "test-application-token", enabled: () => true,
    peers: async () => { discoveries++; return []; }, relay: () => ({ url: "http://localhost", token: "test" }),
    readJson: async () => ({}), json: (_response, status) => { result = status; }
  });
  try {
    const req = { method: "GET", socket: { remoteAddress: "192.0.2.10" }, headers: {} } as unknown as IncomingMessage;
    const url = new URL("http://localhost/api/rabilink/peer/list");
    result = (await discover(runtime, req, url)).status;
    assert.equal(result, 403); assert.equal(discoveries, 0);
    const forgedLocal = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1", "x-rabiroute-agent-id": "unverified-agent" } } as unknown as IncomingMessage;
    result = (await discover(runtime, forgedLocal, url)).status;
    assert.equal(result, 403); assert.equal(discoveries, 0);
    markAuthenticatedConnectionRequest(req);
    result = (await discover(runtime, req, url)).status;
    assert.equal(result, 200); assert.equal(discoveries, 1);
  } finally { await runtime.stop(); }
});


test("Peer discovery suppresses revoked original connection results without loopback fallback", async () => {
  let revoked = false, status = 0, body: unknown;
  const request = { method: "GET", socket: { remoteAddress: "192.0.2.10" }, headers: {} } as unknown as IncomingMessage;
  markAuthenticatedConnectionRequest(request, () => { if (revoked) throw new Error("revoked"); });
  const runtime = createRabiPeerRuntime({ identity: () => ({ deviceId: "device", generation: "generation", instanceId: "instance" }),
    token: () => "test-application-token", enabled: () => true,
    peers: async () => { revoked = true; Object.assign(request.socket, { remoteAddress: "127.0.0.1" }); request.headers.host = "localhost"; return [{ id: "private-peer", online: true, capabilities: [], peerUrls: [] }]; },
    relay: () => ({ url: "http://localhost", token: "test" }), readJson: async () => ({}),
    json: (_response, code, value) => { status = code; body = value; } });
  try {
    const result = await discover(runtime, request);
    status = result.status; body = result.body;
    assert.equal(status, 403); assert.ok(!JSON.stringify(body).includes("private-peer"));
  } finally { await runtime.stop(); }
});

test("legacy business call endpoint is absent and never reads or discovers", async () => {
  let result = 0, reads = 0, discoveries = 0;
  const runtime = createRabiPeerRuntime({ identity: () => ({ deviceId: "device", generation: "generation", instanceId: "instance" }),
    token: () => "test-application-token", enabled: () => true, peers: async () => { discoveries++; return []; },
    relay: () => ({ url: "http://localhost", token: "test" }), readJson: async () => { reads++; return {}; }, json: (_response, status) => { result = status; } });
  try {
    const handled = runtime.handler({ method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: {} } as unknown as IncomingMessage,
      new URL("http://localhost/api/rabilink/peer/call"), {} as ServerResponse);
    assert.equal(handled, false); assert.equal(result, 0); assert.equal(reads, 0); assert.equal(discoveries, 0);
  } finally { await runtime.stop(); }
});

test("executable Peer discovery preserves first-value filters, provider extensions, native summaries and original admission", { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-discovery-operation-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "discovery-node");
  let discoveries = 0, release: (() => void) | undefined, entered: (() => void) | undefined, gate: Promise<void> | undefined;
  const runtime = createRabiPeerRuntime({ identity: () => ({ deviceId: "source", generation: "generation", instanceId: "instance" }),
    token: () => "fixture-token", enabled: () => true, relay: () => ({ url: "http://localhost", token: "fixture-token" }),
    peers: async () => { discoveries++; entered?.(); if (gate) await gate; return [
      { id: "pc", online: true, deviceKind: "PC", capabilities: [], peerUrls: [], extension: "preserved" },
      { id: "phone", online: false, deviceKind: "phone", capabilities: [], peerUrls: [] },
      { id: "legacy", online: true, capabilities: [], peerUrls: [] }
    ]; }, readJson: async () => { throw new Error("Discovery never reads a body."); }, json: () => {} });
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("peer", [runtime.discoveryOperation, runtime.receiveOperation]);
  const server = http.createServer((request, response) => {
    if (new URL(request.url!, "http://fixture").pathname !== PEER_RPC_PATH) {
      if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
      markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    }
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { release?.(); await registration.dispose(); await runtime.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/rabilink/peer/list`;
  const request = (query = "", method = "GET") => fetch(base + query, { method, headers: { authorization: "Bearer " + credential.token }, signal: AbortSignal.timeout(5000) });
  assert.equal(registry.catalogSnapshot().operations[0].contract.operationId, "manager.rabilink.peer.list");
  assert.equal(registry.catalogSnapshot().operations.length, 1, "Private receive is bound but never advertised as a public API.");
  const encrypted = sealPeerPacket({ requestId: "private-discovery-probe", targetDeviceId: "source", capability: "system", operation: "describe", input: {}, expiresAt: Date.now() + 10000 }, "fixture-token");
  const privateResponse = await fetch(base.replace("/list", "/receive"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encrypted) });
  assert.equal(privateResponse.status, 200);
  const reply = openPeerPacket(await privateResponse.json(), "fixture-token") as { ok: boolean; requestId: string };
  assert.equal(reply.ok, true); assert.equal(reply.requestId, "private-discovery-probe");
  const all = await request(); assert.equal(all.status, 200); assert.equal(all.headers.get("cache-control"), "no-store");
  const page = await all.json(); assert.deepEqual(page.summary, { total: 3, online: 2, byDeviceKind: { pc: 1, phone: 1, unknown: 1 } });
  assert.equal(page.peers[0].extension, "preserved");
  const filtered = await (await request("?deviceKind=pc&deviceKind=ignored&online=true&online=ignored&extension=yes")).json();
  assert.deepEqual(filtered.peers.map((peer: { id: string }) => peer.id), ["pc"]);
  const before = discoveries;
  assert.equal((await request("?online=1")).status, 400); assert.equal((await request("?deviceKind=PC")).status, 400);
  assert.equal((await request("", "POST")).status, 405); assert.equal(discoveries, before);
  const reached = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { release = resolve; });
  const pending = request(); await reached; authority.setNodeEnabled(credential.nodeId, false, true); authority.setNodeEnabled(credential.nodeId, true, false); release!();
  const revoked = await pending; assert.equal(revoked.status, 403); assert.ok(!(await revoked.text()).includes("preserved"));
});


test("future peer API owners receive their requests without changing the signal handler", async t => {
  let signalReads = 0;
  const runtime = createRabiPeerRuntime({ identity: () => ({ deviceId: "device", generation: "generation", instanceId: "instance" }),
    token: () => "test-application-token", enabled: () => true, peers: async () => [], relay: () => ({ url: "http://localhost", token: "test" }),
    readJson: async () => { signalReads++; return {}; }, json: (response, status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); } });
  t.after(() => runtime.stop());
  const server = http.createServer((request, response) => {
    if (runtime.handler(request, new URL(request.url!, "http://fixture"), response)) return;
    if (request.url === "/api/rabilink/peer/future-owner") { response.writeHead(201); response.end("future-owner"); }
    else { response.writeHead(404); response.end(); }
  });
  t.after(() => { server.closeAllConnections(); server.close(); }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const response = await fetch("http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/api/rabilink/peer/future-owner");
  assert.equal(response.status, 201); assert.equal(await response.text(), "future-owner"); assert.equal(signalReads, 0);
});
