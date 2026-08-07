import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routerSource = fs.readFileSync(
  new URL("../src/router.ts", import.meta.url),
  "utf8"
);

test("WebGUI route pages are split into lazy chunks", () => {
  assert.doesNotMatch(routerSource, /import\s+\w+Page\s+from\s+"\.\/pages\//);
  for (const page of [
    "OverviewPage",
    "RouteConfigPage",
    "PersonaTemplatePage",
    "PersonaDocumentPage",
    "ProjectDocsPage",
    "RoleKnowledgePage",
    "RuntimeLogPage",
    "SpeechServicePage"
  ]) {
    assert.match(routerSource, new RegExp(
      `const ${page} = \\(\\) => import\\("\\.\\/pages\\/${page}\\.vue"\\)`
    ));
  }
});
