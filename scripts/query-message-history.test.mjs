import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { queryMessageHistory } from "./lib/query-message-history.mjs";

const discovery = { explicit: "http://localhost:12345" }; // Explicit fixture, never used as runtime discovery.
const meta = { managerBaseUrl: discovery.explicit, applicationGenerationId: "test-generation", managerInstanceId: "test-instance",
  health: { live: true, requiredReady: true, state: "healthy" } };

test("client propagates only remaining total budget after identity discovery", async () => {
  const calls = [];
  const result = await queryMessageHistory({ roleId: "synthetic role", query: { query: "中文", includeArchives: true }, budgetMs: 250, discovery,
    fetch: async (input, options) => {
      const url = new URL(input); calls.push(url);
      if (url.pathname === "/meta") { await delay(35, undefined, { signal: options.signal }); return Response.json(meta); }
      assert.ok(Number(url.searchParams.get("budgetMs")) <= 225);
      assert.equal(url.searchParams.get("query"), "中文");
      assert.equal(url.searchParams.get("includeArchives"), "1");
      assert.equal(options.redirect, "error");
      return Response.json({ code: 0, data: { entries: [], count: 0 } });
    } });
  assert.equal(result.code, 0); assert.equal(calls.length, 2);
  assert.equal(calls[1].pathname, "/api/roles/synthetic%20role/message-endpoint-history");
});

test("discovery and response body share one deadline, including a body reader that never settles", async () => {
  const began = performance.now(); let calls = 0;
  await assert.rejects(queryMessageHistory({ roleId: "synthetic", budgetMs: 70, discovery,
    fetch: async input => {
      calls++;
      if (new URL(input).pathname === "/meta") { await delay(35); return Response.json(meta); }
      return { ok: true, json: () => new Promise(() => {}) };
    } }), error => error.name === "TimeoutError");
  assert.ok(performance.now() - began < 300); assert.equal(calls, 2);
});

test("client cancellation does not retry and unsafe query parameters are rejected", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(queryMessageHistory({ roleId: "synthetic", signal: controller.signal, fetch: async () => { calls++; } }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(queryMessageHistory({ roleId: "synthetic", query: { token: "not-a-secret" } }), /Unsupported/);
});
