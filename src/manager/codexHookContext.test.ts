import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexHookContextService, parseCodexHookControl } from "./codexHookContext.js";

function fixture(): { root: string; rolesRoot: string; roleDir: string; storePath: string; service: CodexHookContextService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "YeYu");
  const storePath = path.join(root, "data", "codex-hook", "sessions.json");
  const timestamp = new Date().toISOString();
  fs.mkdirSync(path.join(roleDir, "plans", "items", "active"), { recursive: true });
  fs.mkdirSync(path.join(roleDir, "memory", "recent"), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n温柔、清楚，只根据真实上下文行动。", "utf8");
  fs.writeFileSync(path.join(roleDir, "growth.md"), "# 成长\n\n不确定时承认不确定。", "utf8");
  fs.writeFileSync(path.join(roleDir, "plans", "items", "active", "plan-hook.json"), JSON.stringify({
    id: "plan-hook",
    title: "统一 Codex Hook 上下文",
    focus: "统一 Codex Hook 上下文",
    status: "进行中",
    currentStep: "复用 RabiRoute 管理机制",
    nextAction: "验证 Manager API",
    steps: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["统一管理"]
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), JSON.stringify({
    id: "memory-hook",
    title: "Hook 只做触发和注入",
    focus: "Hook 只做触发和注入",
    content: "人格、计划和记忆由 Rabi PC 管理。",
    createdAt: timestamp,
    updatedAt: timestamp,
    keywords: ["触发器和注入器"]
  }, null, 2), "utf8");
  return {
    root,
    rolesRoot,
    roleDir,
    storePath,
    service: new CodexHookContextService({ rolesRoot: () => rolesRoot, storePath })
  };
}

test("Codex hook control markers remain strict", () => {
  assert.deepEqual(parseCodexHookControl("[rabi:use YeYu]"), { action: "bind", roleId: "YeYu" });
  assert.deepEqual(parseCodexHookControl("hello [rabi:refresh]"), { action: "refresh" });
  assert.equal(parseCodexHookControl("please use YeYu"), null);
});

test("an unbound Codex session receives no Rabi context", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({ sessionId: "session-unbound", eventName: "UserPromptSubmit", prompt: "hello" });
  assert.equal(result.binding, null);
  assert.equal(result.additionalContext, "");
});

test("binding and base context are owned by Rabi Manager", (t) => {
  const { root, storePath, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = service.handleContext({
    sessionId: "session-yeyu",
    eventName: "UserPromptSubmit",
    prompt: "[rabi:use YeYu]",
    managerBaseUrl: "http://127.0.0.1:8790"
  });
  assert.equal(result.binding?.roleId, "YeYu");
  assert.match(result.additionalContext, /人格、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理/);
  assert.match(result.additionalContext, /温柔、清楚/);
  assert.match(result.additionalContext, /统一 Codex Hook 上下文/);
  assert.ok(fs.existsSync(storePath));
  assert.ok(result.additionalContext.length <= 6200);
});

test("prompt recall uses roleKnowledgeSnapshot and refreshes memory viewedAt", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-recall", "YeYu");
  service.handleContext({ sessionId: "session-recall", eventName: "SessionStart", source: "startup" });
  const result = service.handleContext({
    sessionId: "session-recall",
    eventName: "UserPromptSubmit",
    prompt: "这个 Hook 应该只是触发器和注入器"
  });
  assert.match(result.additionalContext, /memory-hook/);
  assert.match(result.additionalContext, /GET \/api\/roles\/YeYu\/memory\/recent\/memory-hook/);
  assert.doesNotMatch(result.additionalContext, /\[人格工作集\]/);
  const memory = JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8"));
  assert.equal(typeof memory.viewedAt, "string");
});

test("Rabi PC can proactively bind and unbind an exact Codex session", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = service.bindSession("session-direct", "YeYu");
  assert.equal(service.getBinding("session-direct")?.roleId, "YeYu");
  assert.equal(service.listBindings().length, 1);
  assert.equal(service.unbindSession("session-direct")?.sessionId, binding.sessionId);
  assert.equal(service.getBinding("session-direct"), null);
});

test("reasoning hooks inject new keyword matches once per turn", (t) => {
  const { root, roleDir, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-reasoning", "YeYu");
  service.handleContext({ sessionId: "session-reasoning", eventName: "SessionStart", source: "startup" });
  service.handleContext({
    sessionId: "session-reasoning",
    eventName: "UserPromptSubmit",
    turnId: "turn-1",
    prompt: "继续处理"
  });
  const pre = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PreToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" }
  });
  assert.match(pre.additionalContext, /Rabi 推理期上下文刷新/);
  assert.match(pre.additionalContext, /memory-hook/);
  const firstViewedAt = JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8")).viewedAt;
  const duplicatePost = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-1",
    toolName: "Bash",
    toolUseId: "tool-1",
    toolInput: { command: "echo 触发器和注入器" },
    toolResponse: "触发器和注入器"
  });
  assert.equal(duplicatePost.additionalContext, "");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(roleDir, "memory", "recent", "memory-hook.json"), "utf8")).viewedAt,
    firstViewedAt
  );
  const nextTurn = service.handleContext({
    sessionId: "session-reasoning",
    eventName: "PostToolUse",
    turnId: "turn-2",
    toolName: "Bash",
    toolUseId: "tool-2",
    toolResponse: "触发器和注入器"
  });
  assert.match(nextTurn.additionalContext, /memory-hook/);
});

test("irrelevant reasoning hooks remain silent", (t) => {
  const { root, service } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  service.bindSession("session-quiet", "YeYu");
  service.handleContext({ sessionId: "session-quiet", eventName: "SessionStart" });
  const result = service.handleContext({
    sessionId: "session-quiet",
    eventName: "PreToolUse",
    turnId: "turn-quiet",
    toolName: "Bash",
    toolInput: { command: "npm test" }
  });
  assert.equal(result.additionalContext, "");
});
