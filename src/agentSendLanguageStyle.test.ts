import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateAgentSendLanguageStyle } from "./agentSendLanguageStyle.js";
import type { AgentSendRequest } from "./agentSend.js";
import { LanguageStyleValidator } from "./languageStyleValidation.js";
import type { AgentReplyOptions } from "./outbox.js";

function fixture(t: test.TestContext): { request: AgentSendRequest; options: AgentReplyOptions } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-send-style-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const skillDir = path.join(rootDir, "style");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "references", "style-data.json"), JSON.stringify({
    runtimeConstraints: {
      checks: [{
        id: "SEND-001",
        level: "warning",
        scope: ["final"],
        kind: "redundant_first_person_execution",
        patterns: ["我会"],
        message: "删除冗余第一人称。"
      }]
    }
  }), "utf8");
  return {
    request: {
      deliveryId: "style-send-1",
      sender: { agentType: "codex", sessionId: "thread-style-1" },
      routeId: "route-main",
      channel: "napcat",
      params: { target: "group", groupId: "456", replyToMessageId: "" },
      payload: { type: "text", text: "我会处理。" }
    },
    options: {
      rootDir,
      routeRoot: path.join(rootDir, "data", "route"),
      rolesRoot: path.join(rootDir, "data", "roles"),
      runtimes: [{
        id: "route-main",
        enabled: true,
        languageStyle: { styleSkillUrl: skillDir }
      }]
    }
  };
}

test("styleValidation defaults to 1 and requests confirmation on failure", async (t) => {
  const { request, options } = fixture(t);
  const decision = await evaluateAgentSendLanguageStyle(request, options, new LanguageStyleValidator());
  assert.equal(decision.blocked, true);
  assert.equal(decision.metadata?.mode, 1);
  assert.equal(decision.metadata?.result?.violations[0]?.ruleId, "SEND-001");
});

test("styleValidation 0 bypasses one send and keeps the persona binding", async (t) => {
  const { request, options } = fixture(t);
  const decision = await evaluateAgentSendLanguageStyle({ ...request, styleValidation: 0 }, options, new LanguageStyleValidator());
  assert.equal(decision.blocked, false);
  assert.deepEqual(decision.metadata, {
    mode: 0,
    bypassed: true,
    styleSkillUrl: options.runtimes[0].languageStyle?.styleSkillUrl
  });
  assert.ok(options.runtimes[0].languageStyle);
});
