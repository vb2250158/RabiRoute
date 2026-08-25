import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  BUILTIN_INTERFACE_THEME_TEMPLATES,
  interfaceThemeContrastRatio,
  readableInterfaceThemeForeground
} from "./interfaceThemeContract.js";

test("built-in theme text pairs keep accessible contrast", () => {
  for (const [name, template] of Object.entries(BUILTIN_INTERFACE_THEME_TEMPLATES)) {
    assert.ok(interfaceThemeContrastRatio(template.colors.text, template.colors.surface) >= 4.5, `${name} body text`);
    assert.ok(interfaceThemeContrastRatio(template.colors.heading, template.colors.surface) >= 4.5, `${name} heading`);
    assert.ok(interfaceThemeContrastRatio(template.colors.muted, template.colors.surface) >= 3, `${name} secondary text`);
  }
});

test("semantic backgrounds receive the more readable black or white foreground", () => {
  assert.equal(readableInterfaceThemeForeground("#ffffff"), "#000000");
  assert.equal(readableInterfaceThemeForeground("#10161d"), "#ffffff");
});

test("theme settings UI and switches do not own ad-hoc presentation colors", () => {
  const renderer = fs.readFileSync(new URL("../../ribiwebgui/src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);

  const stylesheet = fs.readFileSync(new URL("../../ribiwebgui/src/styles.css", import.meta.url), "utf8");
  const switchRules = stylesheet.slice(stylesheet.indexOf(".v-switch .v-selection-control"), stylesheet.indexOf("@media (forced-colors: active)"));
  assert.match(switchRules, /var\(--rr-switch-track-active\)/);
  assert.match(switchRules, /var\(--rr-switch-thumb-active\)/);
  assert.match(switchRules, /background:\s*var\(--rr-switch-track-active\)\s*!important/);
  assert.doesNotMatch(switchRules, /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
});
