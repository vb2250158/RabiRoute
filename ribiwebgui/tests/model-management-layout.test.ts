import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("model management renders the catalog as a table instead of cards", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  const table = fs.readFileSync(new URL("../src/components/ModelLibraryTable.vue", import.meta.url), "utf8");
  assert.match(source, /<ModelLibraryTable v-else :rows="speechRows" :labels="copy" :loading="loading">/);
  assert.match(table, /<table class="model-table">/);
  assert.match(table, /<th scope="col" class="model-column">\{\{ labels\.model \}\}<\/th>/);
  assert.match(table, /<template v-for="row in rows" :key="row\.id">/);
  assert.match(table, /<td colspan="6">/);
  assert.doesNotMatch(source, /class="model-grid"|class="model-card app-card"/);
});

test("environment and jobs use compact rows with collapsed guidance", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  assert.match(source, /<section class="environment-bar"/);
  assert.match(source, /<section v-if="displayedJob && .*" class="job-row" role="status"/);
  assert.match(source, /activeJob\.value \?\? snapshot\.value\?\.lastJob/);
  assert.match(source, /<details class="model-help">\s*<summary>/);
  assert.doesNotMatch(source, /runtime-grid|runtime-card|job-card|section-kicker|01 \/ RUNTIME|02 \/ TASK|03 \/ CATALOG|min-height: 250px/);
  assert.match(source, /@click="installRuntime"/);
  assert.match(source, /@click="installModel\(model\)"/);
  assert.match(source, /speech_model_management_changed/);
});

test("model requirements do not claim an isolated environment is missing", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  assert.match(source, /download: "下载模型"/);
  assert.match(source, /download: "Download model"/);
  assert.match(source, /isolatedRuntime: "需独立环境"/);
  assert.match(source, /isolatedRuntime: "Requires an isolated environment"/);
  assert.doesNotMatch(source, /还需要单独安装隔离运行环境/);
  assert.match(source, /!model\.downloaded/);
});

test("catalog defaults to TTS and searches only the selected one of three capabilities", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  assert.match(source, /tab === "asr".*\? tab : "tts"/);
  assert.match(source, /const models = computed\(\(\) => \(snapshot\.value\?\.models \?\? \[\]\)\.filter\(model => model\.capability === capability\.value\)\);/);
  assert.match(source, /return models\.value\.flatMap\(model =>/);
  assert.doesNotMatch(source, /"all"|copy\.value\.all|all: "全部"/);
  const items = source.match(/const capabilityItems = computed<[^\n]+>\(\(\) => \[([\s\S]*?)\]\);/);
  assert.ok(items);
  assert.deepEqual([...items[1].matchAll(/value: "([^"]+)"/g)].map(match => match[1]), ["tts", "asr", "speaker", "image", "video"]);
});

test("directory editing is collapsed, local-only and saved through the Manager", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");
  assert.match(source, /<details class="model-help directory-settings">/);
  assert.match(source, /v-if="directoryLocalOnly"/);
  assert.match(source, /expectedRevision: directorySettings\.value\.revision/);
  assert.match(source, /directorySaving \|\| Boolean\(activeJob\)/);
  assert.match(source, /await speechModelManagementClient\.updateDirectorySettings/);
  assert.match(source, /directorySaved\.value = true;\s*await loadSnapshot\(\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("compact controls retain accessible names, selection and theme tokens", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  assert.match(source, /:aria-label="copy\.search"/);
  assert.match(source, /:aria-label="copy\.refresh"/);
  assert.match(source, /:aria-pressed="capability === item\.value"/);
  const table = fs.readFileSync(new URL("../src/components/ModelLibraryTable.vue", import.meta.url), "utf8");
  assert.match(table, /class="model-table-shell" tabindex="0" role="region"/);
  assert.match(source, /summary:focus-visible/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /\.capability-filter \{ flex-wrap: wrap; \}/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|color: white|linear-gradient/);
});
