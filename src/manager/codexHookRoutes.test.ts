import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexHookContextService } from "./codexHookContext.js";
import { handleCodexHookApi } from "./codexHookRoutes.js";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-api-"));
  const roleDir = path.join(root, "roles", "YeYu");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n由 Rabi Manager 管理。", "utf8");
  const service = new CodexHookContextService({
    rolesRoot: () => path.join(root, "roles"),
    storePath: path.join(root, "data", "codex-hook", "sessions.json")
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handleCodexHookApi(request, requestUrl, response, service)) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  return {
    root,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  const body = await response.json() as Record<string, any>;
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.equal(body.code, 0);
  return body;
}

function runHookCommand(command: string, input: unknown, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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

test("Codex Hook HTTP API binds, injects, lists, and unbinds through Manager", async (t) => {
  const app = await fixture();
  t.after(async () => {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  });

  const roles = await json(await fetch(`${app.baseUrl}/api/codex-hook/roles`));
  assert.deepEqual(roles.data.roleIds, ["YeYu"]);

  const binding = await json(await fetch(`${app.baseUrl}/api/codex-hook/sessions/session-http`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId: "YeYu" })
  }));
  assert.equal(binding.data.roleId, "YeYu");

  const context = await json(await fetch(`${app.baseUrl}/api/codex-hook/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-http", source: "resume" })
  }));
  assert.match(context.data.additionalContext, /由 Rabi Manager 管理/);
  assert.match(context.data.additionalContext, new RegExp(app.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const sessions = await json(await fetch(`${app.baseUrl}/api/codex-hook/sessions`));
  assert.equal(sessions.data.sessions[0].sessionId, "session-http");

  const removed = await json(await fetch(`${app.baseUrl}/api/codex-hook/sessions/session-http`, { method: "DELETE" }));
  assert.equal(removed.data.removed.roleId, "YeYu");
});

test("the packaged Codex Hook injects context produced by the Manager service", async (t) => {
  const app = await fixture();
  t.after(async () => {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  });
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pluginRoot = path.join(repositoryRoot, "plugins", "rabi-codex-context");
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command as string;
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-plugin-e2e",
    prompt: "[rabi:use YeYu]"
  }, { ...process.env, PLUGIN_ROOT: pluginRoot, RABI_MANAGER_URL: app.baseUrl });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /由 Rabi Manager 管理/);
});
