import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(
  new URL("../../src/plugins/io.rabiroute.manager.speech/web/pages/SpeechServicePage.vue", import.meta.url),
  "utf8"
);

test("speech diagnostics reuses initial hydration, checking local audio only when absent", () => {
  const mountedBlock = pageSource.match(/onMounted\(async \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || "";
  assert.match(mountedBlock, /await speech\.acquire\(unsubscribe => \{ releaseSpeech = unsubscribe; \}\)/);
  assert.match(mountedBlock, /if \(!audioStream\.value\) await refreshHostDiagnostics\(\)/);
  const refresh = pageSource.match(/async function refreshHostDiagnostics[\s\S]*?\n\}/)?.[0] || "";
  assert.match(refresh, /speech\.refreshAudioStreams\(\), speech\.refreshPlayback\(\), speech\.refreshMicrophone\(\)/);
  assert.doesNotMatch(pageSource, /speech\.(startRuntime|stopRuntime|startMicrophone)\(/);
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
