import assert from "node:assert/strict";
import test from "node:test";
import { createManagerClient } from "../lib/manager-client.mjs";

test("slow send retains its original delivery while ordinary mutations and explicit deadlines stay bounded", async () => {
  const calls = [];
  const metadata = { applicationGenerationId: "generation", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
  const client = createManagerClient({ managerUrl: "http://manager.invalid", credential: "fixture-only", agentType: "codex", sessionId: "full-session",
    timeoutMs: 20, uploadTimeoutMs: 1000,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/meta") return Response.json(metadata);
      calls.push({ url: new URL(url).pathname, body: options.body });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 90);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
      });
      return Response.json({ code: 0, status: "sent", deliveryId: "same-delivery" });
    } });
  const body = { deliveryId: "same-delivery" };
  const sent = await client.request("POST", "/api/agent/send", { body });
  assert.equal(sent.ok, true);
  assert.equal(JSON.parse(sent.body).deliveryId, body.deliveryId);
  const bounded = await client.request("POST", "/api/agent/send", { body, timeoutMs: 10 });
  assert.equal(bounded.transportError, "CANCELLED"); assert.equal(bounded.uncertain, true);
  const ordinary = await client.request("POST", "/api/other", { body });
  assert.equal(ordinary.transportError, "CANCELLED");
  assert.deepEqual(calls.map(call => call.url), ["/api/agent/send", "/api/agent/send", "/api/other"]);
  assert.ok(calls.every(call => call.body === JSON.stringify(body)));
});
