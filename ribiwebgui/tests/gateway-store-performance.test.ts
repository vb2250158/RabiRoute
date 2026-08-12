import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storeSource = fs.readFileSync(
  new URL("../src/stores/gatewayStore.ts", import.meta.url),
  "utf8"
);
const personaSyncSource = fs.readFileSync(
  new URL("../src/components/PersonaSyncCard.vue", import.meta.url),
  "utf8"
);
const personaPageSource = fs.readFileSync(
  new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url),
  "utf8"
);
const personaSyncPageSource = fs.readFileSync(
  new URL("../src/pages/PersonaSyncPage.vue", import.meta.url),
  "utf8"
);

test("the WebGUI paints from the compact gateway payload before requesting diagnostics", () => {
  assert.match(storeSource, /fetch\(`\$\{apiBase\}\/gateways\?summary=1&includeConfig=1`\)/);
  assert.match(storeSource, /async function ensureDiagnostics/);
  assert.doesNotMatch(storeSource, /async function load\([^)]*\)[\s\S]{0,800}fetch\(`\$\{apiBase\}\/gateways`\)/);
});

test("persona sync leaves the unbounded conflict catalog behind an explicit action", () => {
  const initialRefresh = personaSyncSource.match(/async function refreshAll[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(initialRefresh, /refreshConflicts|personaSyncClient\.conflicts/);
  assert.match(personaSyncSource, /@click="refreshConflicts"[^>]*>检查冲突/);
});

test("persona sync opens as an independent Changed Files workspace", () => {
  assert.doesNotMatch(personaPageSource, /<PersonaSyncCard/);
  assert.match(personaPageSource, /多电脑人格同步/);
  assert.match(personaSyncPageSource, /<PersonaSyncCard/);
  assert.match(personaSyncSource, /CHANGED FILES/);
  assert.match(personaSyncSource, /拉取并同步/);
});

test("persona voice history is not scanned before the user opens that panel", () => {
  const roleWatcher = personaPageSource.match(/watch\(\(\) => gateway\.value\?\.agentRoleId[\s\S]*?\}, \{ immediate: true \}\);/)?.[0] || "";
  assert.doesNotMatch(roleWatcher, /refreshVoiceIdentityReview/);
  assert.match(personaPageSource, /voiceIdentityLoaded\.value && relevantPersonaSyncEvent/);
});
