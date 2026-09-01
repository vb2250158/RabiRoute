import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  BUILTIN_INTERFACE_THEME_TEMPLATES,
  cloneBuiltinInterfaceTheme,
  interfaceThemeContrastFailures,
  interfaceThemeContrastRatio,
  interfaceThemeSemanticTextColors,
  normalizeCustomInterfaceTheme,
  readableInterfaceThemeForeground
} from "./interfaceThemeContract.js";

test("built-in theme text and semantic colors remain readable on every supported surface", () => {
  for (const baseTheme of ["light", "dark"] as const) {
    assert.deepEqual(
      interfaceThemeContrastFailures({ baseTheme, colors: BUILTIN_INTERFACE_THEME_TEMPLATES[baseTheme].colors }),
      [],
      baseTheme
    );
  }
});

test("custom theme surfaces must match the selected light or dark base", () => {
  const dark = cloneBuiltinInterfaceTheme("dark");
  const lightBaseWithDarkSurfaces = {
    id: "custom:wrong-light-base",
    name: "Wrong light base",
    ...dark,
    baseTheme: "light" as const
  };
  assert.ok(interfaceThemeContrastFailures(lightBaseWithDarkSurfaces).some(failure => failure.kind === "base"));
  assert.equal(normalizeCustomInterfaceTheme(lightBaseWithDarkSurfaces), undefined);

  const light = cloneBuiltinInterfaceTheme("light");
  const darkBaseWithLightSurfaces = {
    id: "custom:wrong-dark-base",
    name: "Wrong dark base",
    ...light,
    baseTheme: "dark" as const
  };
  assert.ok(interfaceThemeContrastFailures(darkBaseWithLightSurfaces).some(failure => failure.kind === "base"));
  assert.equal(normalizeCustomInterfaceTheme(darkBaseWithLightSurfaces), undefined);
});
test("custom themes with unreadable subtle or tonal surfaces are rejected", () => {
  const light = cloneBuiltinInterfaceTheme("light");
  assert.equal(normalizeCustomInterfaceTheme({
    id: "custom:unreadable-subtle",
    name: "Unreadable subtle",
    ...light,
    colors: { ...light.colors, subtle: light.colors.text }
  }), undefined);

  const dark = cloneBuiltinInterfaceTheme("dark");
  assert.equal(normalizeCustomInterfaceTheme({
    id: "custom:unreadable-tonal",
    name: "Unreadable tonal",
    ...dark,
    colors: { ...dark.colors, surface: "#179656", accent: "#4bce9e" }
  }), undefined);
});

test("custom themes reject accentStrong that disappears into text surfaces", () => {
  const light = cloneBuiltinInterfaceTheme("light");
  const invalid = {
    id: "custom:accent-strong-surface",
    name: "Accent collision",
    ...light,
    colors: { ...light.colors, accentStrong: light.colors.surface }
  };
  const collision = interfaceThemeContrastFailures(invalid).find(
    failure => failure.foreground === "accentStrong" && failure.background === "surface"
  );

  assert.equal(collision?.ratio, 1);
  assert.equal(normalizeCustomInterfaceTheme(invalid), undefined);
});

test("accentStrong fills receive a shared readable foreground", () => {
  for (const baseTheme of ["light", "dark"] as const) {
    const theme = cloneBuiltinInterfaceTheme(baseTheme);
    const { onAccentStrong } = interfaceThemeSemanticTextColors(theme);

    assert.equal(onAccentStrong, readableInterfaceThemeForeground(theme.colors.accentStrong));
    assert.ok(interfaceThemeContrastRatio(onAccentStrong, theme.colors.accentStrong) >= 4.5, baseTheme);
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
  assert.match(switchRules, /var\(--rr-switch-thumb-active\)/);
  assert.match(switchRules, /color:\s*var\(--rr-switch-track-active\)\s*!important/);
  assert.match(switchRules, /background:\s*var\(--rr-switch-track-active\)\s*!important/);
  assert.doesNotMatch(switchRules, /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/i);
});
