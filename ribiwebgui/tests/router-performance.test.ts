import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routerSource = fs.readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
const pluginPagesSource = fs.readFileSync(new URL("../src/pluginPages.ts", import.meta.url), "utf8");
const builtinWebContributionsSource = ["core", "message-adapter-control", "persona", "speech", "performance", "diagnostics"].map(owner => fs.readFileSync(new URL(`../../src/plugins/io.rabiroute.manager.${owner}/web/contributions.ts`, import.meta.url), "utf8")).join("\n");

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
    "ProjectDocsPage",
    "RoleKnowledgePage",
    "RuntimeLogPage",
    "PerformancePage",
    "SpeechServicePage",
    "SettingsPage"
  ]) {
    assert.equal(builtinWebContributionsSource.includes(`import("./pages/${page}.vue")`), true);
  }
  assert.doesNotMatch(pluginPagesSource, /import\("\.\/pages\//);
  assert.match(pluginPagesSource, /registerTrustedWebPage/);
  assert.match(pluginPagesSource, /allowedSlots/);
  assert.match(pluginPagesSource, /allowedIcons/);
  // The shell's management page must remain available when business Bundles are
  // disabled. Keep its own lazy chunk while all business pages stay registered.
  assert.deepEqual([...routerSource.matchAll(/import\("\.\/pages\/([^\"]+)"\)/g)].map(match => match[1]), ["PluginsPage.vue"]);
  assert.match(routerSource, /path: "\/plugins",[\s\S]*?component: immediatePage\(\(\) => import\("\.\/pages\/PluginsPage\.vue"\)\)/);
});
