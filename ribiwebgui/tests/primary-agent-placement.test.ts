import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");

test("primary Agent selector belongs to the Agent section before the Agent list", () => {
  const messageSectionIndex = source.indexOf('<div class="section-title">消息端</div>');
  const agentSectionIndex = source.indexOf('<div class="section-title">Agent 端</div>');
  const primarySelectorIndex = source.indexOf('label="主控 Agent"');
  const agentListIndex = source.indexOf('<div class="catalog-list mb-2">', agentSectionIndex);

  assert.ok(messageSectionIndex >= 0);
  assert.ok(agentSectionIndex > messageSectionIndex);
  assert.ok(primarySelectorIndex > agentSectionIndex);
  assert.ok(agentListIndex > primarySelectorIndex);
});

test("Codex managed-task controls are rendered through capability gates", () => {
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'messageProcessingAgent'\)/);
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'planAssistantSessions'\)/);
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'hooks'\)/);
  assert.doesNotMatch(source, /此 Agent 类型暂时只保存配置/);
});
