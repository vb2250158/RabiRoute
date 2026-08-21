import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routerSource = fs.readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
const pluginPagesSource = fs.readFileSync(new URL("../src/pluginPages.ts", import.meta.url), "utf8");

test("WebGUI route pages use the trusted renderer registry and asynchronous page chunks", () => {
  assert.match(routerSource, /createImmediateRouteComponent/);
  assert.match(routerSource, /RouteLoadingPage/);
  assert.match(routerSource, /registeredWebPages\(\)/);
  assert.match(routerSource, /onTrustedWebPageRegistrationChange/);
  assert.match(routerSource, /router\.addRoute/);
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
  assert.match(pluginPagesSource, /registerTrustedWebPage/);
  assert.match(pluginPagesSource, /allowedSlots/);
  assert.match(pluginPagesSource, /allowedIcons/);
  assert.doesNotMatch(routerSource, /import\("\.\/pages\//);
});
