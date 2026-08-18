import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanguageStyleValidator } from "./languageStyleValidation.js";

function writeStyleSkill(rootDir: string): string {
  const skillDir = path.join(rootDir, "pragmatic-style");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Test style\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "references", "style-data.json"), JSON.stringify({
    runtimeConstraints: {
      targetLanguage: "zh-CN",
      checks: [{
        id: "TEST-001",
        level: "error",
        scope: ["final"],
        kind: "forbidden_phrases",
        values: ["先说结论"],
        message: "删除套话。"
      }, {
        id: "TEST-002",
        level: "warning",
        scope: ["final"],
        kind: "redundant_first_person_execution",
        patterns: ["我会"],
        message: "删除冗余第一人称。"
      }, {
        id: "TEST-003",
        level: "error",
        scope: ["final"],
        kind: "simple_answer_has_extra_sentences",
        allowWhenPromptAsksReason: true,
        message: "短答只保留答案。"
      }]
    }
  }), "utf8");
  return skillDir;
}

test("language style validator reads a Skill URL and returns rule evidence", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-language-style-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const skillDir = writeStyleSkill(rootDir);
  const result = await new LanguageStyleValidator().validate({
    text: "先说结论，我会处理。",
    styleSkillUrl: path.join(skillDir, "SKILL.md"),
    scope: "outbound_message"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations.map(item => item.ruleId), ["TEST-001", "TEST-002"]);
  assert.match(result.styleDataUrl || "", /style-data\.json$/);
});

test("context-dependent checks are skipped when no source prompt is supplied", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-language-style-context-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const skillDir = writeStyleSkill(rootDir);
  const validator = new LanguageStyleValidator();

  const outbound = await validator.validate({
    text: "没有。还有一句。",
    styleSkillUrl: skillDir,
    scope: "outbound_message"
  });
  assert.equal(outbound.passed, true);
  assert.ok(outbound.skippedRuleIds.includes("TEST-003"));

  const final = await validator.validate({
    text: "没有。还有一句。",
    styleSkillUrl: skillDir,
    scope: "final",
    prompt: "更新了吗？"
  });
  assert.equal(final.passed, false);
  assert.ok(final.violations.some(item => item.ruleId === "TEST-003"));
});

test("unavailable style data returns a structured failure", async () => {
  const result = await new LanguageStyleValidator().validate({
    text: "测试",
    styleSkillUrl: path.join(os.tmpdir(), "missing-style-skill"),
    scope: "final"
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.passed, false);
  assert.equal(result.violations[0]?.ruleId, "STYLE-SOURCE");
});
