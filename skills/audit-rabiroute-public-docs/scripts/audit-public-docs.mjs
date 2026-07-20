#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
const warnings = [];

function relative(filePath) {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function report(bucket, filePath, text, match, message) {
  bucket.push({ file: relative(filePath), line: lineNumber(text, match.index), message, value: match[0] });
}

function walk(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath, predicate));
    else if (predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

const publicFiles = [
  path.join(root, "README.md"),
  path.join(root, "README_zh.md"),
  ...walk(path.join(root, "docs"), (file) => file.endsWith(".md")),
  ...walk(path.join(root, "ribiwebgui", "src"), (file) => /\.(?:vue|ts)$/.test(file))
].filter((file) => fs.existsSync(file));

for (const filePath of publicFiles) {
  const text = fs.readFileSync(filePath, "utf8");
  const markdownLoopback = /\]\(https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?)(?::\d+)?[^)]*\)/gi;
  for (const match of text.matchAll(markdownLoopback)) {
    report(errors, filePath, text, match, "Public Markdown must show loopback URLs as code instead of clickable links.");
  }
  const absolutePrivateLink = /\]\((?:file:\/{2,3}|[A-Za-z]:[\\/])[^)]*\)/g;
  for (const match of text.matchAll(absolutePrivateLink)) {
    report(errors, filePath, text, match, "Public Markdown contains a local absolute-path link.");
  }
  if (/\.(?:vue|ts)$/.test(filePath)) {
    const rootStatic = /(?:href|src|:href|:src)\s*=\s*["']\/(?:reports|downloads)\//g;
    for (const match of text.matchAll(rootStatic)) {
      report(errors, filePath, text, match, "Runtime static links must be relative so the remote WebGUI base prefix is preserved.");
    }
  }
}

const guideDir = path.join(root, "docs", "user-guide");
if (fs.existsSync(guideDir)) {
  const names = new Set(fs.readdirSync(guideDir).filter((name) => name.endsWith(".md")));
  for (const name of names) {
    const peer = name.endsWith("_en.md") ? name.replace(/_en\.md$/, ".md") : name.replace(/\.md$/, "_en.md");
    if (!names.has(peer)) errors.push({ file: `docs/user-guide/${name}`, line: 1, message: `Missing bilingual peer: ${peer}`, value: name });
  }
}

const requiredChecks = [
  ["docs/user-guide/speech-api.md", ["/api/rabilink/speech/v1/audio/speech", "/api/rabilink/speech/v1/audio/transcriptions"]],
  ["docs/user-guide/speech-api_en.md", ["/api/rabilink/speech/v1/audio/speech", "/api/rabilink/speech/v1/audio/transcriptions"]],
  ["ribiwebgui/src/pages/ProjectDocsPage.vue", ['"speech-api"']],
  ["scripts/rabilink-relay-server.mjs", ['match.restPath.startsWith("/reports/")']]
];

for (const [fileName, needles] of requiredChecks) {
  const filePath = path.join(root, fileName);
  if (!fs.existsSync(filePath)) {
    errors.push({ file: fileName, line: 1, message: "Required public-document integration file is missing.", value: fileName });
    continue;
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) errors.push({ file: fileName, line: 1, message: `Required documentation contract is missing: ${needle}`, value: needle });
  }
}

const reportSource = path.join(root, "ribiwebgui", "public", "reports", "rabispeech-model-benchmark.html");
if (!fs.existsSync(reportSource)) {
  errors.push({ file: relative(reportSource), line: 1, message: "The public benchmark report source is missing.", value: "rabispeech-model-benchmark.html" });
}

const result = { ok: errors.length === 0, errors, warnings };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const item of errors) console.error(`ERROR ${item.file}:${item.line} ${item.message} (${item.value})`);
  for (const item of warnings) console.warn(`WARN  ${item.file}:${item.line} ${item.message} (${item.value})`);
  console.log(`Public docs audit: ${errors.length} error(s), ${warnings.length} warning(s).`);
}
process.exitCode = errors.length ? 1 : 0;
