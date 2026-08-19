import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routerSource = fs.readFileSync(
  new URL("../src/router.ts", import.meta.url),
  "utf8"
);

test("WebGUI route pages switch immediately and load page chunks asynchronously", () => {
  assert.match(routerSource, /createImmediateRouteComponent/);
  assert.match(routerSource, /RouteLoadingPage/);
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
    assert.match(routerSource, new RegExp(
      `const ${page} = immediatePage\\(\\(\\) => import\\("\\.\\/pages\\/${page}\\.vue"\\)\\)`
    ));
  }
  assert.doesNotMatch(routerSource, /const\s+\w+Page\s*=\s*\(\)\s*=>\s*import\(/);
});
