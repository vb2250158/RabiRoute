import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routerSource = fs.readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
const pluginPagesSource = fs.readFileSync(new URL("../src/pluginPages.ts", import.meta.url), "utf8");

test("WebGUI route pages use the fixed renderer registry and asynchronous page chunks", () => {
  assert.match(routerSource, /createImmediateRouteComponent/);
  assert.match(routerSource, /RouteLoadingPage/);
  assert.match(routerSource, /registeredPage\("route\.overview"\)/);
  assert.match(routerSource, /pluginRouteId/);
  assert.match(routerSource, /PLUGIN_RECOVERY_ROUTE_NAME/);
  assert.match(routerSource, /isWebPageRouteActive/);

  for (const page of [
    "OverviewPage",
    "RouteConfigPage",
    "PersonaTemplatePage",
    "PersonaDocumentPage",
    "PersonaSyncPage",
    "ProjectDocsPage",
    "RoleKnowledgePage",
    "RuntimeLogPage",
    "PerformancePage",
    "SpeechServicePage",
    "SettingsPage"
  ]) {
    assert.match(pluginPagesSource, new RegExp(`import\\("\\.\\/pages\\/${page}\\.vue"\\)`));
  }
  assert.match(pluginPagesSource, /webPageRendererRegistry/);
  assert.doesNotMatch(routerSource, /import\("\.\/pages\//);
});
