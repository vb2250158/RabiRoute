import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { automationEndpoint, automationEndpoints } from "../../src/plugins/io.rabiroute.manager.persona/web/persona/automationEndpoints";
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

test("speech rules use the speech service category and retain legacy filters", () => {
  for (const endpointType of [undefined, "speech", "fennenote"]) {
    const rule = messageRule(["voice_transcript"]);
    if (rule.trigger.type !== "message") throw new Error("message fixture required");
    Object.assign(rule.trigger, { endpointType, allowedSpeakerNames: ["Speaker"], regex: "hello" });
    const snapshot = JSON.stringify(rule);
    assert.equal(automationEndpoint(rule), "speech");
    assert.equal(JSON.stringify(rule), snapshot);
  }
  assert.equal(automationEndpoints.find(endpoint => endpoint.value === "speech")?.title, "语音服务");
  assert.ok(!automationEndpoints.some(endpoint => endpoint.value === "fennenote"));
});

test("creating a rule offers manual and template previews with an explicit Create button", () => {
  const page = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  const start = page.indexOf('class="app-card glass-card section-card automation-workspace"');
  const end = page.indexOf('<v-dialog v-model="templateVariablesDialog"');
  assert.ok(start >= 0 && end > start);
  const workspace = page.slice(start, end);
  assert.doesNotMatch(workspace, /<v-menu|value="schedule"|定制任务/);
  assert.match(workspace, /@click="openAutomationCreation">.*新增定时任务/);
  assert.match(page, /v-model="automationCreationDialog"[\s\S]*通过模板创建[\s\S]*手动创建/);
  assert.match(page, /<v-select\s+:model-value="selectedAutomationTemplateId \|\| activeAutomation.action.type"[\s\S]*@update:model-value="selectAutomationAction"/);
  assert.doesNotMatch(page, /timerInputEnabled|enableTimerInput/);
  assert.match(page, /patchAutomationSchedule\(\{ skipWhenAgentBusy:/);
  assert.match(page, /@click="confirmAutomationPreview"[^>]*>{{ t\('新建'\) }}/);
  assert.match(page, /<AutomationEndpointNav v-model="selectedAutomationEndpoint"/);
  assert.match(page, /<AutomationEndpointNav v-model="selectedEndpoint"/);
});
