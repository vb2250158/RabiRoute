import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { automationEndpoint, automationEndpoints } from "../src/persona/automationEndpoints";
import type { PersonaAutomationRuleDefinition } from "../src/types";

function messageRule(routeKinds: string[]): PersonaAutomationRuleDefinition {
  return { id: "test-rule", trigger: { type: "message", routeKinds }, action: { type: "deliver_agent" } };
}

test("each selectable message type returns to the same category after saving", () => {
  for (const endpoint of automationEndpoints.filter(option => option.value !== "schedule")) {
    assert.equal(automationEndpoint(messageRule([...endpoint.routeKinds])), endpoint.value);
  }
});

test("all schedule modes share the scheduled-task category for either action", () => {
  for (const type of ["interval", "daily_time", "once_at"] as const) {
    for (const action of [{ type: "deliver_agent" }, { type: "run_script", scriptPath: "check.py" }] as const) {
      assert.equal(automationEndpoint({ id: "schedule", trigger: { type: "schedule", schedule: { id: "time", type } }, action }), "schedule");
    }
  }
});

test("legacy, broad, and unknown rules remain visible without changing their filters", () => {
  for (const kinds of [[], ["future_message"], ["heartbeat"]]) {
    const rule = messageRule(kinds);
    const snapshot = JSON.stringify(rule);
    assert.equal(automationEndpoint(rule), "webhook");
    assert.equal(JSON.stringify(rule), snapshot);
  }
  assert.equal(automationEndpoint(messageRule(["private", "weixin_message"])), "napcat");
});

test("new rules open the editor directly and schedules use the shared workspace", () => {
  const page = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  const start = page.indexOf('class="section-title-row automation-workspace-head"');
  const end = page.indexOf('<v-dialog v-model="templateVariablesDialog"');
  assert.ok(start >= 0 && end > start);
  const workspace = page.slice(start, end);
  assert.doesNotMatch(workspace, /<v-menu|value="schedule"|定制任务/);
  assert.match(page, /@click="createAutomation">新增消息规则/);
  assert.match(page, /function createAutomation\(\)[\s\S]*store\.addAutomation\([\s\S]*openAutomation\(id\)/);
  assert.match(page, /<AutomationEndpointNav v-model="selectedAutomationEndpoint"/);
  assert.match(page, /<AutomationEndpointNav v-model="selectedEndpoint"/);
});
