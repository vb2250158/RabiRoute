import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("model management renders the catalog as a table instead of cards", () => {
  const source = fs.readFileSync(new URL("../src/pages/ModelManagementPage.vue", import.meta.url), "utf8");

  assert.match(source, /<table class="model-table">/);
  assert.match(source, /<th class="model-column">\{\{ copy\.model \}\}<\/th>/);
  assert.match(source, /<template v-for="model in filteredModels" :key="model\.alias">/);
  assert.match(source, /<td colspan="8">/);
  assert.doesNotMatch(source, /class="model-grid"|class="model-card app-card"/);
});
