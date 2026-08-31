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

test("desktop settings keep the safe default while preserving an explicit F3 binding", () => {
  assert.deepEqual(normalizeDesktopSettings({ screenshot: {
    enabled: true,
    shortcut: "  Ctrl+Alt+S  ",
    clipboardShortcut: " F3 ",
    autoCopy: false
  }, autostart: true }), {
    screenshot: { enabled: true, shortcut: "Ctrl+Alt+S", clipboardShortcut: "F3", autoCopy: false },
    autostart: true,
    theme: "system",
    webTheme: "system",
    customThemes: [],
    pets: {}
  });
  assert.equal(normalizeDesktopSettings({}).screenshot.shortcut, DEFAULT_SCREENSHOT_SHORTCUT);
  assert.equal(normalizeDesktopSettings({ screenshot: { clipboardShortcut: "F3" } }).screenshot.clipboardShortcut, "F3");
  assert.equal(normalizeDesktopSettings({}).screenshot.clipboardShortcut, DEFAULT_SCREENSHOT_CLIPBOARD_SHORTCUT);
  assert.equal(normalizeDesktopSettings({}).screenshot.autoCopy, true);
});

test("desktop settings accept only the shared theme values", () => {
  assert.equal(normalizeDesktopSettings({ theme: "dark" }).theme, "dark");
  assert.equal(normalizeDesktopSettings({ theme: "light" }).theme, "light");
  assert.equal(normalizeDesktopSettings({ theme: "system" }).theme, "system");
  assert.equal(normalizeDesktopSettings({ theme: "midnight" }).theme, "system");
  assert.equal(normalizeDesktopSettings({ theme: "custom:missing-theme" }).theme, "system");
});

test("desktop settings migrate Web theme selection into Manager-owned state", () => {
  assert.equal(normalizeDesktopSettings({ theme: "dark" }).webTheme, "dark");
  assert.equal(normalizeDesktopSettings({ theme: "dark", webTheme: "trusted.solarized" }).webTheme, "trusted.solarized");
  assert.equal(normalizeDesktopSettings({ webTheme: "../../bad theme" }).webTheme, "system");
  assert.equal(normalizeDesktopSettings({ webTheme: "custom:missing-theme" }).webTheme, "system");
});

test("desktop settings normalize custom themes and keep a valid custom selection", () => {
  const theme = {
    id: "custom:night-rain-01",
    name: " 夜雨绿 ",
    baseTheme: "dark",
    colors: { accent: "#12AB34", success: "invalid" },
    styles: { cornerRadius: 99, shadow: "none", glassOpacity: 10 }
  };
  const settings = normalizeDesktopSettings({ theme: theme.id, customThemes: [theme] });
  assert.equal(settings.theme, theme.id);
  assert.equal(settings.webTheme, theme.id);
  assert.equal(settings.customThemes[0]?.name, "夜雨绿");
  assert.equal(settings.customThemes[0]?.colors.accent, "#12ab34");
  assert.equal(settings.customThemes[0]?.colors.success, "#4ade80");
  assert.deepEqual(settings.customThemes[0]?.styles, { cornerRadius: 24, shadow: "none", glassOpacity: 70 });
});

test("desktop settings store writes and reads the single host settings file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-settings-"));
  const filePath = path.join(root, "settings.json");
  try {
    const store = new DesktopSettingsStore(filePath);
    assert.equal(store.read().screenshot.enabled, false);
    store.write({ screenshot: { enabled: true, shortcut: "Ctrl+Shift+S", clipboardShortcut: "F3", autoCopy: false }, autostart: true });
    assert.deepEqual(store.read(), {
      screenshot: { enabled: true, shortcut: "Ctrl+Shift+S", clipboardShortcut: "F3", autoCopy: false },
      autostart: true,
      theme: "system",
      webTheme: "system",
      customThemes: [],
      pets: {}
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop settings keep persona-scoped pet bindings bounded and isolated", () => {
  const settings = normalizeDesktopSettings({ pets: {
    YeYu: {
      enabled: true,
      packId: "yeyu-library-default",
      scale: 9,
      opacity: 0,
      placement: { screen: "DISPLAY-2", xRatio: 0.25, yRatio: 0.75 },
      fpsCap: 24
    },
    "../Other": { enabled: true }
  } });
  assert.deepEqual(Object.keys(settings.pets), ["YeYu"]);
  assert.equal(settings.pets.YeYu?.scale, 2);
  assert.equal(settings.pets.YeYu?.opacity, 0.2);
  assert.equal(settings.pets.YeYu?.placement?.screen, "DISPLAY-2");
  assert.equal(settings.pets.YeYu?.fpsCap, 24);
});

test("autostart configuration remains tri-state for missing or corrupt settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-autostart-state-"));
  const filePath = path.join(root, "settings.json");
  try {
    const store = new DesktopSettingsStore(filePath);
    assert.equal(store.autostartConfigured(), false);
    fs.writeFileSync(filePath, "{broken", "utf8");
    assert.equal(store.autostartConfigured(), false);
    fs.writeFileSync(filePath, JSON.stringify({ theme: "dark" }), "utf8");
    assert.equal(store.autostartConfigured(), false);
    store.write({ autostart: false });
    assert.equal(store.autostartConfigured(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
