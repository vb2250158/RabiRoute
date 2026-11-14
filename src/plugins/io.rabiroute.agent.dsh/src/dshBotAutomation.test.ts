import assert from "node:assert/strict";
import test from "node:test";
import { requestDshBotAutomation } from "./dshSessionBridge.js";
import { executeDsBotRequestOnOwner } from "./agentAdapters/dshOwnerExecution.js";
const catalog = { schemaVersion: 1 as const, botScopeId: "scope", runtimeId: "runtime", bots: [{ botId: "bot", botName: "Bot" }] };
const payload = { schemaVersion: 1 as const, botScopeId: "scope", botId: "bot", deliveryId: "tick", message: "task" };
const accepted = { ...payload, state: "accepted", sessionId: "current-part", requestId: "tick" };

test("DSBot catalog uses authenticated native channel without session or primary binding", async () => {
  const calls: unknown[] = [];
  const result = await requestDshBotAutomation("rabi-automation-catalog", { schemaVersion: 1 }, { baseUrl: "http://127.0.0.1:1234", fetch: async (base, method, body) => {
    calls.push([base, method, JSON.parse(body)]); return Response.json({ ok: true, value: catalog });
  } });
  assert.deepEqual(result, { ...catalog, dshBaseUrl: "http://127.0.0.1:1234" });
  assert.deepEqual(calls, [["http://127.0.0.1:1234", "bot", { endpoint: "rabi-automation-catalog", payload: { schemaVersion: 1 } }]]);
});

test("DSBot native receipts require exact scope, Bot and request identity", async () => {
  for (const value of [{ ...accepted, botScopeId: "copied" }, { ...accepted, botId: "other" }, { ...accepted, requestId: "other" }, { ...accepted, deliveryId: "other" }]) await assert.rejects(requestDshBotAutomation("rabi-automation-deliver", payload, { fetch: async () => Response.json({ ok: true, value }) }));
  await assert.rejects(requestDshBotAutomation("rabi-automation-deliver", payload, { fetch: async () => { throw new Error("lost response"); } }), error => (error as { uncertain: boolean }).uncertain === true);
  await assert.rejects(requestDshBotAutomation("rabi-automation-catalog", { schemaVersion: 1 }, { fetch: async () => new Response(null, { status: 404 }) }), error => (error as { code: string }).code === "DS_BOT_UNSUPPORTED");
});

test("DSBot owner branch needs no cwd and never routes through ordinary Session transport", async () => {
  const calls: unknown[] = [];
  const result = await executeDsBotRequestOnOwner({ action: "ds_bot_deliver", agentAdapter: "dsh", dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "tick", prompt: "task" }, { request: async (endpoint, body) => { calls.push([endpoint, body]); return endpoint === "rabi-automation-reconcile" ? { ...accepted, state: "not_found" } as never : accepted as never; } });
  assert.deepEqual(calls, [["rabi-automation-reconcile", payload], ["rabi-automation-deliver", payload]]);
  assert.equal(result.data.ok, true);
  await assert.rejects(executeDsBotRequestOnOwner({ action: "ds_bot_deliver", agentAdapter: "dsh", threadId: "ordinary", dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "tick", prompt: "task" }), /ordinary Session/);
});

test("DSBot owner reads original receipts before checking the new-task switch", async () => {
  const { assertComputerFeaturePolicyEnabled } = await import("../../../shared/agentInteractiveProtocol.js");
  const request = { action: "ds_bot_deliver" as const, agentAdapter: "dsh" as const, dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "tick", prompt: "task" };
  for (const state of ["accepted", "uncertain", "conflict"] as const) {
    const calls: unknown[] = [];
    const result = await executeDsBotRequestOnOwner(request, { assertNewAgentTask: () => { throw new Error("must not gate original receipt"); }, request: async endpoint => { calls.push(endpoint); return { ...accepted, state } as never; } });
    const receipt = result.data.dsBot; assert.ok("state" in receipt);
    assert.equal(receipt.state, state);
    assert.deepEqual(calls, ["rabi-automation-reconcile"]);
  }
  const calls: unknown[] = [];
  await assert.rejects(executeDsBotRequestOnOwner(request, { assertNewAgentTask: () => assertComputerFeaturePolicyEnabled({ enabled: true, feature: "agentTasks", allowed: false }), request: async endpoint => { calls.push(endpoint); return { ...accepted, state: "not_found" } as never; } }), error => (error as { code: string }).code === "COMPUTER_FEATURE_DISABLED");
  assert.deepEqual(calls, ["rabi-automation-reconcile"]);
  let checks = 0;
  await executeDsBotRequestOnOwner(request, { assertNewAgentTask: () => { checks++; }, request: async endpoint => endpoint === "rabi-automation-reconcile" ? { ...accepted, state: "not_found" } as never : accepted as never });
  assert.equal(checks, 1);
  await executeDsBotRequestOnOwner({ ...request, action: "ds_bot_reconcile" }, { assertNewAgentTask: () => { throw new Error("recovery must stay readable"); }, request: async () => accepted as never });
  await executeDsBotRequestOnOwner({ action: "ds_bot_catalog", agentAdapter: "dsh" }, { assertNewAgentTask: () => { throw new Error("catalog must stay readable"); }, request: async () => catalog });
});

test("original UTC schedule occurrence reaches deliver and reconcile without changing message", async () => {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  const request = { action: "ds_bot_deliver" as const, agentAdapter: "dsh" as const, dsBot: { botScopeId: "scope", botId: "bot", scheduledAt: "2030-06-10T02:00:00.000Z" }, deliveryId: "tick", prompt: "task" };
  await executeDsBotRequestOnOwner(request, { request: async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { ...accepted, state: endpoint === "rabi-automation-reconcile" ? "not_found" : "accepted" } as never;
  } });
  assert.deepEqual(calls.map(call => call.body), [{ ...payload, scheduledAt: request.dsBot.scheduledAt }, { ...payload, scheduledAt: request.dsBot.scheduledAt }]);
  for (const scheduledAt of ["2030-06-10T10:00:00+08:00", "2030-02-30T02:00:00.000Z", "invalid"]) await assert.rejects(executeDsBotRequestOnOwner({ ...request, dsBot: { ...request.dsBot, scheduledAt } }, { request: async () => { throw Error("must reject before native I/O"); } }), /UTC occurrence/);
});

test("DSBot HTTP channel serializes the supplied UTC occurrence and omits absent occurrence", async () => {
  for (const scheduledAt of [undefined, "2030-06-10T02:00:00.000Z"]) {
    const original = { ...payload, ...(scheduledAt ? { scheduledAt } : {}) };
    await requestDshBotAutomation("rabi-automation-reconcile", original, { baseUrl: "http://127.0.0.1:1234", fetch: async (_base, method, body) => {
      assert.equal(method, "bot");
      assert.deepEqual(JSON.parse(body), { endpoint: "rabi-automation-reconcile", payload: original });
      assert.equal(Object.hasOwn(JSON.parse(body).payload, "scheduledAt"), scheduledAt !== undefined);
      return Response.json({ ok: true, value: accepted });
    } });
  }
});

test("catalog ignores an unrelated malformed occurrence field", async () => {
  const calls: unknown[] = [];
  const result = await executeDsBotRequestOnOwner({ action: "ds_bot_catalog", agentAdapter: "dsh", dsBot: { botScopeId: "unused", botId: "unused", scheduledAt: "invalid" } }, { request: async (endpoint, body) => {
    calls.push({ endpoint, body }); return catalog;
  } });
  assert.deepEqual(result.data.dsBot, catalog);
  assert.deepEqual(calls, [{ endpoint: "rabi-automation-catalog", body: { schemaVersion: 1 } }]);
});

test("an accepted receipt predating occurrence metadata is returned without another deliver", async () => {
  const calls: unknown[] = [];
  const result = await executeDsBotRequestOnOwner({ action: "ds_bot_deliver", agentAdapter: "dsh", dsBot: { botScopeId: "scope", botId: "bot", scheduledAt: "2030-06-10T02:00:00.000Z" }, deliveryId: "tick", prompt: "task" }, { request: async (endpoint, body) => {
    calls.push({ endpoint, body }); return accepted as never;
  } });
  assert.deepEqual(result.data.dsBot, accepted);
  assert.deepEqual(calls, [{ endpoint: "rabi-automation-reconcile", body: { ...payload, scheduledAt: "2030-06-10T02:00:00.000Z" } }]);
  assert.equal(Object.hasOwn(result.data.dsBot, "scheduledAt"), false);
});
