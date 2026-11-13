import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentThreadRequest } from "./agentThreads.js";
import type { AgentManagerOperationInvoker } from "./agentAdapters/managerInvocation.js";

test("DSBot actions select original DSH provider before ordinary endpoint delivery", async () => {
  const seen: unknown[] = [];
  const invoke: AgentManagerOperationInvoker = async <T>(provider: string, operation: string, payload: unknown) => {
    seen.push({ provider, operation, payload });
    return { statusCode: 200, data: { dsBot: { state: "accepted" } } } as T;
  };
  const request = { action: "ds_bot_deliver" as const, agentAdapter: "dsh" as const, agentTargetId: "local:dsh", dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "original", prompt: "task" };
  const result = await handleAgentThreadRequest(request, { allowedWorkspaces: [], invokeAgentOperation: invoke, dshBaseUrl: "http://selected.invalid" });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, [{ provider: "dsh", operation: "ds-bot.request", payload: { request, baseUrl: "http://selected.invalid" } }]);
  await assert.rejects(handleAgentThreadRequest({ ...request, agentAdapter: "codex" }, { allowedWorkspaces: [], invokeAgentOperation: invoke }), /selected DSH/);
  assert.equal(seen.length, 1);
});

test("saved local and peer DSBot targets dispatch with exact owners and follow rebuilt parts without a Route", async () => {
  const { sendAutomationSession } = await import("./automation/sessionDelivery.js");
  const { normalizeAgentDeliveryTarget } = await import("./shared/agentDeliveryTarget.js");
  const { routeInstanceThread } = await import("./manager/instanceThreadRouting.js");
  const { executeDsBotRequestOnOwner } = await import("./plugins/io.rabiroute.agent.dsh/src/agentAdapters/dshOwnerExecution.js");
  const targets = [
    { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "scope", botId: "bot", botName: "Bot", dshBaseUrl: "http://127.0.0.1:4567" },
    { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "peer:device:machine:dsh", botScopeId: "scope", botId: "bot", botName: "Bot", instanceBinding: { ownerDeviceId: "device", instanceId: "machine", agentId: "dsh" } }
  ];
  let currentPart = "original-part";
  const admissions: Array<{ origin?: string; sessionId: string; deliveryId?: string }> = [];
  for (const saved of targets) {
    const target = normalizeAgentDeliveryTarget(JSON.parse(JSON.stringify(saved)));
    assert.equal(target.kind, "ds_bot"); if (target.kind !== "ds_bot") continue;
    const invoke: AgentManagerOperationInvoker = async <T>(provider: string, operation: string, payload: any) => {
      assert.equal(provider, "dsh"); assert.equal(operation, "ds-bot.request");
      return await executeDsBotRequestOnOwner(payload.request, { baseUrl: payload.baseUrl, request: async (endpoint, body, options) => {
        if (endpoint === "rabi-automation-reconcile") return { schemaVersion: 1, state: "not_found", botScopeId: "scope", botId: "bot", deliveryId: body.deliveryId! };
        assert.equal(endpoint, "rabi-automation-deliver");
        admissions.push({ origin: options?.baseUrl, sessionId: currentPart, deliveryId: body.deliveryId });
        return { schemaVersion: 1, state: "accepted", botScopeId: "scope", botId: "bot", deliveryId: body.deliveryId!, requestId: body.deliveryId!, sessionId: currentPart };
      } }) as T;
    };
    for (const tick of ["before", "after"]) {
      currentPart = tick === "before" ? "original-part" : "rebuilt-part";
      const deliveryId = target.agentTargetId + tick;
      await sendAutomationSession(target, { messageSource: { type: "system", eventType: "test", eventName: "Test", eventId: "tick" }, messageContent: "Only task text" }, deliveryId, async payload => {
        const request = { ...payload, ...(target.instanceBinding ? { instanceBinding: target.instanceBinding } : {}) } as import("./agentThreads.js").AgentThreadRequest;
        const peer = await routeInstanceThread(request, { instances: () => [], manage: async () => { throw new Error("wrong owner"); }, peer: async (binding, original) => {
          assert.deepEqual(binding, target.instanceBinding); assert.equal(original.dshBaseUrl, undefined);
          const { instanceBinding: _binding, ...body } = original;
          return handleAgentThreadRequest({ ...body, agentTargetId: "local:dsh" }, { allowedWorkspaces: [], dshBaseUrl: "http://127.0.0.1:5678", invokeAgentOperation: invoke });
        } });
        const result = peer ?? await handleAgentThreadRequest(request, { allowedWorkspaces: [], dshBaseUrl: request.dshBaseUrl, invokeAgentOperation: invoke });
        return result.data;
      }, { remote: Boolean(target.instanceBinding) });
    }
  }
  assert.deepEqual(admissions.map(item => [item.origin, item.sessionId]), [["http://127.0.0.1:4567", "original-part"], ["http://127.0.0.1:4567", "rebuilt-part"], ["http://127.0.0.1:5678", "original-part"], ["http://127.0.0.1:5678", "rebuilt-part"]]);
});
