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
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'messageProcessingAgent'\) && primaryAgentType === agent\.type/);
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'memoryConsolidationAgent'\)/);
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'planAssistantSessions'\)/);
  assert.match(source, /supportsManagedTaskFeature\(agent\.type, 'hooks'\)/);
  assert.doesNotMatch(source, /此 Agent 类型暂时只保存配置/);
});

test("Codex exposes an opt-in dedicated memory consolidation Agent with the Terra default", () => {
  assert.match(source, /gateway\.codexMemoryConsolidationAgentEnabled === true/);
  assert.match(source, /DEFAULT_CODEX_MEMORY_CONSOLIDATION_AGENT_MODEL/);
  assert.match(source, /记忆整理/);
});

test("message-processing board opens on demand for the managed primary Agent", () => {
  assert.match(source, /defineAsyncComponent\(\(\) => import\("\.\.\/components\/MessageProcessingBoard\.vue"\)\)/);
  assert.match(source, /const messageProcessingBoardOpen = ref\(false\)/);
  assert.match(source, /primaryMessageProcessingAgentEnabled\(gateway\.value\)/);
  assert.match(source, /v-if="messageProcessingAgentPolicy\(agent\.type\)\.enabled"/);
  assert.match(source, /打开消息处理看板/);
  assert.match(source, /<v-dialog v-model="messageProcessingBoardOpen" max-width="1200" scrollable>/);
  assert.match(source, /v-if="messageProcessingBoardOpen && managedMessageAgentModeEnabled"/);
});
