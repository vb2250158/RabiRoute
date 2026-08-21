import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const performanceSource = fs.readFileSync(new URL("../src/pages/PerformancePage.vue", import.meta.url), "utf8");
const routeDirectorySource = fs.readFileSync(new URL("../src/pages/RouteDirectoryPage.vue", import.meta.url), "utf8");
const pageSaveActionSource = fs.readFileSync(new URL("../src/pageSaveAction.ts", import.meta.url), "utf8");

test("configuration pages delegate saving to the single top-bar Save configuration action", () => {
  assert.match(appSource, /pageSaveAction/);
  assert.match(appSource, /activePageSaveAction/);
  assert.match(appSource, /await activePageSaveAction\.value\.save\(\)/);
  assert.match(settingsSource, /registerPageSaveAction\(/);
  assert.match(settingsSource, /async function saveSettings\(\): Promise<void>/);
  assert.match(settingsSource, /await Promise\.allSettled\(\[/);
  assert.doesNotMatch(settingsSource, /@click="saveDesktopSettings"/);
  assert.doesNotMatch(settingsSource, /@click="saveSelectionSpeechSettings"/);
  assert.doesNotMatch(settingsSource, /@click="saveRabiIdentity"/);
  assert.doesNotMatch(settingsSource, /@click="saveDirConfig"/);
  assert.match(performanceSource, /registerPageSaveAction\(/);
  assert.match(performanceSource, /async function saveConfig\(\): Promise<void>/);
  assert.doesNotMatch(performanceSource, /@click="saveConfig"/);
  assert.match(routeDirectorySource, /registerPageSaveAction\(/);
  assert.doesNotMatch(routeDirectorySource, /@click="save"/);
  assert.match(pageSaveActionSource, /registerPageSaveAction/);
});


test("no page keeps a lower save handler", () => {
  const pagesDir = new URL("../src/pages/", import.meta.url);
  for (const filename of fs.readdirSync(pagesDir)) {
    if (!filename.endsWith(".vue")) continue;
    const source = fs.readFileSync(path.join(fileURLToPath(pagesDir), filename), "utf8");
    assert.doesNotMatch(source, /@click="save(?:[A-Z][A-Za-z0-9_]*)?"/, `${filename} keeps a page-level save button`);
  }
});
