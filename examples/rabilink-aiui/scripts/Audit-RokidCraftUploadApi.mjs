import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const craftUrl = "https://js.rokid.com/craft?region=cn&lang=zh-CN";
const expectedUploadPath = "/api/craft/project/upload-agent";

function fail(message) {
  throw new Error(message);
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

function scriptUrlFromHtml(html) {
  const match = html.match(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"/i);
  if (!match) {
    fail("Craft HTML does not expose a Vite module script.");
  }
  return new URL(match[1], craftUrl).toString();
}

function includesAll(source, snippets) {
  const missing = snippets.filter((snippet) => !source.includes(snippet));
  if (missing.length) {
    fail(`Craft upload API contract changed; missing snippets: ${missing.join(", ")}`);
  }
}

function extractSnippet(source, needle, radius = 1200) {
  const index = source.indexOf(needle);
  if (index < 0) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + needle.length + radius);
  return source.slice(start, end);
}

const html = await fetchText(craftUrl);
const scriptUrl = scriptUrlFromHtml(html);
const bundle = await fetchText(scriptUrl);

includesAll(bundle, [
  expectedUploadPath,
  "submitProjectUploadDraft",
  "new FormData",
  "new File([M]",
  'j.append("file",he)',
  'j.append("metadata",JSON.stringify(Ce))',
  '"X-Account-Token"',
  '"X-Account-ID"',
  '"X-Craft-Region"'
]);

const snippet = extractSnippet(bundle, "submitProjectUploadDraft");
const outDir = path.join(os.tmpdir(), "rokid-craft-inspect");
fs.mkdirSync(outDir, { recursive: true });
const snippetPath = path.join(outDir, "upload-agent-snippet.txt");
fs.writeFileSync(snippetPath, snippet, "utf8");

console.log("Rokid Craft upload API audit passed.");
console.log(`Craft bundle: ${scriptUrl}`);
console.log(`Upload path: ${expectedUploadPath}`);
console.log("Upload form fields: file, metadata");
console.log("Auth headers: X-Account-Token, X-Account-ID, X-Craft-Region");
console.log(`Snippet: ${snippetPath}`);
