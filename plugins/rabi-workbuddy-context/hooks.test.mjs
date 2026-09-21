import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
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
  return fileURLToPath(new URL(".", import.meta.url));
}

async function fixture(t, clientSource) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-hook-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "plugin");
  await fs.mkdir(path.join(root, "scripts", "lib"), { recursive: true });
  await fs.copyFile(path.join(pluginRoot(), "scripts", "rabi-workbuddy-hook.mjs"), path.join(root, "scripts", "rabi-workbuddy-hook.mjs"));
  const client = path.join(root, "scripts", "lib", "rabi-manager-client.mjs");
  if (clientSource === undefined) {
    await fs.copyFile(path.join(pluginRoot(), "scripts", "lib", "rabi-manager-client.mjs"), client);
  } else {
    await fs.writeFile(client, clientSource);
  }
  // No inherited Rabi discovery, helper, credentials, preload or proxy settings.
  const env = {
    PATH: path.dirname(process.execPath),
    SystemRoot: process.env.SystemRoot || "",
    ComSpec: process.env.ComSpec || "",
    HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home,
    XDG_DATA_HOME: home, TMPDIR: home, TEMP: home, TMP: home,
    RABIROUTE_HOST_EXE: path.join(home, "missing-host.exe"),
    CODEBUDDY_PLUGIN_ROOT: root,
    RABI_WORKBUDDY_LOG_DIR: path.join(home, "logs")
  };
  return { home, root, env };
}

const EXPECTED_HOOK_COMMAND = "node -e \"const path = require('node:path'); const { pathToFileURL } = require('node:url'); import(pathToFileURL(path.join(process.env.CODEBUDDY_PLUGIN_ROOT, 'scripts', 'rabi-workbuddy-hook.mjs')).href).catch((error) => { console.error(error); process.exit(1); })\"";

function runHookCommand(command, input, env, cwd) {
  // Registration syntax is asserted as data, never evaluated as a command.
  // In particular, retain the quoted -e body and plugin-root path expansion.
  assert.equal(path.dirname(cwd), os.tmpdir());
  assert.match(path.basename(cwd), /^workbuddy-hook-test-/);
  assert.equal(env.CODEBUDDY_PLUGIN_ROOT, path.join(cwd, "plugin"));
  const script = path.join(env.CODEBUDDY_PLUGIN_ROOT, "scripts", "rabi-workbuddy-hook.mjs");
  let args;
  if (typeof command === "string") {
    assert.equal(command, EXPECTED_HOOK_COMMAND);
    args = [script];
  } else {
    assert.ok(Array.isArray(command));
    assert.equal(command[0], script);
    assert.ok(command.length === 1 || (command.length === 2 && command[1] === "--self-check"));
    args = command;
  }
  return new Promise((resolve, reject) => {
    // Execution always uses the test runner's Node and the isolated fixture.
    const child = spawn(process.execPath, args, { shell: false, env, cwd, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function runFixture(f, input = "", selfCheck = false) {
  return runHookCommand([path.join(f.root, "scripts", "rabi-workbuddy-hook.mjs"), ...(selfCheck ? ["--self-check"] : [])], input, f.env, f.home);
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

test("Stop surfaces a non-blocking reminder failure with the WorkBuddy wording", async (t) => {
  const mock = await server((_request, response) => json(response, 503, { code: -1, message: "fixture failure" }));
  t.after(mock.close);
  const output = await handleHookInput({ hook_event_name: "Stop", session_id: "offline-stop" }, {
    managerUrl: mock.url,
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

test("explicit control receives a fail-open diagnostic naming WorkBuddy", async (t) => {
  const mock = await server((_request, response) => json(response, 503, { code: -1, message: "fixture failure" }));
  t.after(mock.close);
  const output = await handleHookInput({ hook_event_name: "UserPromptSubmit", session_id: "offline", prompt: "[rabi:use Example]" }, {
    managerUrl: mock.url,
    timeoutMs: 200
  });
  assert.match(output.hookSpecificOutput.additionalContext, /Rabi WorkBuddy/);
  assert.match(output.hookSpecificOutput.additionalContext, /不得使用插件本地缓存补造上下文/);
});

test("the registered hook resolves to the isolated fixture script and reaches mock Manager",  async (t) => {
  const mock = await server((_request, response) => json(response, 200, { code: 0, data: { additionalContext: "process integration" } }));
  t.after(() => mock.close());
  const root = pluginRoot();
  const hooks = JSON.parse(await fs.readFile(path.join(root, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const f = await fixture(t);
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "process",
    prompt: "hello"
  }, { ...f.env, RABI_MANAGER_URL: mock.url }, f.home);
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
      assert.equal(hook.command, EXPECTED_HOOK_COMMAND);
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

for (const context of ["", "fixture-context-body"]) {
  test(`--self-check requires an explicit response (injected=${Boolean(context)})`, async (t) => {
    let received;
    const mock = await server(async (request, response) => {
      received = await readBody(request);
      json(response, 200, { code: 0, data: { action: "none", additionalContext: context } });
    });
    t.after(mock.close);
    const f = await fixture(t);
    f.env.RABI_MANAGER_URL = mock.url;
    const result = await runFixture(f, "", true);
    assert.equal(result.code, context ? 0 : 1, result.stderr);
    assert.equal(result.timedOut, false);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.ok, Boolean(context));
    assert.equal(verdict.injected, context ? true : undefined);
    assert.equal(verdict.managerUrl, undefined);
    assert.equal(received.agentType, "workbuddy");
    assert.equal(received.hook_event_name, "SessionStart");
    assert.doesNotMatch(result.stdout, /fixture-context-body|https?:\/\//);
  });
}

for (const data of [null, undefined, {}, { action: "none", additionalContext: "" }, { additionalContext: "  \n " }, { additionalContext: 123 }, { additionalContext: "Rabi PC Manager 当前不可用：fixture-secret" }]) {
  test(`--self-check rejects absent or invalid evidence: ${JSON.stringify(data)}`, async (t) => {
    // The deliberately null handler reproduces the old false-positive path;
    // no discovery, HTTP, or real helper can run in this fixture.
    const f = await fixture(t, `export const AGENT_TYPE = "workbuddy";
      export async function handleHookInput() { return null; }
      export async function requestManager() { return ${JSON.stringify(data)}; }`);
    const result = await runFixture(f, "", true);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/);
  });
}

const secretError = "fixture-secret-token https://example.invalid/?token=fixture-secret-token\nprivate-body";

test("--self-check catches client errors without echoing messages or URLs", async (t) => {
  const f = await fixture(t, `export const AGENT_TYPE = "workbuddy";
    export async function handleHookInput() { return null; }
    export async function requestManager() { throw new Error(${JSON.stringify(secretError)}); }`);
  const result = await runFixture(f, "", true);
  assert.equal(result.code, 1);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, "manager-request-failed");
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|private-body|https?:\/\//);
});

test("self-check discovery is confined to the empty fixture home", async (t) => {
  const f = await fixture(t);
  const result = await runFixture(f, "", true);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(result.timedOut, false);
});

for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
  test(`ordinary ${event} stays fail-open and diagnostics cannot leak request errors`, async (t) => {
    const mock = await server((request, response) => {
      request.resume();
      json(response, 503, { code: -1, message: secretError });
    });
    t.after(mock.close);
    const f = await fixture(t);
    f.env.RABI_MANAGER_URL = mock.url;
    const result = await runFixture(f, { hook_event_name: event, session_id: secretError, cwd: secretError, prompt: "hello" });
    assert.equal(result.code, 0);
    const log = await fs.readFile(path.join(f.env.RABI_WORKBUDDY_LOG_DIR, "workbuddy-hook.jsonl"), "utf8");
    assert.doesNotMatch(result.stdout + result.stderr + log, /fixture-secret|private-body|https?:\/\//);
    if (["SessionStart", "Stop"].includes(event)) {
      const output = JSON.parse(result.stdout);
      assert.equal(output.decision, undefined);
      assert.equal(output.continue, event === "SessionStart" ? true : undefined);
    } else {
      assert.equal(result.stdout, "");
    }
    const entry = JSON.parse(log);
    assert.deepEqual(Object.keys(entry).sort(), ["elapsedMs", "event", "outcome"]);
    assert.equal(entry.event, event);
    assert.equal(typeof entry.elapsedMs, "number");
  });
}

test("explicit control remains fail-open with a sanitized diagnostic", async (t) => {
  const f = await fixture(t, `export const AGENT_TYPE = "workbuddy";
    export async function requestManager() { throw new Error("unused"); }
    export async function handleHookInput() { return { continue: true, hookSpecificOutput: {
      additionalContext: ${JSON.stringify(`Rabi PC Manager 当前不可用：${secretError}`)} } }; }`);
  const result = await runFixture(f, { hook_event_name: "UserPromptSubmit", prompt: "[rabi:use Example]" });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).continue, true);
  assert.doesNotMatch(result.stdout, /fixture-secret|private-body|https?:\/\//);
});

test("malformed input and thrown client errors produce only structured diagnostics", async (t) => {
  const f = await fixture(t, `export const AGENT_TYPE = "workbuddy";
    export async function requestManager() { throw new Error("unused"); }
    export async function handleHookInput() { throw new Error(${JSON.stringify(secretError)}); }`);
  for (const input of ["invalid-json-private-body", { hook_event_name: secretError }]) {
    const result = await runFixture(f, input);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).event, "unknown");
    assert.equal(JSON.parse(result.stderr).outcome, "failed");
  }
  const log = await fs.readFile(path.join(f.env.RABI_WORKBUDDY_LOG_DIR, "workbuddy-hook.jsonl"), "utf8");
  assert.doesNotMatch(log, /fixture-secret|private-body|https?:\/\//);
});

test("successful context and permission decisions are preserved but never logged", async (t) => {
  for (const [event, data, expected] of [
    ["SessionStart", { additionalContext: "private-body" }, { continue: true, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "private-body" } }],
    ["PreToolUse", { toolDecision: { permissionDecision: "deny", reason: "private-body" } }, { systemMessage: "private-body", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "private-body" } }],
    ["Stop", { followup: { decision: "block", reason: "private-body" } }, { decision: "block", reason: "private-body" }],
    ["SessionStart", { additionalContext: "" }, null]
  ]) {
    const mock = await server((request, response) => { request.resume(); json(response, 200, { code: 0, data }); });
    t.after(mock.close);
    const f = await fixture(t);
    f.env.RABI_MANAGER_URL = mock.url;
    const result = await runFixture(f, { hook_event_name: event, session_id: "private-body" });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout ? JSON.parse(result.stdout) : null, expected);
    const log = await fs.readFile(path.join(f.env.RABI_WORKBUDDY_LOG_DIR, "workbuddy-hook.jsonl"), "utf8");
    assert.doesNotMatch(log, /private-body/);
    assert.equal(JSON.parse(log).outcome, expected ? "delivered" : "noop");
  }
});

for (const event of ["PreToolUse", "Stop"]) {
  test(`failure markers cannot weaken the real client ${event} control`, async (t) => {
    const reason = `Rabi PC context service is unavailable: ${secretError}`;
    const data = event === "PreToolUse"
      ? { toolDecision: { permissionDecision: "deny", reason } }
      : { followup: { decision: "block", reason } };
    const mock = await server((request, response) => { request.resume(); json(response, 200, { code: 0, data }); });
    t.after(mock.close);
    const f = await fixture(t);
    f.env.RABI_MANAGER_URL = mock.url;
    const result = await runFixture(f, { hook_event_name: event });
    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    if (event === "PreToolUse") {
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(typeof output.hookSpecificOutput.permissionDecisionReason, "string");
    } else {
      assert.equal(output.decision, "block");
      assert.equal(typeof output.reason, "string");
    }
    assert.equal(output.continue, undefined);
    const log = await fs.readFile(path.join(f.env.RABI_WORKBUDDY_LOG_DIR, "workbuddy-hook.jsonl"), "utf8");
    assert.doesNotMatch(result.stdout + result.stderr + log, /fixture-secret|private-body|https?:\/\//);
  });
}

test("diagnostic sanitizing preserves explicit controls and updatedInput without blind copying", async (t) => {
  const updatedInput = { command: "echo business-payload", nested: { enabled: false } };
  const output = {
    continue: false, decision: "block", reason: secretError,
    systemMessage: `Rabi PC context service is unavailable: ${secretError}`,
    unexpected: secretError,
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: secretError, updatedInput,
      additionalContext: secretError, unexpected: secretError
    }
  };
  const f = await fixture(t, `export const AGENT_TYPE = "workbuddy";
    export async function requestManager() { throw new Error("unused"); }
    export async function handleHookInput() { return ${JSON.stringify(output)}; }`);
  const result = await runFixture(f, { hook_event_name: "PreToolUse" });
  assert.equal(result.code, 0);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.continue, false);
  assert.equal(actual.decision, "block");
  assert.equal(actual.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(actual.hookSpecificOutput.updatedInput, updatedInput);
  assert.equal(actual.unexpected, undefined);
  assert.equal(actual.hookSpecificOutput.unexpected, undefined);
  const log = await fs.readFile(path.join(f.env.RABI_WORKBUDDY_LOG_DIR, "workbuddy-hook.jsonl"), "utf8");
  assert.doesNotMatch(result.stdout + result.stderr + log, /fixture-secret|private-body|https?:\/\//);
  assert.doesNotMatch(log, /business-payload/);
});
