import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { AGENT_TYPE, handleHookInput } from "./scripts/lib/rabi-manager-client.mjs";

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  return {
    instance,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()))
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function pluginRoot() {
  return path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
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

test("the adapter tag defaults to workbuddy", () => {
  assert.equal(AGENT_TYPE, "workbuddy");
});

test("the hook tags every request so Manager never mistakes it for Codex", async (t) => {
  let received;
  const mock = await server(async (request, response) => {
    assert.equal(request.url, "/api/codex-hook/context");
    received = await readBody(request);
    json(response, 200, { code: 0, data: { additionalContext: "[Rabi Manager]\n统一上下文" } });
  });
  t.after(() => mock.close());
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "workbuddy-session",
    prompt: "触发器和注入器",
    cwd: "C:\\workspace"
  };
  const output = await handleHookInput(input, { managerUrl: mock.url });
  // The Manager reads `agentType` off the body and treats an absent tag as Codex,
  // so this field is the only thing keeping the two hook streams apart.
  assert.equal(received.agentType, "workbuddy");
  assert.equal(received.hook_event_name, "UserPromptSubmit");
  assert.equal(received.session_id, "workbuddy-session");
  assert.equal(output.hookSpecificOutput.additionalContext, "[Rabi Manager]\n统一上下文");
});

test("an unbound Manager response produces no hook output", async (t) => {
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { additionalContext: "" } }));
  t.after(() => mock.close());
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "unbound", prompt: "hello" }, { managerUrl: mock.url });
  assert.equal(output, null);
});

test("Stop applies the Manager followup once and never blocks a repeat", async (t) => {
  const followup = { decision: "block", reason: "Configured followup" };
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { followup } }));
  t.after(() => mock.close());
  assert.deepEqual(await handleHookInput({ hook_event_name: "Stop", session_id: "worker" }, { managerUrl: mock.url }), followup);
  assert.equal(await handleHookInput({ hook_event_name: "Stop", session_id: "worker", stop_hook_active: true }, { managerUrl: mock.url }), null);
});

test("Stop surfaces a non-blocking reminder failure with the WorkBuddy wording", async () => {
  const output = await handleHookInput({ hook_event_name: "Stop", session_id: "offline-stop" }, {
    managerUrl: "http://127.0.0.1:1",
    timeoutMs: 200
  });
  assert.match(output.systemMessage, /计划完成提醒/);
  assert.match(output.systemMessage, /未送达/);
  assert.equal(output.continue, undefined);
});

test("PreToolUse returns the supported deny shape for direct Agent task delivery", async (t) => {
  const mock = await server((_request, response) => json(response, 200, {
    code: 0,
    data: { toolDecision: { permissionDecision: "deny", reason: "请改用 RabiRoute Agent 任务桥并填写 responsePolicy。" } }
  }));
  t.after(() => mock.close());
  const output = await handleHookInput({
    hook_event_name: "PreToolUse",
    session_id: "workbuddy-session",
    tool_name: "send_message_to_thread",
    tool_input: { threadId: "target" }
  }, { managerUrl: mock.url });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /responsePolicy/);
  assert.equal(output.continue, undefined);
});

test("explicit control receives a fail-open diagnostic naming WorkBuddy", async () => {
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "offline", prompt: "[rabi:use YeYu]" }, {
    managerUrl: "http://127.0.0.1:1",
    timeoutMs: 200
  });
  assert.match(output.hookSpecificOutput.additionalContext, /Rabi WorkBuddy/);
  assert.match(output.hookSpecificOutput.additionalContext, /不得使用插件本地缓存补造上下文/);
});

test("the plugin hook command imports from CODEBUDDY_PLUGIN_ROOT and reaches Manager", async (t) => {
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { additionalContext: "process integration" } }));
  t.after(() => mock.close());
  const root = pluginRoot();
  const hooks = JSON.parse(await fs.readFile(path.join(root, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "process",
    prompt: "hello"
  }, { ...process.env, CODEBUDDY_PLUGIN_ROOT: root, RABI_MANAGER_URL: mock.url });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, "process integration");
});

test("the plugin registers the same five lifecycle events as the Codex hook package", async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot(), "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("every event resolves the hook through CODEBUDDY_PLUGIN_ROOT only", async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(pluginRoot(), "hooks", "hooks.json"), "utf8"));
  const groups = Object.values(hooks.hooks).flatMap((entry) => entry);
  for (const group of groups) {
    for (const hook of group.hooks) {
      assert.equal(hook.type, "command");
      assert.match(hook.command, /CODEBUDDY_PLUGIN_ROOT/);
      // A bare `PLUGIN_ROOT` is the Codex spelling; CodeBuddy always prefixes it.
      assert.doesNotMatch(hook.command, /\.codex|\.agents|(?<!CODEBUDDY_)PLUGIN_ROOT/);
    }
  }
  // CodeBuddy only honours `matcher` on PreToolUse / PostToolUse; leaving one on a
  // lifecycle event silently makes that hook never fire.
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    for (const group of hooks.hooks[event]) {
      assert.equal(group.matcher, undefined, `${event} must not carry a matcher`);
    }
  }
});
