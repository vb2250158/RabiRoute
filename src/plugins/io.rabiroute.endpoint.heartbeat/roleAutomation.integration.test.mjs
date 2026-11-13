import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("independent role schedules use original local, instance and peer thread routes without sessions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-role-native-chain-"));
  const beforeData = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(root, "ledger");
  t.after(async () => { if (beforeData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = beforeData; await fs.rm(root, { recursive: true, force: true }); });
  const [{ createOwnedRuntime }, { createDsBotAutomationRuleOwner }, { routeInstanceThread }, { handleAgentThreadRequest }, { executeDsBotRequestOnOwner }] = await Promise.all([
    import("./hostRuntime.mjs"), import("../io.rabiroute.manager.persona/src/manager/dsBotAutomationRuleOperations.ts"),
    import("../../manager/instanceThreadRouting.ts"), import("../../agentThreads.ts"), import("../io.rabiroute.agent.dsh/src/agentAdapters/dshOwnerExecution.ts")
  ]);
  const roles = path.join(root, "roles");
  const binding = { instanceId: "remote", agentId: "dsh-owner" };
  const peerBinding = { instanceId: "peer-instance", agentId: "dsh-owner", ownerDeviceId: "peer-owner" };
  const target = { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "scope", botId: "bot", botName: "Bot", dshBaseUrl: "http://localhost:3000" };
  const nativeTarget = owner => ({ ...target, ...owner });
  const rule = (id, destination) => ({ id, enabled: true, trigger: { type: "schedule", schedule: { id, type: "interval", intervalSeconds: 1 } }, action: { type: "deliver_agent", message: "Business", template: "For {roleId}; {routeName}", target: destination } });
  const directory = path.join(roles, "Standalone");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "personaConfig.json"), JSON.stringify({ automationRules: [
    rule("local", target), rule("remote", nativeTarget({ agentTargetId: "remote:remote:dsh-owner", instanceBinding: binding, dshBaseUrl: undefined })),
    rule("peer", nativeTarget({ agentTargetId: "peer:peer-owner:peer-instance:dsh-owner", instanceBinding: peerBinding, dshBaseUrl: undefined })),
    rule("offline", nativeTarget({ agentTargetId: "remote:offline:dsh-owner", instanceBinding: { instanceId: "offline", agentId: "dsh-owner" }, dshBaseUrl: undefined }))
  ] }));
  const source = createDsBotAutomationRuleOwner({ rolesRoot: () => roles, identity: () => ({ applicationGenerationId: "fixture", managerInstanceId: "fixture" }) });
  const calls = [], diagnostics = [];
  let complete;
  const delivered = new Promise(resolve => { complete = resolve; });
  const receipt = request => ({ statusCode: 200, data: { dsBot: { state: "accepted", botScopeId: "scope", botId: "bot", deliveryId: request.deliveryId } } });
  const record = (kind, request) => {
    assert.match(request.dsBot.scheduledAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(new Date(request.dsBot.scheduledAt).toISOString(), request.dsBot.scheduledAt);
    assert.equal(request.agentAdapter, "dsh"); assert.equal(request.threadId, undefined); assert.equal(request.messageSource, undefined);
    assert.match(request.prompt, /Business\n\n\[用户模板补充\]\nFor Standalone; \{routeName\}/);
    calls.push({ kind, request }); if (calls.length >= 3) complete();
  };
  const transport = {
    instances: () => [{ instanceId: "remote", local: false, connected: true, agents: [] }],
    async manage(id, request) { assert.equal(id, "remote"); record("remote", request); return receipt(request); },
    async peer(owner, request) { assert.deepEqual(owner, peerBinding); record("peer", request); return receipt(request); }
  };
  const ports = {
    managerOperationalLog: { record(_level, event, detail) { diagnostics.push({ event, detail }); } },
    agentThreadRequestOptions(request, extra) { return { allowedWorkspaces: [], dshBaseUrl: request.dshBaseUrl, ...extra,
      async invokeAgentOperation(provider, operation, payload) {
        assert.equal(provider, "dsh"); assert.equal(operation, "ds-bot.request"); assert.equal(payload.baseUrl, target.dshBaseUrl);
        return executeDsBotRequestOnOwner(payload.request, { baseUrl: payload.baseUrl, request: async (_endpoint, body) => {
          assert.equal(body.scheduledAt, payload.request.dsBot.scheduledAt);
          record("local", payload.request); return { schemaVersion: 1, state: "accepted", ...body, sessionId: "native-session", requestId: body.deliveryId };
        } });
      } }; },
    async handleAgentThreadRequest(request, options) { options.requestAuthority(); return await routeInstanceThread(request, transport) ?? handleAgentThreadRequest(request, options); }
  };
  const scheduler = createOwnedRuntime(ports).createScheduler(source);
  t.after(async () => { await scheduler.stop(); await source.dispose(); });
  await scheduler.start();
  await Promise.race([delivered, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Native routes did not receive their schedules.")), 5000); timer.unref(); })]);
  await new Promise(resolve => setTimeout(resolve, 20));
  await scheduler.stop();
  assert.deepEqual(new Set(calls.map(call => call.kind)), new Set(["local", "remote", "peer"]));
  assert.ok(diagnostics.some(item => item.event === "role_automation_delivery_failed" && item.detail.automationRuleId === "offline"));
  const ledger = (await fs.readFile(path.join(root, "ledger", "automation-executions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const call of calls) assert.ok(ledger.some(item => item.runId === call.request.deliveryId && item.scheduledAt === call.request.dsBot.scheduledAt));
  assert.equal(ledger.filter(item => item.status === "accepted").length, 3);
  assert.equal(ledger.filter(item => item.status === "failed").length, 1);
});
