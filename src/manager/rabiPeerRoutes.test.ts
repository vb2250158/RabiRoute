import http from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createRabiPeerRuntime } from "./rabiPeerRoutes.js";

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
    runtime.handler(req, url, {} as ServerResponse);
    assert.equal(result, 403); assert.equal(discoveries, 0);
    const forgedLocal = { method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1", "x-rabiroute-agent-id": "unverified-agent" } } as unknown as IncomingMessage;
    runtime.handler(forgedLocal, url, {} as ServerResponse);
    assert.equal(result, 403); assert.equal(discoveries, 0);
    markAuthenticatedConnectionRequest(req);
    runtime.handler(req, url, {} as ServerResponse);
    await new Promise(resolve => setImmediate(resolve));
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
    runtime.handler(request, new URL("http://localhost/api/rabilink/peer/list"), {} as ServerResponse);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(status, 403); assert.ok(!JSON.stringify(body).includes("private-peer"));
  } finally { await runtime.stop(); }
});

test("legacy business call endpoint is absent and never reads or discovers", async () => {
  let result = 0, reads = 0, discoveries = 0;
  const runtime = createRabiPeerRuntime({ identity: () => ({ deviceId: "device", generation: "generation", instanceId: "instance" }),
    token: () => "test-application-token", enabled: () => true, peers: async () => { discoveries++; return []; },
    relay: () => ({ url: "http://localhost", token: "test" }), readJson: async () => { reads++; return {}; }, json: (_response, status) => { result = status; } });
  try {
    runtime.handler({ method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: {} } as unknown as IncomingMessage,
      new URL("http://localhost/api/rabilink/peer/call"), {} as ServerResponse);
    assert.equal(result, 404); assert.equal(reads, 0); assert.equal(discoveries, 0);
  } finally { await runtime.stop(); }
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
