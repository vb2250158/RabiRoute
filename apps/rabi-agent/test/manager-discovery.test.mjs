import test from "node:test";
import assert from "node:assert/strict";
import { discoverManager, createDiscoveryCooldown } from "../lib/manager-discovery.mjs";
import { createEndpointSession, businessReady } from "../lib/endpoint-session.mjs";

for (const failure of ["timeout", "generation", "guid"]) {
  test(`final endpoint verification fails closed on ${failure}`, async () => {
    const config = { managerUrl: "http://localhost:5432", managerGuid: "stable", nodeId: "node", nodeCredential: "fixture-credential", applicationGenerationId: "old", managerInstanceId: "old" };
    let publicReads = 0;
    const session = createEndpointSession({ config, discover: async () => null, fetchImpl: async url => {
      const identity = { guid: "stable", applicationGenerationId: "new", managerInstanceId: "instance" };
      if (url.endsWith("/.well-known/rabiroute-manager")) {
        if (++publicReads > 1) {
          if (failure === "timeout") throw new Error("verification timed out");
          if (failure === "generation") identity.applicationGenerationId = "changed";
          if (failure === "guid") identity.guid = "other";
        }
        return Response.json({ code: 0, data: { protocolVersion: "1", ...identity } });
      }
      if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: "node" } });
      if (url.endsWith("/meta")) return Response.json({ rabiGuid: identity.guid, applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId, health: { live: true, requiredReady: true, state: "healthy" } });
      throw new Error("Unexpected request");
    } });
    await assert.rejects(session.ensure());
    assert.equal(publicReads, 2);
    assert.deepEqual(session.config, config);
  });
}

test("concurrent diagnostics do not inherit business readiness rejection", async () => {
  const identity = { guid: "stable", applicationGenerationId: "generation", managerInstanceId: "instance" };
  const session = createEndpointSession({ config: { managerUrl: "http://manager.invalid", managerGuid: "stable", nodeId: "node", nodeCredential: "fixture" }, fetchImpl: async url => {
    if (url.endsWith("/.well-known/rabiroute-manager")) return Response.json({ code: 0, data: { ...identity, protocolVersion: 1 } });
    if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: "node" } });
    return Response.json({ ...identity, rabiGuid: identity.guid, health: { live: true, requiredReady: false, state: "starting" } });
  } });
  const [business, diagnostic] = await Promise.allSettled([session.ensure(), session.ensure({ diagnostic: true })]);
  assert.equal(business.status, "rejected");
  assert.equal(diagnostic.status, "fulfilled");
});

test("business readiness requires an explicit live signal", () => {
  for (const live of [undefined, false]) assert.equal(businessReady({ health: { live, requiredReady: true, state: "healthy" } }), false);
  assert.equal(businessReady({ health: { live: true, requiredReady: true, state: "degraded" } }), true);
});

test("DNS-SD discovery returns dynamic endpoint and fences identity", async () => {
  const result = await discoverManager({ expected: { generation: "g", instance: "i", guid: "u" }, browse: async () => [{ port: 5432, addresses: ["192.168.1.4"], txt: { protocol: "1", generation: "g", instance: "i", guid: "u" } }], fetchImpl: async url => { assert.equal(url, "http://192.168.1.4:5432/.well-known/rabiroute-manager"); return Response.json({ code: 0, data: { protocolVersion: "1", applicationGenerationId: "g", managerInstanceId: "i", guid: "u", version: "x" } }); } });
  assert.equal(result.managerUrl, "http://192.168.1.4:5432");
});

test("identity mismatch is rejected", async () => {
  const result = await discoverManager({ browse: async () => [{ port: 1, addresses: ["10.0.0.2"], txt: { protocol: "1", generation: "g", instance: "i", guid: "u" } }], fetchImpl: async () => Response.json({ code: 0, data: { protocolVersion: "1", applicationGenerationId: "other", managerInstanceId: "i", guid: "u" } }) });
  assert.equal(result, null);
});

test("rediscovery cooldown coalesces and bounds calls", async () => {
  const gate = createDiscoveryCooldown(1000); let calls = 0;
  assert.equal(await gate(async () => ++calls), 1); assert.equal(await gate(async () => ++calls), null); assert.equal(calls, 1);
});
