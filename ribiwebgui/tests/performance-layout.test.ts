import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { activatePerformance } from "../../src/plugins/io.rabiroute.manager.performance/web/contributions";
import { activateWebPluginForTest } from "./web-plugin-test-host";
import { resolveRegisteredWebPagePath, webPageRenderer } from "../src/pluginPages";
import { resolveWebStatusCatalog, webRenderersAt } from "../src/pluginRenderers";

const source = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.performance/web/pages/PerformancePage.vue", import.meta.url), "utf8");

test("performance monitoring uses the shared page spacing", () => {
  assert.match(source, /<div class="page-shell performance-page">/);
  assert.doesNotMatch(source, /\.performance-page\s*\{[^}]*\bpadding\s*:/s);
  assert.match(source, /\.performance-config-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
});

test("performance contributes the diagnostics tab and retains the existing direct route", () => {
  const owner = { instanceId: "manager:performance", pluginId: "io.rabiroute.manager.performance" };
  const dispose = activateWebPluginForTest(owner, activatePerformance);
  try {
    const renderers = resolveWebStatusCatalog([{ ...owner, kind: "status-card", surface: "shared.status",
      id: "performance-diagnostics", rendererId: "builtin.performance-diagnostics.v1", queryId: "manager.performance-status",
      slot: "diagnostics.performance", hosts: ["web"] }]);
    assert.equal(webRenderersAt(renderers, "diagnostics.performance").length, 1);
    assert.equal(resolveRegisteredWebPagePath("global.performance", ""), "");
    assert.ok(webPageRenderer("global.performance").paths.some(entry => entry.path === "/performance"));
    const manager = fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.performance/manager.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(manager, /"kind": "navigation"/);
    assert.match(manager, /"slot": "diagnostics.performance"/);
  } finally { dispose(); }
});
