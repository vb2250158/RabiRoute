import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(
  new URL("../src/pages/SpeechServicePage.vue", import.meta.url),
  "utf8"
);

test("speech page performs one initial runtime hydration and reuses its result", () => {
  const mountedBlock = pageSource.match(/onMounted\(async \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || "";
  assert.match(mountedBlock, /releaseSpeech = await speech\.acquire\(\)/);
  assert.doesNotMatch(mountedBlock, /hydrateRuntimeUi/);
  assert.match(mountedBlock, /await syncRuntimeUiFromStore\(\)/);

  const toggleBlock = pageSource.match(/async function toggleRuntime[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(toggleBlock, /await hydrateRuntimeUi\(\)/);
  assert.match(toggleBlock, /await syncRuntimeUiFromStore\(\)/);

  const syncBlock = pageSource.match(/async function syncRuntimeUiFromStore[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(syncBlock, /speech\.refresh/);
});

test("collapsed device history is not fetched or mounted until the user expands it", () => {
  assert.match(pageSource, /if \(audioLogExpanded\.value\) void loadAudioHistory\(\)/);
  assert.match(pageSource, /v-if="audioLogExpanded"/);
  assert.doesNotMatch(pageSource, /v-show="audioLogExpanded"/);

  const selectedDeviceWatch = pageSource.match(
    /watch\(\s*\(\) => selectedAudioStreamClient\.value\?\.sourceDeviceId[\s\S]*?\n\);/
  )?.[0] || "";
  assert.match(selectedDeviceWatch, /if \(audioLogExpanded\.value\)/);
});
