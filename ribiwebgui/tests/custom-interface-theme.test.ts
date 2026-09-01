import assert from "node:assert/strict";
import test from "node:test";
import { cloneBuiltinInterfaceTheme, interfaceThemeContrastFailures, INTERFACE_THEME_TEXT_SURFACE_KEYS } from "../../src/shared/interfaceThemeContract";
import { RABI_DARK_THEME } from "../src/themes/dark/vuetify";
import { RABI_LIGHT_THEME } from "../src/themes/light/vuetify";
import {
  applyCatalogInterfaceTheme,
  applyVuetifyInterfaceTheme,
  interfaceThemeSemanticTextColors
} from "../src/interfaceTheme";
import {
  replaceCustomWebThemeResources,
  resolveWebThemeCatalog,
  resolveWebThemeResource
} from "../src/pluginThemes";

test("Manager-owned custom themes become selectable declarative Web resources", () => {
  const base = cloneBuiltinInterfaceTheme("dark");
  const custom = {
    id: "custom:night-rain-green",
    name: "夜雨绿",
    ...base,
    colors: { ...base.colors, accent: "#22c55e", success: "#16a34a" }
  };
  replaceCustomWebThemeResources([custom]);
  const catalog = resolveWebThemeCatalog(null);
  const selected = resolveWebThemeResource(catalog, custom.id);
  assert.equal(selected.label, custom.name);
  assert.equal(selected.desktopTheme, custom.id);
  assert.equal(selected.customTheme?.colors.success, "#16a34a");
  assert.equal(selected.apply(false), "dark");
  replaceCustomWebThemeResources([]);
});


test("custom themes replace and select the RabiCustom Vuetify palette", () => {
  const base = cloneBuiltinInterfaceTheme("dark");
  const custom = {
    id: "custom:night-rain-vuetify",
    name: "夜雨 Vuetify",
    ...base,
    colors: { ...base.colors, accent: "#22c55e", accentStrong: "#16a34a" }
  };
  const theme = {
    themes: { value: { RabiCustom: { dark: false, colors: {}, variables: {} } } },
    global: { name: { value: "RabiLight" } }
  };

  applyVuetifyInterfaceTheme(theme, "dark", custom);

  assert.equal(theme.global.name.value, "RabiCustom");
  assert.equal(theme.themes.value.RabiCustom.dark, true);
  assert.equal(theme.themes.value.RabiCustom.colors.secondary, "#22c55e");
  assert.equal(theme.themes.value.RabiCustom.colors.accent, "#16a34a");
  assert.equal(theme.themes.value.RabiCustom.colors["on-secondary"], "#000000");
  assert.equal(
    theme.themes.value.RabiCustom.colors["on-accent"],
    interfaceThemeSemanticTextColors(custom).onAccentStrong
  );
});

test("built-in themes keep the fixed Vuetify palette names", () => {
  const theme = {
    themes: { value: { RabiCustom: { dark: false, colors: {}, variables: {} } } },
    global: { name: { value: "RabiCustom" } }
  };

  applyVuetifyInterfaceTheme(theme, "light");
  assert.equal(theme.global.name.value, "RabiLight");
  applyVuetifyInterfaceTheme(theme, "dark");
  assert.equal(theme.global.name.value, "RabiDark");
});


function mixHex(foreground: string, background: string, foregroundRatio: number): string {
  const channel = (hex: string, index: number) => Number.parseInt(hex.slice(index, index + 2), 16);
  return `#${[1, 3, 5].map(index => Math.round(
    channel(foreground, index) * foregroundRatio + channel(background, index) * (1 - foregroundRatio)
  ).toString(16).padStart(2, "0")).join("")}`;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test("semantic status text colors remain readable on their generated surfaces", () => {
  for (const baseTheme of ["light", "dark"] as const) {
    const theme = { id: `custom:${baseTheme}-semantic-text`, name: baseTheme, ...cloneBuiltinInterfaceTheme(baseTheme) };
    const text = interfaceThemeSemanticTextColors(theme);
    const pairs = [
      [text.accentText, mixHex(theme.colors.accent, theme.colors.surface, .12)],
      [text.successText, mixHex(theme.colors.success, theme.colors.surface, .14)],
      [text.warningText, mixHex(theme.colors.warning, theme.colors.surface, .14)],
      [text.errorText, mixHex(theme.colors.error, theme.colors.surface, .14)],
      [text.infoText, mixHex(theme.colors.info, theme.colors.surface, .14)]
    ] as const;
    for (const [foreground, surface] of pairs) {
      assert.ok(contrastRatio(foreground, surface) >= 4.5, `${baseTheme} ${foreground} on ${surface}`);
    }
  }
});


test("themes with mutually conflicting surfaces are reported instead of accepted", () => {
  for (const [baseTheme, surface] of [["light", "#000000"], ["dark", "#ffffff"]] as const) {
    const base = cloneBuiltinInterfaceTheme(baseTheme);
    const theme = { ...base, colors: { ...base.colors, surface } };
    assert.ok(interfaceThemeContrastFailures(theme).length > 0, baseTheme);
  }
});

test("semantic status text colors remain readable on Vuetify currentColor tonal backgrounds", () => {
  for (const baseTheme of ["light", "dark"] as const) {
    const theme = { id: `custom:${baseTheme}-vuetify-tonal`, name: baseTheme, ...cloneBuiltinInterfaceTheme(baseTheme) };
    const text = interfaceThemeSemanticTextColors(theme);
    const foregrounds = [
      ["accent", text.accentText],
      ["success", text.successText],
      ["warning", text.warningText],
      ["error", text.errorText],
      ["info", text.infoText]
    ] as const;
    for (const [name, foreground] of foregrounds) {
      for (const surfaceKey of INTERFACE_THEME_TEXT_SURFACE_KEYS) {
        const tonalSurface = mixHex(foreground, theme.colors[surfaceKey], .12);
        assert.ok(
          contrastRatio(foreground, tonalSurface) >= 4.5,
          `${baseTheme} ${name} ${foreground} on ${surfaceKey} tonal ${tonalSurface}`
        );
      }
    }
  }
});

test("warning text remains readable on the known light subtle Vuetify tonal surface", () => {
  const base = cloneBuiltinInterfaceTheme("light");
  const theme = { ...base, colors: { ...base.colors, surface: "#f5f8fa" } };
  const { warningText } = interfaceThemeSemanticTextColors(theme);
  const tonalSurface = mixHex(warningText, theme.colors.surface, .12);

  assert.ok(
    contrastRatio(warningText, tonalSurface) >= 4.5,
    `light warning ${warningText} on Vuetify tonal ${tonalSurface}`
  );
});

test("custom semantic text variables are applied and cleared with the custom theme", () => {
  const base = cloneBuiltinInterfaceTheme("light");
  const custom = { id: "custom:semantic-variable-cleanup", name: "语义变量", ...base };
  replaceCustomWebThemeResources([custom]);
  const values = new Map<string, string>();
  const removed: string[] = [];
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        dataset: {},
        style: {
          colorScheme: "",
          setProperty(name: string, value: string) { values.set(name, value); },
          removeProperty(name: string) { removed.push(name); values.delete(name); }
        }
      }
    }
  });
  try {
    const catalog = resolveWebThemeCatalog(null);
    applyCatalogInterfaceTheme(catalog, custom.id, false);
    for (const property of ["--rr-on-accent-strong", "--rr-accent-text", "--rr-success-text", "--rr-warning-text", "--rr-error-text", "--rr-info-text"]) {
      assert.match(values.get(property) ?? "", /^#[0-9a-f]{6}$/);
    }
    assert.match(values.get("--rr-grid-line") ?? "", /, 0\.08\)$/);
    assert.match(values.get("--rr-grid-line-soft") ?? "", /, 0\.06\)$/);
    applyCatalogInterfaceTheme(catalog, "system", false);
    for (const property of ["--rr-on-accent-strong", "--rr-accent-text", "--rr-success-text", "--rr-warning-text", "--rr-error-text", "--rr-info-text", "--rr-grid-line", "--rr-grid-line-soft"]) {
      assert.ok(removed.includes(property));
    }
  } finally {
    replaceCustomWebThemeResources([]);
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  }
});


test("built-in Vuetify palettes match the themes cloned by the custom editor", () => {
  for (const [baseTheme, vuetify] of [["light", RABI_LIGHT_THEME], ["dark", RABI_DARK_THEME]] as const) {
    const colors = cloneBuiltinInterfaceTheme(baseTheme).colors;
    assert.equal(vuetify.colors.background, colors.canvas);
    assert.equal(vuetify.colors.surface, colors.surface);
    assert.equal(vuetify.colors.primary, colors.heading);
    assert.equal(vuetify.colors.secondary, colors.accent);
    assert.equal(vuetify.colors.accent, colors.accentStrong);
    assert.equal(vuetify.colors.success, colors.success);
    assert.equal(vuetify.colors.warning, colors.warning);
    assert.equal(vuetify.colors.error, colors.error);
    assert.equal(vuetify.colors.info, colors.info);
    assert.equal(vuetify.colors["on-accent"], interfaceThemeSemanticTextColors({ baseTheme, colors }).onAccentStrong);
  }
});
