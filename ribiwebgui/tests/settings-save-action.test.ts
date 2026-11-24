import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nextTick, ref, watch } from "vue";
import { pageSaveAction, registerPageSaveAction } from "../src/pageSaveAction";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const commandSource = fs.readFileSync(new URL("../src/pluginCommands.ts", import.meta.url), "utf8");
const settingsSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/pages/SettingsPage.vue", import.meta.url), "utf8");
const performanceSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.performance/web/pages/PerformancePage.vue", import.meta.url), "utf8");
const desktopRendererSource = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.desktop/web/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
const pageSaveActionSource = fs.readFileSync(new URL("../src/pageSaveAction.ts", import.meta.url), "utf8");

test("background saves start independently and drain newer edits in order", async () => {
  const input = ref(0);
  const persisted = ref(0);
  const dirty = ref(false);
  const stop = watch(input, value => { dirty.value = value !== persisted.value; }, { flush: "sync" });
  const calls: number[] = [];
  let release!: () => void;
  const holdFirst = new Promise<void>(resolve => { release = resolve; });
  const save = registerPageSaveAction({
    dirty, ready: ref(true), saving: ref(false),
    save: async () => {
      const value = input.value;
      calls.push(value);
      if (value === 1) await holdFirst;
      persisted.value = value;
      dirty.value = input.value !== value;
    }
  }, 0, input);
  let otherSaved = false;
  const otherDirty = ref(true);
  const other = registerPageSaveAction({
    dirty: otherDirty, ready: ref(true), saving: ref(false),
    save: async () => { otherSaved = true; otherDirty.value = false; }
  }, 0);
  try {
    input.value = 1;
    await nextTick();
    assert.deepEqual(calls, [1]);
    assert.equal(otherSaved, true);
    input.value = 2;
    release();
    await save.flush();
    assert.deepEqual(calls, [1, 2]);
    assert.equal(pageSaveAction.value?.dirty.value, false);
  } finally {
    release();
    other();
    save();
    stop();
  }
  assert.equal(pageSaveAction.value, null);
});

test("failed background writes hold the draft and retry through the same owner", async () => {
  const dirty = ref(true);
  let attempts = 0;
  const save = registerPageSaveAction({
    dirty, ready: ref(true), saving: ref(false),
    save: async () => {
      if (++attempts === 1) throw new Error("connection lost");
      dirty.value = false;
    }
  }, 0);
  try {
    await save.flush();
    assert.equal(attempts, 1);
    assert.equal(dirty.value, true);
    assert.equal(save.failure.value, "connection lost");
    await save.flush();
    assert.equal(attempts, 2);
    assert.equal(dirty.value, false);
  } finally { save(); }
});

test("configuration pages and trusted settings renderers register save participants", () => {
  assert.match(commandSource, /handlerId: "web\.save-page"/);
  assert.match(appSource, /command.handlerId !== "web\.save-page"/);
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
    const pageTemplate = source.replace(/<v-dialog\b[^>]*>[\s\S]*?<\/v-dialog>/g, "");
    assert.doesNotMatch(pageTemplate, /@click="save(?:[A-Z][A-Za-z0-9_]*)?"/, `${filename} keeps a page-level save button`);
  }
});
