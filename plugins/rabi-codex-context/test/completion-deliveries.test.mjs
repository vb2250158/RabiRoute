import assert from "node:assert/strict";
import test from "node:test";
import { handleHookInput as codexHook } from "../scripts/lib/rabi-manager-client.mjs";
import { handleHookInput as workbuddyHook } from "../../rabi-workbuddy-context/scripts/lib/rabi-manager-client.mjs";
import { handleAntigravityHookInput as antigravityHook } from "../../rabi-antigravity-context/scripts/lib/rabi-manager-client.mjs";

const producers = [
  ["Codex", codexHook, { session_id: "fixture-codex" }],
  ["WorkBuddy", workbuddyHook, { session_id: "fixture-workbuddy" }],
  ["Antigravity", antigravityHook, { conversationId: "fixture-antigravity" }]
];

/** Pure transport fixture: no Host, installed helper, socket, credentials or message send. */
async function consume(hook, identity, data) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "http://fixture.invalid/api/codex-hook/context");
    assert.equal(init.method, "POST");
    return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  };
  try {
    const output = await hook({ ...identity, hook_event_name: "Stop", turn_id: "fixture-turn", last_assistant_message: "fixture final" }, { managerUrl: "http://fixture.invalid" });
    assert.equal(calls, 1, "consuming a receipt must not retry a message");
    const message = output?.systemMessage || output?.injectSteps?.map(step => step.userMessage).join("\n") || "";
    return { output, message };
  } finally { globalThis.fetch = original; }
}

for (const [name, hook, identity] of producers) {
  test(`${name}: failed completion delivery shows its original ID and recovery state`, async () => {
    const { output, message } = await consume(hook, identity, { completionDeliveries: [{
      ruleId: "fixture-rule", deliveryId: "original-delivery", status: "failed", recoveryState: "blocked", reason: "fixture_target_unavailable"
    }] });
    assert.match(message, /发送失败/);
    assert.match(message, /fixture-rule/);
    assert.match(message, /original-delivery/);
    assert.match(message, /恢复状态 blocked/);
    assert.match(message, /fixture_target_unavailable/);
    assert.equal(output?.decision, undefined, "delivery diagnostics must not block the turn");
  });

  test(`${name}: unknown and uncertain results remain visible without claiming success`, async () => {
    for (const status of ["unknown", "awaiting_confirmation", "uncertain", "unconfirmed", "delivery_unconfirmed"]) {
      const { message } = await consume(hook, identity, { completionDeliveries: [{
        ruleId: "fixture-rule", deliveryId: "original-uncertain", status, recoveryState: "reconciling"
      }] });
      assert.match(message, /送达待确认/);
      assert.match(message, /original-uncertain/);
      assert(message.includes(`投递状态 ${status}`));
      assert.match(message, /恢复状态 reconciling/);
    }
  });

  test(`${name}: legacy failures never invent a missing delivery ID or recovery state`, async () => {
    const { message } = await consume(hook, identity, { completionDeliveries: [{ ruleId: "legacy-rule", status: "failed", reason: "fixture_legacy_failure" }] });
    assert.match(message, /投递编号 未返回/);
    assert.match(message, /恢复状态 未返回/);
    assert.match(message, /fixture_legacy_failure/);
  });

  test(`${name}: successful, skipped and empty completion results remain silent`, async () => {
    for (const data of [{}, { completionDeliveries: [] }, { completionDeliveries: null }, { completionDeliveries: [
      { ruleId: "sent", status: "sent" }, { ruleId: "received", status: "received" },
      { ruleId: "ignored", status: "ignored" }, { ruleId: "skipped", status: "skipped" }
    ] }]) {
      assert.equal((await consume(hook, identity, data)).output, null);
    }
  });

  test(`${name}: completion delivery warnings preserve existing plan failure diagnostics`, async () => {
    const { message } = await consume(hook, identity, {
      planTaskCompletion: { status: "failed", error: "fixture_plan_failure" },
      completionDeliveries: [{ ruleId: "fixture-rule", deliveryId: "original-combined", status: "failed", reason: "fixture_completion_failure" }]
    });
    assert.match(message, /fixture_plan_failure/);
    assert.match(message, /fixture_completion_failure/);
    assert.match(message, /original-combined/);
  });
}
