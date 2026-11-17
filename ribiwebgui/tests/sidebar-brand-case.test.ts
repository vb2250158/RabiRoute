import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("sidebar brand casing overrides Vuetify button capitalization regardless of bundle order", () => {
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  assert.match(app, /icon="mdi-github" aria-label="GitHub" title="GitHub"/);
  // Two class selectors outrank Vuetify's later single-class .v-btn rule.
  assert.match(css, /\.sidebar-footer-btn\.v-btn\s*\{[^}]*text-transform:\s*none\s*;/);
});
