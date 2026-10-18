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
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

async function fixture(planStorageReady: () => boolean = () => true,
  beforeRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-api-"));
  const roleDir = path.join(root, "roles", "YeYu");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n由 Rabi Manager 管理。", "utf8");
  const service = new CodexHookContextService({
    rolesRoot: () => path.join(root, "roles"),
    storePath: path.join(root, "data", "codex-hook", "sessions.json"),
    planStorageReady
  });
  const server = http.createServer((request, response) => {
    if (beforeRequest && !beforeRequest(request, response)) return;
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
    service,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("authenticated remote Hook management needs no binding; source events and delayed writes retain authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "remote-node");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "dsh", sessionId: "own-session" }]);
  authority.setAgentEnabled("remote-node", "worker", true);
  let observed: (() => void) | undefined;
  const app = await fixture(() => true, (request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(403).end(); return false; }
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture.invalid").pathname,
      body, assertTrustedLanAgentPrincipal(request)?.binding));
    observed?.();
    return true;
  });
  t.after(async () => { await app.close(); fs.rmSync(app.root, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker", "content-type": "application/json" };
  const managed = await fetch(`${app.baseUrl}/api/codex-hook/sessions/another-target`, { method: "PUT", headers, body: JSON.stringify({ roleId: "YeYu" }) });
  assert.equal(managed.status, 200);
  const hookBody = { hook_event_name: "SessionStart", session_id: "own-session", agentType: "dsh" };
  assert.equal((await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST", headers, body: JSON.stringify(hookBody) })).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST", headers, body: JSON.stringify({ ...hookBody, session_id: "foreign" }) })).status, 400);
  assert.equal((await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST", headers, body: JSON.stringify({ ...hookBody, agentType: "codex" }) })).status, 400);

  const started = new Promise<void>(resolve => { observed = resolve; });
  let writer!: http.ClientRequest;
  const result = new Promise<number | undefined>((resolve, reject) => {
    writer = http.request(`${app.baseUrl}/api/codex-hook/sessions/revoked-target`, { method: "PUT", headers }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    writer.on("error", reject); writer.write('{"roleId":');
  });
  await started;
  authority.setAgentEnabled("remote-node", "worker", false);
  writer.end('"YeYu"}');
  assert.equal(await result, 400);
  assert.equal(app.service.getBinding("revoked-target"), null);
});

test("Codex Stop HTTP hook returns recovery gate 503 while ordinary context remains available", async (t) => {
  const app = await fixture(() => false);
  t.after(async () => {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  });

  const start = await fetch(`${app.baseUrl}/api/codex-hook/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-http" })
  });
  assert.equal(start.status, 200);

  const stop = await fetch(`${app.baseUrl}/api/codex-hook/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: "session-http", turn_id: "turn-1" })
  });
  const body = await stop.json() as Record<string, any>;
  assert.equal(stop.status, 503);
  assert.equal(body.error, "PLAN_STORAGE_STARTUP_UNAVAILABLE");
  assert.equal(body.commitState, "not_started");
});

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
