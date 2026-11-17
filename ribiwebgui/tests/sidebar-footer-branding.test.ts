import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("sidebar preserves official brand capitalization", () => {
  assert.match(appSource, /icon="mdi-github" aria-label="GitHub" title="GitHub"/);
  assert.match(styles, /\.sidebar-footer-btn\.v-btn\s*\{[^}]*text-transform:\s*none;/s);
});
