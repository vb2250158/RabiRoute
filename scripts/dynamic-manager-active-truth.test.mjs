import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

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
