import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { AgentUploadStore } from "./agentUploadStore.js";
import { createAgentUploadRoutes } from "./agentUploadRoutes.js";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { AgentRequestStore } from "../agentRequests/store.js";

test("authenticated host and another connection can inspect an existing upload without registering a chat", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-upload-http-"));
  const store = new AgentUploadStore({ rootDir: path.join(root, "uploads") });
  const bytes = Buffer.from("fixture package");
  const uploadId = randomUUID();
  const receipt = store.upload({ owner: { nodeId: "original-computer", agentId: "uploader" }, uploadId,
    fileName: "package.apk", content: bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  let active = true;
  const routes = createAgentUploadRoutes({ store,
    assertAuthorized() { throw new Error("GET must not require an uploading Agent"); },
    assertConnectionAuthorized(request) {
      if (!hasAuthenticatedConnectionRequest(request)) throw new Error("Unauthenticated");
    } });
  const server = http.createServer((req, res) => {
    // Isolated fixture admission stands for the production connection authenticator.
    if (req.headers.authorization === "fixture-connection") markAuthenticatedConnectionRequest(req, () => {
      if (!active) throw new Error("Connection revoked");
    });
    routes.handler(req, new URL(req.url!, "http://fixture.invalid"), res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await routes.stopAcceptingAndDrain();
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/agent/uploads/${uploadId}`;
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, { headers: { authorization: "fixture-connection" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 0, data: receipt });
  await store.withSharedFile(uploadId, file => {
    assert.deepEqual(fs.readFileSync(file.path), bytes);
    assert.equal(file.sha256, receipt.sha256);
  });
  active = false;
  assert.equal((await fetch(url, { headers: { authorization: "fixture-connection" } })).status, 403);
});

test("shared file use still verifies bytes and expiration", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-upload-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.now();
  const store = new AgentUploadStore({ rootDir: root, now: () => now, ttlMs: 1000 });
  const uploadId = randomUUID(); const bytes = Buffer.from("original");
  store.upload({ owner: { nodeId: "computer", agentId: "agent" }, uploadId, fileName: "package.apk",
    content: bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  fs.writeFileSync(path.join(root, uploadId, "data.bin"), "tampered");
  let sends = 0;
  await assert.rejects(store.withSharedFile(uploadId, () => { sends++; }), { code: "integrity" });
  assert.equal(sends, 0);
  now += 1001;
  assert.throws(() => store.getShared(uploadId), { code: "not_found" });
});

test("remote endpoints need only an authenticated computer and explicit provider/session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-endpoint-"));
  try {
    const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
    authority.enroll(authority.issueBootstrapTicket().ticket, "computer");
    const factory = createAgentEndpointDelivery({ authority,
      registry: { localInstanceId: "manager" }, config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "policy" }) },
      store: new AgentRequestStore({ read: () => undefined, write: () => {} }), receiptDirectory: root
    } as unknown as AgentEndpointDeliveryContext);
    const endpoint = factory.remoteEndpoint("computer", "dsh", "explicit-unsaved-session", "dsh");
    factory.authorize(endpoint);
    assert.equal(endpoint.sessionId, "explicit-unsaved-session");
    authority.revokeNode("computer");
    assert.throws(() => factory.authorize(endpoint), /disabled|revoked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
