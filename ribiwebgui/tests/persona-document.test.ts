import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { markdownPreviewExcerpt } from "../src/markdownPreview";

const personaPageSource = fs.readFileSync(
  new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url),
  "utf8"
);

const documentPageSource = fs.readFileSync(
  new URL("../src/pages/PersonaDocumentPage.vue", import.meta.url),
  "utf8"
);

test("persona configuration keeps the full markdown body out of the first paint", () => {
  assert.doesNotMatch(personaPageSource, /<pre[^>]+class="mono-box"[^>]*>\{\{[^}]*roleContent/);
  assert.match(personaPageSource, /markdownPreviewExcerpt\(\s*personaMarkdownSource\.value,\s*PERSONA_SUMMARY_MAX_CHARACTERS\s*\)/);
  assert.match(personaPageSource, /class="persona-summary-preview"/);
  assert.match(personaPageSource, /routeScopedPersonaDocumentPath/);
  assert.match(personaPageSource, /loadPersonaDocument/);
  assert.match(personaPageSource, /查看完整正文/);
});

test("the dedicated persona page renders the complete body with the safe markdown viewer", () => {
  assert.match(documentPageSource, /renderMarkdownPreview/);
  assert.match(documentPageSource, /loadPersonaDocument/);
  assert.match(documentPageSource, /v-html="renderedMarkdown"/);
  assert.match(documentPageSource, /knowledge-plan-markdown-document/);
  assert.match(documentPageSource, /routeScopedPersonaPath/);
});

test("markdown summaries are plain, bounded text", () => {
  const source = "# 人格标题\n\n" + "正文".repeat(300);
  const excerpt = markdownPreviewExcerpt(source, 120);
  assert.equal(excerpt.length, 120);
  assert.match(excerpt, /^人格标题 正文/);
  assert.match(excerpt, /…$/);
  assert.doesNotMatch(excerpt, /#/);
});
