import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlanMarkdownAttachment,
  planMarkdownPreviewExcerpt,
  responseTextByByteLimit,
  renderPlanMarkdownPreview,
  safeMarkdownHref
} from "../src/markdownPreview";

test("recognizes Markdown plan attachments by extension or MIME", () => {
  assert.equal(isPlanMarkdownAttachment("notes.md"), true);
  assert.equal(isPlanMarkdownAttachment("README.MARKDOWN"), true);
  assert.equal(isPlanMarkdownAttachment("notes.txt", "text/markdown"), true);
  assert.equal(isPlanMarkdownAttachment("report.pdf", "application/pdf"), false);
});

test("renders useful GFM while neutralizing active attachment content", () => {
  const html = renderPlanMarkdownPreview(`# Title

| Item | State |
| --- | --- |
| Preview | Ready |

[safe](https://example.com) [unsafe](javascript:alert(1))

![remote](https://tracker.invalid/pixel.png)

<script>alert(1)</script>`);

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /class="markdown-preview-disabled-link">unsafe<\/span>/);
  assert.match(html, /class="markdown-preview-image-placeholder">IMAGE · remote<\/span>/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /tracker\.invalid/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("allows only explicit safe link protocols or local document anchors", () => {
  assert.equal(safeMarkdownHref("#section"), "#section");
  assert.equal(safeMarkdownHref("mailto:test@example.com"), "mailto:test@example.com");
  assert.equal(safeMarkdownHref("../private.txt"), "");
  assert.equal(safeMarkdownHref("data:text/html,test"), "");
});

test("builds a short plain-text teaser for the fixed-ratio Markdown card", () => {
  const teaser = planMarkdownPreviewExcerpt(`---
title: Hidden metadata
---
# Release notes

- Added **image preview**
- Open the [full document](https://example.com)

![remote image](https://tracker.invalid/pixel.png)

\`\`\`ts
const safe = true;
\`\`\``);

  assert.equal(
    teaser,
    "Release notes Added image preview Open the full document remote image const safe = true;"
  );
  assert.equal(planMarkdownPreviewExcerpt("123456789", 6), "12345…");
});

test("rejects a streamed Markdown response with bytes beyond an exact limit boundary", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("1234"));
      controller.enqueue(new TextEncoder().encode("5"));
      controller.close();
    }
  }));

  await assert.rejects(
    responseTextByByteLimit(response, 4, false, "too large"),
    /too large/
  );
});

test("truncates a streamed teaser at the byte limit", async () => {
  const response = new Response(new TextEncoder().encode("12345"));
  assert.equal(await responseTextByByteLimit(response, 4, true), "1234");
});
