import assert from "node:assert/strict";
import test from "node:test";
import { initializeAgentSessionForRoute, initializeCodexSessionForRoute } from "./shared/codexSessionInitialization.js";

test("automatic initialization saves the name-id binding before delivering persona context", async () => {
  const calls: string[] = [];
  let gatewayId = "draft-route";
  const deliveries: Array<{ gatewayId: string; text: string }> = [];

  const result = await initializeCodexSessionForRoute({
    save: async () => {
      calls.push("save");
      gatewayId = "saved-route";
    },
    currentGatewayId: () => gatewayId,
    deliver: async (message) => {
      calls.push("deliver");
      deliveries.push(message);
    }
  });

  const delivered = deliveries[0];
  assert.deepEqual(calls, ["save", "deliver"]);
  assert.equal(delivered.gatewayId, "saved-route");
  assert.match(delivered.text, /角色文件/);
  assert.match(delivered.text, /记忆与计划/);
  assert.match(delivered.text, /Desktop owner/);
  assert.equal(result.gatewayId, "saved-route");
});

test("automatic initialization never delivers when binding save fails", async () => {
  let deliverCount = 0;
  await assert.rejects(initializeCodexSessionForRoute({
    save: async () => { throw new Error("binding failed"); },
    currentGatewayId: () => "route",
    deliver: async () => { deliverCount += 1; }
  }), /binding failed/);
  assert.equal(deliverCount, 0);
});


test("DSH automatic initialization saves before delivering through the DSH owner contract", async () => {
  const calls: string[] = [];
  const deliveries: Array<{ gatewayId: string; text: string }> = [];
  await initializeAgentSessionForRoute({
    agentAdapter: "dsh",
    save: async () => { calls.push("save"); },
    currentGatewayId: () => "dsh-route",
    deliver: async (message) => {
      calls.push("deliver");
      deliveries.push(message);
    }
  });

  assert.deepEqual(calls, ["save", "deliver"]);
  assert.equal(deliveries[0].gatewayId, "dsh-route");
  assert.match(deliveries[0].text, /DSH 会话 owner/);
  assert.match(deliveries[0].text, /RabiRoute Agent 插件/);
  assert.match(deliveries[0].text, /不要改投其它 Agent 端/);
});
