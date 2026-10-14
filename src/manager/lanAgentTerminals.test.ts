import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LanAgentTerminals } from "./lanAgentTerminals.js";

test("terminal replay is isolated, bounded and never persists or re-executes input", async () => {
  const calls: unknown[] = [];
  const hub = new LanAgentTerminals(async (instance, body) => { calls.push({ instance, body }); return { ok: true }; });
  const terminalId = randomUUID();
  await hub.execute("node-a", { action: "open", terminalId, shell: "cmd" });
  const received: Array<{ type: string; data?: string }> = [];
  for (let i = 0; i < 100; i++) hub.receive("node-a", { terminalId, type: "output", data: "x".repeat(8192) });
  hub.receive("node-b", { terminalId, type: "output", data: "another node" });
  const unsubscribe = hub.subscribe("node-a", terminalId, 0, event => received.push(event));
  assert.equal(received[0]!.type, "gap");
  assert.ok(received.map(item => item.data || "").join("").length < 262144);
  assert.ok(!received.some(item => item.data === "another node"));
  assert.equal(calls.length, 1);
  unsubscribe();
  const ended: string[] = [];
  hub.subscribe("node-a", terminalId, 100, event => ended.push(event.type));
  hub.disconnect("node-a");
  assert.deepEqual(ended, ["disconnected"]);
  assert.throws(() => hub.subscribe("node-a", terminalId, 0, () => undefined), /not found/);
});

test("host Agent reads output with a cursor and event-driven bounded waiting", async () => {
  const hub = new LanAgentTerminals(async (_instance, body) => ({ terminalId: body.terminalId, state: "running" }));
  const terminalId = randomUUID(); await hub.execute("node-a", { action: "open", terminalId });
  const waiting = hub.read("node-a", terminalId, 0, 1000);
  hub.receive("node-a", { terminalId, type: "output", data: "result" });
  const result = await waiting as { outputEvents: Array<{ data: string }>; nextOutputSequence: number; truncated: boolean };
  assert.equal(result.outputEvents[0]!.data, "result"); assert.equal(result.nextOutputSequence, 1); assert.equal(result.truncated,false);
  const disconnected = hub.read("node-a",terminalId,1,1000); hub.disconnect("node-a");
  await assert.rejects(disconnected,/changed/);
});
