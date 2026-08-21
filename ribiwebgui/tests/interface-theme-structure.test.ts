import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("each WebGUI theme keeps its CSS tokens and Vuetify colors in its own folder", () => {
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const vuetify = fs.readFileSync(path.join(root, "src", "plugins", "vuetify.ts"), "utf8");

  for (const theme of ["light", "dark"]) {
    assert.ok(fs.existsSync(path.join(root, "src", "themes", theme, "tokens.css")));
    assert.ok(fs.existsSync(path.join(root, "src", "themes", theme, "vuetify.ts")));
    assert.match(styles, new RegExp(`themes/${theme}/tokens\.css`));
  }
  assert.match(vuetify, /themes\/light\/vuetify/);
  assert.match(vuetify, /themes\/dark\/vuetify/);
});
