import assert from "node:assert/strict";
import test from "node:test";
import { createApiCatalogClient } from "../lib/api-catalog-client.mjs";

function catalog(revision = 1, method = "POST") {
  return { schemaVersion: "2", applicationGenerationId: "app", managerInstanceId: "manager", pluginGenerationId: `plugin-${revision}`,
    catalogRevision: revision, catalogDigest: `sha256:${String(revision).repeat(64)}`, coverage: { complete: false, gaps: [] }, nextCursor: "",
    operations: [{ id: "plugin.future", contractDigest: `sha256:${String(revision).repeat(64)}`,
      contract: { operationId: "plugin.future", contractVersion: "1.0.0", transport: "http", method, pathTemplate: `/api/future-${revision}/:id` } }] };
}
const identity = { applicationGenerationId: "app", managerInstanceId: "manager" };
const receipt = data => ({ statusCode: 200, ok: true, body: JSON.stringify({ code: 0, data }), headers: { etag: `"${data.catalogRevision}"` }, identity });

test("a future plugin is invoked by current discovery, revalidated on demand and refreshed after an event without a mapping update", async () => {
  let current = catalog(); const calls = [];
  const client = createApiCatalogClient({ request: async (method, target, options) => {
    calls.push({ method, target, options });
    if (target === "/api/agent/help") return options.headers["if-none-match"] === `"${current.catalogRevision}"`
      ? { statusCode: 304, ok: false, body: "", identity } : receipt(current);
    return { statusCode: 200, ok: true, body: '{"code":0}' };
  } });
  await client.invokeOperation("plugin.future", { path: { id: "one / two" }, query: { tag: ["a", "b"] }, body: { original: true }, headers: { "idempotency-key": "same" } });
  assert.equal(calls[1].target, "/api/future-1/one%20%2F%20two?tag=a&tag=b");
  assert.equal(calls[1].options.headers["idempotency-key"], "same");
  assert.equal(calls[1].options.replaySafe, false);
  await client.refresh(); assert.equal(calls.at(-1).options.headers["if-none-match"], '"1"');
  current = catalog(2); client.handleEvent({ type: "api.catalog.changed" });
  await client.invokeOperation("plugin.future", { path: { id: "next" } });
  assert.equal(calls.at(-1).target, "/api/future-2/next");
  assert.equal(calls.at(-2).options.headers["if-none-match"], undefined);
});

test("contract changes and uncertain writes invalidate discovery without replaying or changing original keys", async () => {
  let sends = 0;
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") return receipt(catalog());
    sends++; assert.equal(options.headers["idempotency-key"], "original");
    return { statusCode: 409, ok: false, body: '{"errorCode":"API_CONTRACT_CHANGED"}' };
  } });
  const result = await client.invokeOperation("plugin.future", { path: { id: "one" }, headers: { "idempotency-key": "original" } });
  assert.equal(result.statusCode, 409); assert.equal(sends, 1);
});

test("identity disagreement and malformed discovery never become cached invocation metadata", async () => {
  const client = createApiCatalogClient({ request: async () => ({ ...receipt(catalog()), identity: { ...identity, managerInstanceId: "other" } }) });
  await assert.rejects(client.refresh(), /identities disagree/);
  const malformed = catalog(); malformed.operations[0].contract.pathTemplate = "//example.invalid/leak";
  await assert.rejects(createApiCatalogClient({ request: async () => receipt(malformed) }).refresh(), /invalid API operation/);
  const ambiguous = catalog(); ambiguous.operations[0].contract.aliases = ["plugin.future"];
  await assert.rejects(createApiCatalogClient({ request: async () => receipt(ambiguous) }).refresh(), /ambiguous API operation identifiers/);
});

test("legacy discovery IDs resolve to one canonical handler without another endpoint mapping", async () => {
  const value = catalog(); value.operations[0].contract.aliases = ["legacy:POST:/api/example/:id"];
  const calls = [];
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") return receipt(value);
    calls.push({ target, options }); return { statusCode: 200, ok: true, body: "{}" };
  } });
  await client.invokeOperation(value.operations[0].contract.aliases[0], { path: { id: "original" }, headers: { "idempotency-key": "same" } });
  assert.equal(calls.length, 1); assert.equal(calls[0].target, "/api/future-1/original");
  assert.equal(calls[0].options.headers["idempotency-key"], "same");
  assert.equal(calls[0].options.headers["x-rabiroute-api-contract"], value.operations[0].contractDigest);
});

test("an event stream split across CRLF boundaries invalidates the cached snapshot without polling", async () => {
  let conditional;
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") { conditional = options.headers["if-none-match"]; return receipt(catalog()); }
    assert.equal(target, "/api/events"); assert.equal(options.replaySafe, false);
    await options.onChunk(Buffer.from("event: api.catalog.changed\r"));
    await options.onChunk(Buffer.from("\ndata: {}\r\n\r"));
    await options.onChunk(Buffer.from("\n"));
    return { statusCode: 200, ok: true };
  } });
  await client.refresh(); await client.refresh(); assert.equal(conditional, '"1"');
  await client.watch(); await client.refresh(); assert.equal(conditional, undefined);
});

test("catalog watching discards large unrelated event bodies and still reads a later change event", async () => {
  let conditional;
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") { conditional = options.headers["if-none-match"]; return receipt(catalog()); }
    await options.onChunk(Buffer.from("event: unrelated\r\ndata: "));
    for (let index = 0; index < 128; index++) await options.onChunk(Buffer.alloc(8192, 120));
    await options.onChunk(Buffer.from("\r\n\r\nevent: api.catalog.changed\r\ndata: {}\r\n\r\n"));
    return { statusCode: 200, ok: true };
  } });
  await client.refresh(); await client.watch(); await client.refresh(); assert.equal(conditional, undefined);
});

test("selected transport compatibility and stream consumption are checked before executing the operation", async () => {
  const value = catalog(); let calls = 0; const received = [];
  value.operations[0].contract.transport = "websocket";
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") return receipt(value);
    calls++; assert.equal(options.responseMode, "stream"); await options.onChunk(Buffer.from("event: ready\ndata: {}\n\n"));
    return { statusCode: 200, ok: true };
  } });
  await assert.rejects(client.invokeOperation("plugin.future", { path: { id: "one" } }), /compatible connector/); assert.equal(calls, 0);
  value.operations[0].contract.transport = "sse";
  await assert.rejects(client.invokeOperation("plugin.future", { path: { id: "one" } }), /stream consumer/); assert.equal(calls, 0);
  await client.invokeOperation("plugin.future", { path: { id: "one" }, onChunk: bytes => { received.push(bytes.toString()); } });
  assert.equal(calls, 1); assert.match(received.join(""), /event: ready/);
});

test("SSE file output uses the public transport outputPath without requiring a second stream consumer", async () => {
  const value = catalog(); value.operations[0].contract.transport = "sse";
  let calls = 0;
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") return receipt(value);
    calls++; assert.equal(options.outputPath, "explicit-output.sse"); assert.equal(options.onChunk, undefined);
    return { statusCode: 200, ok: true, outputCommitted: true };
  } });
  const result = await client.invokeOperation("plugin.future", { path: { id: "one" }, outputPath: "explicit-output.sse" });
  assert.equal(result.outputCommitted, true); assert.equal(calls, 1);
});

test("raw proxy suffix and an outer contract header are derived for HTTP without replacing the original target precondition", async () => {
  const value = catalog(); const contract = value.operations[0].contract;
  contract.pathTemplate = "/proxy/:peer/:path"; contract.request = { pathRemainder: "path", contractHeader: "x-rabiroute-proxy-contract" };
  const calls = [];
  const client = createApiCatalogClient({ request: async (_method, target, options) => {
    if (target === "/api/agent/help") return receipt(value);
    calls.push({ target, options }); return { statusCode: 200, ok: true, body: "{}" };
  } });
  await client.invokeOperation("plugin.future", { path: { peer: "node", path: "" }, headers: { "x-rabiroute-api-contract": "target" } });
  assert.equal(calls[0].target, "/proxy/node/");
  assert.equal(calls[0].options.headers["x-rabiroute-api-contract"], "target");
  assert.equal(calls[0].options.headers["x-rabiroute-proxy-contract"], value.operations[0].contractDigest);
  await assert.rejects(client.invokeOperation("plugin.future", { path: { peer: "node", path: "x" }, headers: { "X-RabiRoute-Proxy-Contract": "override" } }), /owns its API contract header/);
  assert.equal(calls.length, 1);
});
