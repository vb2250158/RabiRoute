import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SCREENSHOT_SHORTCUT, normalizeDesktopSettings } from "../shared/desktopSettingsContract.js";
import { DesktopSettingsStore } from "./desktopSettings.js";

test("desktop settings keep screenshot defaults and normalize persisted values", () => {
  assert.deepEqual(normalizeDesktopSettings({ screenshot: { enabled: true, shortcut: "  Ctrl+Alt+S  " }, autostart: true }), {
    screenshot: { enabled: true, shortcut: "Ctrl+Alt+S" },
    autostart: true
  });
  assert.equal(normalizeDesktopSettings({}).screenshot.shortcut, DEFAULT_SCREENSHOT_SHORTCUT);
});

test("desktop settings store writes and reads the single host settings file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-settings-"));
  const filePath = path.join(root, "settings.json");
  try {
    const store = new DesktopSettingsStore(filePath);
    assert.equal(store.read().screenshot.enabled, false);
    store.write({ screenshot: { enabled: true, shortcut: "Ctrl+Shift+S" }, autostart: true });
    assert.deepEqual(store.read(), {
      screenshot: { enabled: true, shortcut: "Ctrl+Shift+S" },
      autostart: true
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
