import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storeSource = fs.readFileSync(
  new URL("../src/stores/gatewayStore.ts", import.meta.url),
  "utf8"
);
const personaPageSource = fs.readFileSync(
  new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url),
  "utf8"
);

test("the WebGUI paints from the compact gateway payload before requesting diagnostics", () => {
  assert.match(storeSource, /fetch\(`\$\{apiBase\}\/gateways\?summary=1&includeConfig=1`\)/);
  assert.match(storeSource, /async function ensureDiagnostics/);
  assert.doesNotMatch(storeSource, /async function load\([^)]*\)[\s\S]{0,800}fetch\(`\$\{apiBase\}\/gateways`\)/);
});

test("persona sync UI sources and requests have been removed", () => {
  for (const source of ["components/PersonaSyncCard.vue", "pages/PersonaSyncPage.vue", "persona/personaSyncClient.ts"]) {
    assert.equal(fs.existsSync(new URL(`../src/${source}`, import.meta.url)), false);
  }
  const contributions = fs.readFileSync(new URL("../src/bundles/builtinWebContributions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(contributions, /PersonaSync|persona-sync|persona\/sync/);
  assert.doesNotMatch(personaPageSource, /PersonaSync|persona_sync|persona-sync/);
  assert.match(personaPageSource, /persona_chat_history_changed/);
  assert.match(personaPageSource, /identity_relation_changed/);
});

test("persona voice history is not scanned before the user opens that panel", () => {
  const roleWatcher = personaPageSource.match(/watch\(\(\) => gateway\.value\?\.agentRoleId[\s\S]*?\}, \{ immediate: true \}\);/)?.[0] || "";
  assert.doesNotMatch(roleWatcher, /refreshVoiceIdentityReview/);
  assert.match(personaPageSource, /voiceIdentityLoaded\.value && relevantPersonaEvent/);
});
