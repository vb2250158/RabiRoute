import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ref } from "vue";
import { pageSaveAction, registerPageSaveAction } from "../src/pageSaveAction";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../src/pages/SettingsPage.vue", import.meta.url), "utf8");
const performanceSource = fs.readFileSync(new URL("../src/pages/PerformancePage.vue", import.meta.url), "utf8");
const desktopRendererSource = fs.readFileSync(new URL("../src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
const pageSaveActionSource = fs.readFileSync(new URL("../src/pageSaveAction.ts", import.meta.url), "utf8");

test("page save command delegates to every active page save participant", async () => {
  const calls: string[] = [];
  const first = registerPageSaveAction({
    dirty: ref(true), ready: ref(true), saving: ref(false), save: async () => { calls.push("first"); }
  });
  const second = registerPageSaveAction({
    dirty: ref(false), ready: ref(true), saving: ref(false), save: async () => { calls.push("second"); }
  });
  try {
    assert.equal(pageSaveAction.value?.dirty.value, true);
    assert.equal(pageSaveAction.value?.ready.value, true);
    await pageSaveAction.value?.save();
    assert.deepEqual(calls, ["first", "second"]);
  } finally {
    second();
    first();
  }
  assert.equal(pageSaveAction.value, null);
});

test("configuration pages and trusted settings renderers register save participants", () => {
  assert.match(appSource, /handlerId: "web\.save-page"|web\.save-page/);
  assert.match(appSource, /activePageSaveAction/);
  assert.match(settingsSource, /registerPageSaveAction\(/);
  assert.match(desktopRendererSource, /registerPageSaveAction\(/);
  assert.match(performanceSource, /registerPageSaveAction\(/);
  assert.match(pageSaveActionSource, /registeredActions/);
  assert.doesNotMatch(settingsSource, /@click="saveSelectionSpeechSettings"/);
  assert.doesNotMatch(desktopRendererSource, /@click="save"/);
  assert.doesNotMatch(performanceSource, /@click="saveConfig"/);
});

test("obsolete unregistered pages are deleted", () => {
  const pagesDir = fileURLToPath(new URL("../src/pages/", import.meta.url));
  assert.equal(fs.existsSync(path.join(pagesDir, "RouteDirectoryPage.vue")), false);
  assert.equal(fs.existsSync(path.join(pagesDir, "ProjectDocsEnglish.vue")), false);
});

test("no page keeps a lower save handler", () => {
  const pagesDir = new URL("../src/pages/", import.meta.url);
  for (const filename of fs.readdirSync(pagesDir)) {
    if (!filename.endsWith(".vue")) continue;
    const source = fs.readFileSync(path.join(fileURLToPath(pagesDir), filename), "utf8");
    assert.doesNotMatch(source, /@click="save(?:[A-Z][A-Za-z0-9_]*)?"/, `${filename} keeps a page-level save button`);
  }
});
