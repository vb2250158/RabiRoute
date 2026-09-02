import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const personaPage = fs.readFileSync(
  new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url),
  "utf8"
);
const panel = fs.readFileSync(
  new URL("../src/components/PersonaDesktopPetPanel.vue", import.meta.url),
  "utf8"
);
const desktopSettings = fs.readFileSync(
  new URL("../src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url),
  "utf8"
);

test("desktop pet configuration belongs to the current persona page", () => {
  assert.match(personaPage, /<v-tab value="avatar"[^>]*>虚拟形象<\/v-tab>/);
  assert.match(personaPage, /<PersonaDesktopPetPanel[^>]*:persona-id="gateway\.agentRoleId \|\| ''"/);
  assert.doesNotMatch(desktopSettings, /夜雨桌宠|启用桌宠|desktopPetClient|petBinding/);
});

test("persona desktop pet editor separates persona assets from local display preferences", () => {
  assert.match(panel, /desktopPetClient\.binding\(personaId\)/);
  assert.match(panel, /desktopPetClient\.packs\(personaId\)/);
  assert.match(panel, /label="在本机启用"/);
  assert.match(panel, /动作素材保存在[\s\S]*personaId[\s\S]*人格目录/);
  assert.match(panel, /大小、位置和窗口行为只影响这台电脑，不随人格同步/);
  assert.match(panel, /registerPageSaveAction/);
  assert.match(panel, /if \(store\.dirty\) await store\.save\(\)/);
  assert.doesNotMatch(panel, /const petPersonaId = "YeYu"/);
});

test("desktop pet cannot be enabled before an action pack is selected", () => {
  assert.match(panel, /v-model="binding\.enabled"[\s\S]*:disabled="!loaded \|\| !binding\.packId"/);
  assert.match(panel, /先选择或导入动作素材，再开启桌宠/);
});
