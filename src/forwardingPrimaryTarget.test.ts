import test from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { deliverPacketToPrimaryAgentAdapter } from "./forwarding.js";
import { remoteAgentTargetKey } from "./shared/routeAgentTargets.js";

test("forwarding uses exact primary target despite stale provider projection and freezes owner", async () => {
  const before = { agentAdapters: config.agentAdapters, primaryAgentAdapter: config.primaryAgentAdapter, primaryAgentTarget: config.primaryAgentTarget, remoteAgentTargets: config.remoteAgentTargets };
  const binding = { instanceId: "test-owner", agentId: "test-agent" };
  const remote = { ...binding, provider: "codex" as const, id: remoteAgentTargetKey(binding) };
  const envelope = { messageSource: { type: "system" as const, eventType: "test", eventName: "isolated target test", eventId: "target-test" }, messageContent: "isolated fixture" };
  const calls: unknown[] = [];
  try {
    Object.assign(config, { agentAdapters: ["codex", "dsh"], primaryAgentAdapter: "codex", primaryAgentTarget: "local:dsh", remoteAgentTargets: [remote] });
    const localResult = await deliverPacketToPrimaryAgentAdapter("test-route", "test-rule", envelope, async (provider, _envelope, _images, target) => {
      calls.push(provider);
      assert.equal(provider, "dsh");
      assert.equal(target?.id, "local:dsh");
      assert.equal(target?.binding, undefined);
    });
    assert.equal(localResult[0]?.adapter, "dsh");
    config.primaryAgentTarget = remote.id;
    await deliverPacketToPrimaryAgentAdapter("test-route", "test-rule", envelope, async (provider, _envelope, _images, target) => {
      assert.equal(provider, "codex");
      config.primaryAgentTarget = "local:dsh";
      assert.deepEqual(target?.binding, binding);
      calls.push(target?.id);
      throw new Error("isolated offline owner");
    });
    assert.equal(calls.length, 2, "offline remote must not retry local");
    config.primaryAgentTarget = "";
    assert.deepEqual(await deliverPacketToPrimaryAgentAdapter("test-route", "test-rule", envelope, async () => { throw new Error("must not dispatch"); }), []);
  } finally { Object.assign(config, before); }
});
