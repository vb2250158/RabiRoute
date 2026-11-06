import assert from "node:assert/strict";
import test from "node:test";
import { applyVuetifyInterfaceTheme, resolveInterfaceTheme } from "../src/interfaceTheme";
import { createVuetify } from "vuetify";
import { cloneBuiltinInterfaceTheme } from "../../src/shared/interfaceThemeContract";
import { RABI_LIGHT_THEME } from "../src/themes/light/vuetify";
import { RABI_DARK_THEME } from "../src/themes/dark/vuetify";

test("interface theme resolves explicit and system choices", () => {
  assert.equal(resolveInterfaceTheme("light", true), "light");
  assert.equal(resolveInterfaceTheme("dark", false), "dark");
  assert.equal(resolveInterfaceTheme("system", false), "light");
  assert.equal(resolveInterfaceTheme("system", true), "dark");
});

test("installed Vuetify switches built-in and newly registered custom themes without deprecated setter warnings", () => {
  const warnings: unknown[][] = [], warn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values); };
  try {
    const vuetify = createVuetify({ theme: { defaultTheme: "RabiLight", themes: { RabiLight: RABI_LIGHT_THEME, RabiDark: RABI_DARK_THEME } } });
    assert.equal(applyVuetifyInterfaceTheme(vuetify.theme, "dark"), "RabiDark");
    assert.equal(vuetify.theme.name.value, "RabiDark");
    assert.equal(applyVuetifyInterfaceTheme(vuetify.theme, "light"), "RabiLight");
    assert.equal(vuetify.theme.name.value, "RabiLight");
    const custom = { id: "custom:actual-vuetify-api", name: "Actual Vuetify API", ...cloneBuiltinInterfaceTheme("dark") };
    assert.equal(applyVuetifyInterfaceTheme(vuetify.theme, "dark", custom), "RabiCustom");
    assert.equal(vuetify.theme.name.value, "RabiCustom");
    assert.equal(vuetify.theme.current.value.colors.background, custom.colors.canvas);
    assert.equal(vuetify.theme.current.value.colors.secondary, custom.colors.accent);
    assert.deepEqual(warnings, []);
  } finally { console.warn = warn; }
});
