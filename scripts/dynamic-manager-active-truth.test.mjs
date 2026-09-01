import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function activeContractFiles() {
  const roots = ["skills", ".github/skills", ".github/workflows", "scripts"];
  const allowedExtensions = new Set([".md", ".yaml", ".yml", ".ps1", ".psm1", ".js", ".mjs", ".cjs", ".ts"]);
  return roots.flatMap(relative => walk(path.join(ROOT, relative)))
    .filter(file => allowedExtensions.has(path.extname(file).toLowerCase()))
    .filter(file => !/\.test\.(?:mjs|cjs|js|ts)$/i.test(file))
    .filter(file => path.basename(file).toLowerCase() !== "migrate-legacywearablehealthtask.ps1");
}

test("WebGUI development proxy resolves the current dynamic Manager and fails closed", () => {
  const config = read("../ribiwebgui/vite.config.ts");
  assert.match(config, /discoverManagerBaseUrl/);
  assert.match(config, /command === "serve"/);
  assert.match(config, /port: 8793/);
  assert.doesNotMatch(config, /127\.0\.0\.1:8790/);
  assert.doesNotMatch(config, /managerPort\s*[:=]\s*8790/);
});

test("WebGUI build skill uses Host READY identity instead of a port owner", () => {
  const skill = read("../.github/skills/rabiroute-webgui-build/SKILL.md");
  for (const required of ["--command status", "managerBaseUrl", "applicationGenerationId", "managerInstanceId", "/meta"]) {
    assert.ok(skill.includes(required), `missing Host READY contract: ${required}`);
  }
  assert.match(skill, /state -eq "healthy"/);
  assert.match(skill, /Start-Sleep -Milliseconds 500/);
  assert.doesNotMatch(skill, /netstat|Get-NetTCPConnection|Stop-Process|127\.0\.0\.1:8790/i);
  assert.doesNotMatch(skill, /Start-Process\s+["']node["'][\s\S]*manager\.js/i);
});

test("RabiSpeech active documentation points to the fenced dynamic Manager URL", () => {
  for (const relative of [
    "../plugin-adapters/rabi-speech/README.md",
    "../plugin-adapters/rabi-speech/README_en.md",
    "../docs/rabispeech-plugin.md",
    "../docs/rabispeech-plugin_en.md"
  ]) {
    const source = read(relative);
    assert.match(source, /managerBaseUrl/);
    assert.match(source, /applicationGenerationId/);
    assert.match(source, /managerInstanceId/);
    assert.doesNotMatch(source, /127\.0\.0\.1:8790|current 8790|existing port 8790|当前 8790/i);
  }
});

test("all active Skills, workflows, and scripts reject retired Manager discovery", () => {
  const violations = [];
  const forbidden = [
    ["fixed Manager port", /\b8790\b/i],
    ["literal loopback Manager URL", /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/(?:api\/(?:agent|roles|speech|language-style)(?:\/|$)|#(?:\/|$)|reports(?:\/|$)|meta(?:\/|$))/i],
    ["literal Manager URL assignment", /(?:manager(?:Base)?Url|RABI(?:ROUTE|_CODEX)?_MANAGER_URL|GATEWAY_MANAGER_URL)[^\r\n]{0,120}https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i],
    ["retired instance lock", /manager-instance\.lock/i],
    ["direct Manager launch", /(?:node(?:\.exe)?\s+|Start-Process[^\r\n]*node[^\r\n]*)dist[\\/]manager\.js/i]
  ];
  for (const file of activeContractFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${path.relative(ROOT, file)}: ${label}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("repository guidance applies the dynamic Manager contract to future entry points", () => {
  const guide = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  for (const required of [
    "所有新增或修改的 Skill、工作流和脚本",
    "RabiRouteHost.exe --command status --json",
    "managerBaseUrl",
    "applicationGenerationId",
    "managerInstanceId",
    "<managerBaseUrl>/meta",
    "不得写死 Manager 端口",
    "dynamic-manager-active-truth.test.mjs"
  ]) {
    assert.ok(guide.includes(required), `missing repository dynamic Manager rule: ${required}`);
  }
});
