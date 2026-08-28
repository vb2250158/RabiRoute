import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/PerformancePage.vue", import.meta.url), "utf8");

test("performance monitoring uses the shared page spacing", () => {
  assert.match(source, /<div class="page-shell performance-page">/);
  assert.doesNotMatch(source, /\.performance-page\s*\{[^}]*\bpadding\s*:/s);
});
