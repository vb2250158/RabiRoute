import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/PersonaTemplatePage.vue", import.meta.url),
  "utf8"
);

function pageSection(value: string, nextValue?: string): string {
  const start = source.indexOf(`<v-window-item value="${value}">`);
  const end = nextValue
    ? source.indexOf(`<v-window-item value="${nextValue}">`, start + 1)
    : source.indexOf('<v-dialog v-model="automationDialog"', start + 1);
  assert.ok(start >= 0, `missing ${value} section`);
  assert.ok(end > start, `missing end of ${value} section`);
  return source.slice(start, end);
}

test("persona configuration splits dense content into accessible page tabs", () => {
  assert.match(source, /v-model="activePersonaPageTab"/);
  assert.match(source, /:aria-label="t\('角色配置分区'\)"/);
  assert.match(source, /<v-tab value="profile"[^>]*>基础资料<\/v-tab>/);
  assert.match(source, /<v-tab value="expression"[^>]*:disabled="!hasPersona"[^>]*>表达与语音<\/v-tab>/);
  assert.match(source, /<v-tab value="avatar"[^>]*:disabled="!hasPersona"[^>]*>虚拟形象<\/v-tab>/);
  assert.match(source, /<v-tab value="identity"[^>]*:disabled="!hasPersona"[^>]*>身份关系<\/v-tab>/);
  assert.doesNotMatch(source, /<v-tab value="(?:context|companion)"/);
  assert.doesNotMatch(source, /<v-window-item value="(?:context|companion)"/);
  assert.match(source, /<v-tab value="automation"[^>]*>自动化<\/v-tab>/);
  assert.match(source, /watch\(hasPersona,[\s\S]*\["expression", "avatar", "identity"\][\s\S]*activePersonaPageTab\.value = "profile"/);
});

test("each persona page tab owns one coherent group of existing cards", () => {
  assert.match(pageSection("profile", "expression"), /角色配置[\s\S]*persona\.md 摘要/);
  assert.match(pageSection("expression", "avatar"), /语言风格风控[\s\S]*角色语音[\s\S]*语音唤醒/);
  assert.match(pageSection("avatar", "identity"), /PersonaDesktopPetPanel/);
  assert.match(pageSection("avatar", "identity"), /<PersonaCompanionActivity[^>]*activePersonaPageTab === 'avatar'/);
  assert.match(pageSection("identity", "automation"), /<PersonaIdentityRelationsCard[\s\S]*声纹识别工具/);
  const automationDialog = source.slice(source.indexOf('<v-dialog v-model="automationDialog"'));
  assert.match(automationDialog, /activeAutomation\.action\.type === 'deliver_agent'[\s\S]*activeAutomation\.trigger\.type === 'message'[\s\S]*label="携带最近消息"[\s\S]*label="最近消息条数"/);
  assert.match(automationDialog, /setAutomationRecentMessageLimit\(value \? DEFAULT_RECENT_MESSAGE_LIMIT : 0\)/);
  assert.match(automationDialog, /:model-value="automationRecentMessageLimit"[\s\S]*@update:model-value="setAutomationRecentMessageLimit"/);
  assert.doesNotMatch(pageSection("automation"), /路由变量/);
  const routePage = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.message-adapter-control/web/pages/RouteConfigPage.vue", import.meta.url), "utf8");
  assert.doesNotMatch(routePage, /RouteVariablesEditor/);
  assert.match(pageSection("automation"), /默认消息规则[\s\S]*automationWorkspaceTab[\s\S]*可用模板变量/);
});
