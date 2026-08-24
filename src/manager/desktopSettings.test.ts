import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT,
  DEFAULT_SCREENSHOT_SHORTCUT,
  normalizeDesktopSettings
} from "../shared/desktopSettingsContract.js";
import { DesktopSettingsStore } from "./desktopSettings.js";

test("desktop settings keep screenshot defaults and migrate the game-conflicting legacy F3 binding", () => {
  assert.deepEqual(normalizeDesktopSettings({ screenshot: {
    enabled: true,
    shortcut: "  Ctrl+Alt+S  ",
    clipboardShortcut: " F3 ",
    autoCopy: false
  }, autostart: true }), {
    screenshot: { enabled: true, shortcut: "Ctrl+Alt+S", clipboardShortcut: "Ctrl+Alt+V", autoCopy: false },
    autostart: true,
    theme: "system"
  });
  assert.equal(normalizeDesktopSettings({}).screenshot.shortcut, DEFAULT_SCREENSHOT_SHORTCUT);
  assert.equal(normalizeDesktopSettings({}).screenshot.clipboardShortcut, DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT);
  assert.equal(normalizeDesktopSettings({}).screenshot.autoCopy, true);
});

test("desktop settings accept only the shared theme values", () => {
  assert.equal(normalizeDesktopSettings({ theme: "dark" }).theme, "dark");
  assert.equal(normalizeDesktopSettings({ theme: "light" }).theme, "light");
  assert.equal(normalizeDesktopSettings({ theme: "system" }).theme, "system");
  assert.equal(normalizeDesktopSettings({ theme: "midnight" }).theme, "system");
});

test("desktop settings store writes and reads the single host settings file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-settings-"));
  const filePath = path.join(root, "settings.json");
  try {
    const store = new DesktopSettingsStore(filePath);
    assert.equal(store.read().screenshot.enabled, false);
    store.write({ screenshot: { enabled: true, shortcut: "Ctrl+Shift+S", clipboardShortcut: "F3", autoCopy: false }, autostart: true });
    assert.deepEqual(store.read(), {
      screenshot: { enabled: true, shortcut: "Ctrl+Shift+S", clipboardShortcut: "Ctrl+Alt+V", autoCopy: false },
      autostart: true,
      theme: "system"
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
