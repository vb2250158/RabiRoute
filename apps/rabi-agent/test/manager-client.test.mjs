import test from "node:test";
import assert from "node:assert/strict";
import { createManagerClient } from "../lib/manager-client.mjs";
const meta = { health: { state: "healthy", requiredReady: true }, applicationGenerationId: "generation-fixture", managerInstanceId: "manager-fixture" };
const settings = { managerUrl: "http://manager.invalid:1234", credential: "fixture-only", agentId: "agent-fixture" };

test("client verifies metadata, preserves mutation headers and returns receipts without replay", async () => {
  const calls = [];
  const client = createManagerClient({ ...settings, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length !== 2 ? Response.json(meta) : Response.json({ ok: true }, { headers: { etag: '"revision-2"', "idempotency-key": "operation-fixture" } });
  } });
  const result = await client.invoke("PATCH", "/api/roles/example/plans/one", { body: { title: "Example" }, headers: { "If-Match": '"revision-1"', "Idempotency-Key": "operation-fixture" } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${settings.managerUrl}/meta`);
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers["x-rabiroute-agent-id"], settings.agentId);
  assert.equal(calls[1].options.headers["if-match"], '"revision-1"');
  assert.equal(result.headers.etag, '"revision-2"');
  assert.equal(result.uncertain, false);
  assert.equal(result.identity.managerInstanceId, "manager-fixture");
});

test("client rejects cross-origin targets and caller credential overrides", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json(meta); } });
  for (const target of ["https://other.invalid/api", "//other.invalid/api", "/\\other.invalid/api", "/api#fragment"]) {
    await assert.rejects(client.invoke("POST", target), /relative path/);
  }
  await assert.rejects(client.invoke("GET", "/api/example", { headers: { authorization: "override" } }), /Only If-Match/);
  assert.equal(calls, 5); // Metadata is the only network request for each rejected operation.
});

test("uncertain mutation returns once and does not expose transport secrets", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => {
    if (++calls === 1) return Response.json(meta);
    throw new Error(`Sensitive transport detail ${settings.credential}`);
  } });
  const result = await client.invoke("POST", "/api/agent/send", { body: {} });
  assert.equal(calls, 3);
  assert.equal(result.uncertain, true);
  assert.equal(result.statusCode, 0);
  assert.ok(!result.body.includes(settings.credential));
});

test("unready metadata prevents business request", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json({ ...meta, health: { state: "starting" } }); } });
  await assert.rejects(client.invoke("POST", "/api/agent/send"), /not ready/);
  assert.equal(calls, 1);
});
