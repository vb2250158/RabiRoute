import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { createManagerEventsOperation, ManagerEventHub } from "./managerEvents.js";

test("the real connector discovers and calls a newly registered plugin without client endpoint mappings", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-remote-contract-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("api-remote-contract-")); fs.rmSync(root, { recursive: true, force: true }); });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const meta = { applicationGenerationId: "app", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ ...meta, pluginGenerationId: "plugins" }) });
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const observed: number[] = [];
  const alias = "example:POST:/api/example/records/:recordId";
  let registration = registry.registerOperations("example", [{ contract: fixtureApiContract({ aliases: [alias] }), handler: input => {
    observed.push((input.body as { value: number }).value);
    return { status: 200, body: { ok: true, value: 1 } };
  } }]);
  const server = http.createServer((request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    assert.equal(request.headers.authorization, `Bearer ${credential.token}`);
    assert.equal(request.headers["x-rabiroute-agent-type"], "dsh");
    assert.equal(request.headers["x-rabiroute-session-id"], "original-source");
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent");
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://localhost").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await registration.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const client = createManagerClient({ managerUrl: `http://127.0.0.1:${address.port}`, credential: credential.token, agentType: "dsh", sessionId: "original-source" });
  const result = await client.invokeOperation(alias, { path: { recordId: "one" }, body: { value: 9 }, headers: { "idempotency-key": "same-key" } });
  assert.equal(result.statusCode, 200); assert.deepEqual(JSON.parse(String(result.body)), { ok: true, value: 1 });
  await registration.dispose();
  registration = registry.registerOperations("example", [{ contract: fixtureApiContract({ pathTemplate: "/api/changed/records/:recordId" }),
    handler: input => { observed.push((input.body as { value: number }).value); return { status: 200, body: { ok: true, value: 2 } }; } }]);
  client.catalog.handleEvent({ type: "api.catalog.changed" });
  const next = await client.invokeOperation("example.record.write", { path: { recordId: "two" }, body: { value: 10 } });
  assert.equal(next.statusCode, 200); assert.deepEqual(JSON.parse(String(next.body)), { ok: true, value: 2 });
  assert.deepEqual(observed, [9, 10]);
  const streamOwner = new ManagerEventHub();
  const streamDefinition = createManagerEventsOperation(streamOwner);
  const stream = registry.registerOperations("example", [{ contract: { ...streamDefinition.contract, operationId: "example.live",
    pathTemplate: "/api/example/independent-events" }, handler: () => ({ status: 200, stream: {
      frames: (async function* () { yield { event: "new-plugin-event", data: { revision: 1 } }; })(), cancel: () => undefined
    } }) }]);
  t.after(() => stream.dispose());
  const chunks: Buffer[] = [];
  const streamed = await client.invokeOperation("example.live", { onChunk: bytes => { chunks.push(Buffer.from(bytes)); } });
  assert.equal(streamed.statusCode, 200); assert.match(Buffer.concat(chunks).toString(), /event: new-plugin-event\ndata: \{"revision":1\}/);
  const streamPath = path.join(root, "events.sse");
  const savedStream = await client.invokeOperation("example.live", { outputPath: streamPath });
  assert.equal(savedStream.outputCommitted, true);
  assert.deepEqual(fs.readFileSync(streamPath), Buffer.concat(chunks));
  const bytes = Buffer.from([0, 255, 128, 10]);
  const baseContract = fixtureApiContract();
  const binary = registry.registerOperations("example", [{ contract: { ...baseContract, operationId: "example.binary", method: "GET",
    pathTemplate: "/api/example/new-binary/:recordId", request: { ...baseContract.request, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/octet-stream", binary: { minBytes: 1, maxBytes: bytes.length } } },
    effects: { mode: "read", description: "Reads one finite byte fixture." } }, handler: () => ({ status: 200, body: bytes }) }]);
  t.after(() => binary.dispose());
  const downloaded = await client.invokeOperation("example.binary", { path: { recordId: "one" }, responseMode: "bytes" });
  assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.bodyBytes, bytes);
  const binaryPath = path.join(root, "bytes.bin");
  const savedBytes = await client.invokeOperation("example.binary", { path: { recordId: "two" }, outputPath: binaryPath });
  assert.equal(savedBytes.outputCommitted, true); assert.deepEqual(fs.readFileSync(binaryPath), bytes);
});
