import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addRoleRoot,
  doctor,
  getBinding,
  handleHookInput,
  listRoles,
  listBindings,
  parseControl
} from "../scripts/lib/rabi-context-store.mjs";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-codex-context-"));
  const home = path.join(root, "store");
  const roles = path.join(root, "roles");
  const roleDir = path.join(roles, "YeYu");
  await fs.mkdir(path.join(roleDir, "plans", "items", "active"), { recursive: true });
  await fs.mkdir(path.join(roleDir, "memory", "recent"), { recursive: true });
  await fs.mkdir(path.join(roleDir, "skills"), { recursive: true });
  await fs.writeFile(path.join(roleDir, "persona.md"), "# 夜雨\n\n温柔、清楚，并只根据真实上下文行动。", "utf8");
  await fs.writeFile(path.join(roleDir, "growth.md"), "# Growth\n\n遇到不确定时承认不确定。", "utf8");
  await fs.writeFile(path.join(roleDir, "skills.md"), "# Skills\n\n先恢复上下文。", "utf8");
  await fs.writeFile(path.join(roleDir, "skills", "one-plan.md"), "# One plan", "utf8");
  await fs.writeFile(path.join(roleDir, "plans", "items", "active", "plan-rabi-hook.json"), JSON.stringify({
    id: "plan-rabi-hook",
    focus: "Rabi Codex Hook",
    status: "进行中",
    currentStep: "实现按会话人格注入",
    nextAction: "验证 hook",
    keywords: ["Codex Hook", "人格注入"],
    updatedAt: "2026-07-19T10:00:00.000Z"
  }), "utf8");
  await fs.writeFile(path.join(roleDir, "memory", "recent", "memory-persona.json"), JSON.stringify({
    id: "memory-persona",
    focus: "会话人格必须显式绑定",
    content: "未绑定会话不能继承其他会话的人格。",
    keywords: ["显式绑定", "人格"],
    updatedAt: "2026-07-19T10:00:00.000Z"
  }), "utf8");
  await addRoleRoot({ id: "fixture", rootPath: roles, label: "Fixture" }, home);
  return { root, home, roles };
}

function runHookCommand(command, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env, windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("control markers are strict and explicit", () => {
  assert.deepEqual(parseControl("[rabi:use YeYu]"), { action: "use", roleId: "YeYu" });
  assert.deepEqual(parseControl("hello [rabi:refresh]"), { action: "refresh" });
  assert.equal(parseControl("please use YeYu somehow"), null);
});

test("an unbound session receives no Rabi context", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = await handleHookInput({
    hook_event_name: "SessionStart",
    session_id: "session-unbound",
    cwd: root,
    source: "startup"
  }, { home });
  assert.equal(output, null);
});

test("doctor reports an empty local role root as available", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await doctor({ home, cwd: root });
  const local = report.roleRoots.find((item) => item.id === "local");
  const fixtureRoot = report.roleRoots.find((item) => item.id === "fixture");
  assert.equal(local.available, true);
  assert.equal(local.roleCount, 0);
  assert.equal(fixtureRoot.roleCount, 1);
});

test("a use marker binds and injects the persona in the same user turn", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = await handleHookInput({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-yeyu",
    turn_id: "turn-1",
    cwd: root,
    prompt: "[rabi:use YeYu] 从现在开始使用夜雨人格"
  }, { home });
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /角色 ID：YeYu/);
  assert.match(output.hookSpecificOutput.additionalContext, /温柔、清楚/);
  assert.equal((await getBinding("session-yeyu", home)).roleId, "YeYu");
});

test("later prompts inject matching knowledge without repeating the base persona", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await handleHookInput({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-recall",
    turn_id: "turn-1",
    cwd: root,
    prompt: "[rabi:use YeYu]"
  }, { home });
  const output = await handleHookInput({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-recall",
    turn_id: "turn-2",
    cwd: root,
    prompt: "Codex Hook 的人格注入下一步是什么？"
  }, { home });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /plan-rabi-hook/);
  assert.match(context, /验证 hook/);
  assert.doesNotMatch(context, /\[人格工作集\]/);
});

test("off removes only the current session binding", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "session-off", cwd: root, prompt: "[rabi:use YeYu]" }, { home });
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "session-off", cwd: root, prompt: "[rabi:off]" }, { home });
  assert.match(output.hookSpecificOutput.additionalContext, /解除当前会话/);
  assert.equal(await getBinding("session-off", home), null);
  assert.equal((await listBindings(home)).length, 0);
});

test("role listings deduplicate the same physical role directory", async (t) => {
  const { root, home, roles } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addRoleRoot({ id: "same-path", rootPath: roles, label: "Same path" }, home);
  const roleIds = (await listRoles({ home, cwd: root })).map((item) => item.roleId);
  assert.deepEqual(roleIds, ["YeYu"]);
});

test("refresh resolves a moved role directory without changing the session persona", async (t) => {
  const { root, home, roles } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "session-refresh", cwd: root, prompt: "[rabi:use YeYu]" }, { home });
  const movedRoles = path.join(root, "roles-moved");
  await fs.rename(roles, movedRoles);
  await addRoleRoot({ id: "fixture", rootPath: movedRoles, label: "Fixture moved" }, home);
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "session-refresh", cwd: root, prompt: "[rabi:refresh]" }, { home });
  assert.match(output.hookSpecificOutput.additionalContext, /角色 ID：YeYu/);
  assert.equal((await getBinding("session-refresh", home)).roleDir, path.join(movedRoles, "YeYu"));
});

test("hook output stays within the model-visible hook budget", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "session-budget", cwd: root, prompt: "[rabi:use YeYu]" }, { home });
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 6200);
});

test("the plugin hook command imports correctly from PLUGIN_ROOT", async (t) => {
  const { root, home } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-process",
    turn_id: "turn-process",
    cwd: root,
    prompt: "[rabi:use YeYu]",
    model: "test",
    permission_mode: "default"
  }, { ...process.env, PLUGIN_ROOT: pluginRoot, RABI_CODEX_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /角色 ID：YeYu/);
});
