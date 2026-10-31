import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeerTunnelRuntime, APPLICATION_ACCESS_CAPABILITY } from "./runtime.js";
import { createPeerControlOperations } from "./apiControlOperations.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../manager/lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest, hasAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "../manager/lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-api-control-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "control-node");
  const runtime = new PeerTunnelRuntime({ dataDir: path.join(root, "native"), deviceId: "source", generation: "generation", allowApplicationConnection: () => true,
    allowControl: request => hasAuthenticatedConnectionRequest(request), discover: async () => [{ id: "target", name: "Target", online: true, deviceKind: "pc", capabilities: ["peer-tunnel-v1", APPLICATION_ACCESS_CAPABILITY], peerUrls: [] }],
    signal: async () => { throw new Error("Controlled bootstrap fixture."); }, relay: () => ({ url: "http://127.0.0.1", token: "fixture" }), services: () => ({}), onStatus: () => {} });
  // Only bootstrap readiness is controlled. Selection persistence, connection
  // directory, original caller guards and event subscriptions remain native.
  let gate: Promise<void> | undefined, acquiring!: () => void;
  const acquiringPromise = new Promise<void>(resolve => { acquiring = resolve; });
  runtime.ensureApplicationConnection = async () => { acquiring(); if (gate) await gate; };
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("peer", createPeerControlOperations(runtime));
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture.invalid").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await registration.dispose(); await runtime.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const request = (suffix: string, init: RequestInit = {}) => fetch(base + "/api/rabilink/peer/" + suffix, { ...init, headers: { authorization: "Bearer " + credential.token, ...init.headers }, signal: AbortSignal.timeout(5000) });
  return { runtime, request, root, registry, registration, authority, credential, acquiring: acquiringPromise, gate: (value: Promise<void>) => { gate = value; } };
}

test("six executable controls use native directory, identity, persisted selection and SSE with no persona grant", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.registry.catalogSnapshot().operations.length, 6);
  const identity = await (await f.request("identity")).json(); assert.equal(identity.deviceId, "source"); assert.equal(identity.privateKey, undefined);
  const directory = await (await f.request("servers")).json(); assert.equal(directory.peers[0].deviceId, "target");
  const stream = await f.request("events?ids=" + encodeURIComponent(JSON.stringify(["target"]))); assert.equal(stream.status, 200);
  const reader = stream.body!.getReader(); let observed = new TextDecoder().decode((await reader.read()).value); assert.equal(observed, ": connected\n\n");
  const selected = await f.request("selection", { method: "PUT", body: JSON.stringify({ deviceId: "target", extension: "ignored" }) });
  assert.equal(selected.status, 200); assert.equal((await selected.json()).selectedDeviceId, "target");
  observed += new TextDecoder().decode((await reader.read()).value); assert.match(observed, /event: selection\ndata: \{"selectedDeviceId":"target"\}/);
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "native/tunnel.json"), "utf8")); assert.equal(saved.selectedDeviceId, "target");
  assert.equal((await (await f.request("selection")).json()).selectedDeviceId, "target");
  const probe = await f.request("probe", { method: "POST", body: JSON.stringify({ deviceIds: [] }) }); assert.equal(probe.status, 200); await probe.arrayBuffer();
  await reader.cancel(); await f.registration.dispose(); assert.equal(f.runtime.connections.listenerCount("selection"), 0);
});

test("selection revalidates original admission after target bootstrap and before native persistence", { timeout: 10000 }, async t => {
  const f = await fixture(t); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); f.gate(held);
  const pending = f.request("selection", { method: "PUT", body: JSON.stringify({ deviceId: "target" }) });
  try {
    await Promise.race([f.acquiring, pending.then(() => assert.fail("Selection settled before target acquisition."))]);
    f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); release();
    const response = await pending; assert.equal(response.status, 403); await response.arrayBuffer();
    assert.equal(f.runtime.selected(), "");
    await assert.rejects(fs.access(path.join(f.root, "native/tunnel.json")), { code: "ENOENT" });
  } finally {
    release(); await Promise.allSettled([pending]);
  }
});
