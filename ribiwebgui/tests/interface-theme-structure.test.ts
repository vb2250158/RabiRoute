import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("each WebGUI theme keeps its CSS tokens and Vuetify colors in its own folder", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const vuetify = fs.readFileSync(path.join(root, "src", "plugins", "vuetify.ts"), "utf8");
  const switchTokens = [
    "rr-switch-track",
    "rr-switch-track-active",
    "rr-switch-thumb",
    "rr-switch-thumb-active",
    "rr-switch-track-shadow",
    "rr-switch-thumb-shadow"
  ];

  for (const theme of ["light", "dark"]) {
    const tokenPath = path.join(root, "src", "themes", theme, "tokens.css");
    assert.ok(fs.existsSync(tokenPath));
    assert.ok(fs.existsSync(path.join(root, "src", "themes", theme, "vuetify.ts")));
    assert.match(styles, new RegExp(`themes/${theme}/tokens\.css`));
    const tokens = fs.readFileSync(tokenPath, "utf8");
    for (const token of switchTokens) {
      assert.match(tokens, new RegExp(`--${token}\\s*:`), `${theme} theme must own ${token}`);
    }
  }
  assert.match(vuetify, /themes\/light\/vuetify/);
  assert.match(vuetify, /themes\/dark\/vuetify/);
  assert.match(
    styles,
    /\.v-switch \.v-selection-control--dirty \.v-switch__track\s*\{[^}]*var\(--rr-switch-track-active\)/s
  );
  assert.match(
    styles,
    /\.v-switch \.v-selection-control--dirty \.v-switch__thumb\s*\{[^}]*var\(--rr-switch-thumb-active\)/s
  );
});

test("desktop settings expose cloning and a bounded custom theme editor", () => {
  const source = fs.readFileSync(path.join(root, "src", "components", "renderers", "DesktopSettingsRenderer.vue"), "utf8");
  assert.match(source, /添加自定义主题/);
  assert.match(source, /保存并应用/);
  assert.match(source, /INTERFACE_THEME_COLOR_KEYS/);
  assert.match(source, /cornerRadius/);
  assert.match(source, /glassOpacity/);
});
