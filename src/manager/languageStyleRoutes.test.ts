import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanguageStyleValidator } from "../languageStyleValidation.js";
import { handleLanguageStyleApi } from "./languageStyleRoutes.js";

test("Manager language style API returns pass or fail with reasons", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-style-api-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const skillDir = path.join(rootDir, "style");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "references", "style-data.json"), JSON.stringify({
    runtimeConstraints: {
      checks: [{
        id: "API-001",
        level: "error",
        scope: ["final"],
        kind: "forbidden_phrases",
        values: ["一句话总结"],
        message: "删除套话。"
      }]
    }
  }), "utf8");
  const validator = new LanguageStyleValidator();
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handleLanguageStyleApi(request, requestUrl, response, validator)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/language-style/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "一句话总结。", styleSkillUrl: skillDir, scope: "final" })
  });
  const payload = await response.json() as { code: number; data: { passed: boolean; violations: Array<{ ruleId: string }> } };
  assert.equal(response.status, 200);
  assert.equal(payload.code, 0);
  assert.equal(payload.data.passed, false);
  assert.equal(payload.data.violations[0]?.ruleId, "API-001");
});
