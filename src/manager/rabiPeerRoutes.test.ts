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
    token: () => "test-application-token", allowed: () => [], operations: [],
    peers: async () => { discoveries++; return []; }, relay: () => ({ url: "http://localhost", token: "test" }),
    readJson: async () => ({}), json: (_response, status) => { result = status; }
  });
  try {
    const req = { method: "GET", socket: { remoteAddress: "192.0.2.10" }, headers: {} } as unknown as IncomingMessage;
    const url = new URL("http://localhost/api/rabilink/peer/list");
    runtime.handler(req, url, {} as ServerResponse);
    assert.equal(result, 403); assert.equal(discoveries, 0);
    markAuthenticatedConnectionRequest(req);
    runtime.handler(req, url, {} as ServerResponse);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result, 200); assert.equal(discoveries, 1);
  } finally { await runtime.stop(); }
});
