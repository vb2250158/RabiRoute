import assert from "node:assert/strict";
import test from "node:test";
import { createRoleEditorActions } from "../../src/plugins/io.rabiroute.manager.persona/web/persona/roleEditorActions";
import type { GatewayDefinition } from "../src/types";

function fixture() {
  const draft = { id: "role", gatewayPort: 0, automationRules: [], heartbeatSkipWhenAgentBusy: true } as GatewayDefinition;
  let changes = 0;
  const actions = createRoleEditorActions(() => draft, () => { changes++; });
  return { draft, actions, changes: () => changes };
}

test("new scheduled tasks have their own normal-delivery default", () => {
  const { draft, actions } = fixture();
  const id = actions.addAutomation("schedule", "deliver_agent");
  const rule = draft.automationRules!.find(rule => rule.id === id)!;
  assert.equal(rule.trigger.type, "schedule");
  if (rule.trigger.type !== "schedule") return;
  assert.equal(rule.trigger.schedule.skipWhenAgentBusy, false);
  assert.equal(rule.trigger.schedule.enabled, true);
});

test("reenabling a legacy task restores its disabled schedule without changing identity or scope", () => {
  const { draft, actions, changes } = fixture();
  draft.automationRules = [{ id: "old", enabled: true, sourceRouteIds: ["route-a", "missing-route"],
    trigger: { type: "schedule", schedule: { id: "old-time", type: "daily_time", timeOfDay: "09:30", enabled: false } },
    action: { type: "run_script", scriptPath: "check.py" } }];
  actions.updateAutomation("old", { enabled: true });
  const rule = draft.automationRules[0];
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.sourceRouteIds, ["route-a", "missing-route"]);
  assert.deepEqual(JSON.parse(JSON.stringify(rule.trigger)), { type: "schedule", schedule: { id: "old-time", type: "daily_time", timeOfDay: "09:30", enabled: true } });
  actions.updateAutomation("old", { enabled: false });
  assert.equal(draft.automationRules[0].enabled, false);
  assert.equal(changes(), 2);
});
