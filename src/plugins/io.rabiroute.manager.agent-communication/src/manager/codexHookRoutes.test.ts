import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexHookContextService } from "../../../../manager/codexHookContext.js";
import { createCodexHookOperations } from "./codexHookRoutes.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "../../../../manager/apiOperationCatalog.js";
import { LanAgentAuthority } from "../../../../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../../../../manager/lanAgentRequestAccess.js";
import { captureTrustedLanAgentSource, registerLanAgentBodyGuard } from "../../../../manager/lanAgentBodyAuthority.js";

async function fixture(beforeRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-codex-hook-api-"));
  const roleDir = path.join(root, "roles", "YeYu");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# 夜雨\n\n由 Rabi Manager 管理。", "utf8");
  const service = new CodexHookContextService({
    rolesRoot: () => path.join(root, "roles"),
    storePath: path.join(root, "data", "codex-hook", "sessions.json"),
  });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("hook-test", createCodexHookOperations(service));
  const server = http.createServer((request, response) => {
    if (beforeRequest && !beforeRequest(request, response)) return;
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!(registry.handle(request, requestUrl, response))) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  return {
    root,
    service,
    registry,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

test("authenticated remote Hook management needs no binding; source events and delayed writes retain authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-authority-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "remote-node");
  let observed: (() => void) | undefined;
  const admittedSources: Array<{ provider?: string; sessionId?: string }> = [];
  const app = await fixture((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") { response.writeHead(403).end(); return false; }
    const source = assertTrustedLanAgentPrincipal(request)?.source;
    admittedSources.push({ provider: source?.provider, sessionId: source?.sessionId });
    captureTrustedLanAgentSource(request, "test-admission");
    registerLanAgentBodyGuard(request, () => {});
    observed?.();
    return true;
  });
  t.after(async () => { await app.close(); fs.rmSync(app.root, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-type": "dsh", "x-rabiroute-session-id": "own-session", "content-type": "application/json" };
  const managed = await fetch(`${app.baseUrl}/api/codex-hook/sessions/another-target`, { method: "PUT", headers, body: JSON.stringify({ roleId: "YeYu" }) });
  assert.equal(managed.status, 200);
  assert.equal(app.service.getBinding("another-target"), null, "remote management must not overwrite local session coordinates");
  assert.equal(app.service.getBinding("another-target", { instanceId: "remote-node" }, "dsh")?.roleId, "YeYu");
  app.service.bindSession("own-session", "YeYu");
  let captured: Parameters<CodexHookContextService["handleHook"]>[0] | undefined;
  const actualHook = app.service.handleHook.bind(app.service);
  app.service.handleHook = async value => { captured = value; return actualHook(value); };
  const hookBody = { hook_event_name: "SessionStart", session_id: "own-session", agentType: "dsh" };
  const remoteContext = await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST", headers, body: JSON.stringify({ ...hookBody,
    instanceBinding: { instanceId: "forged", agentId: "forged" }, sourceInstance: { instanceId: "forged" },
    trustedRemoteSource: { nodeId: "forged", authorizationIncarnation: "forged" } }) });
  assert.equal(remoteContext.status, 200);
  assert.equal((await remoteContext.json()).data.binding, null, "body coordinates cannot select a local or forged persona binding");
  assert.deepEqual(captured?.sourceInstance, { instanceId: "remote-node" });
  assert.equal(captured?.trustedRemoteSource?.nodeId, "remote-node");
  assert.equal(captured?.trustedRemoteSource?.provider, "dsh");
  assert.equal(captured?.trustedRemoteSource?.sessionId, "own-session");
  assert.notEqual(captured?.trustedRemoteSource?.authorizationIncarnation, "forged");
  assert.ok(app.service.getBinding("own-session"), "local binding is retained");
  assert.equal((await fetch(`${app.baseUrl}/api/codex-hook/sessions/foreign`, { method: "PUT", headers, body: JSON.stringify({ roleId: "YeYu" }) })).status, 200);
  assert.equal(app.service.getBinding("foreign", { instanceId: "remote-node" }, "dsh")?.roleId, "YeYu", "connected management can address another target without changing source attribution");
  for (const body of [{ ...hookBody, session_id: "foreign" }, { ...hookBody, agentType: "codex" }]) {
    const result = await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(result.status, 200, "retired source-description eligibility checks are not restored");
    assert.equal((await result.json()).data.binding, null, "trusted producer coordinates still prevent binding impersonation");
    assert.deepEqual(admittedSources.at(-1), { provider: "dsh", sessionId: "own-session" });
    assert.equal(captured?.sessionId, "own-session");
    assert.equal(captured?.agentType, "dsh");
  }

  assert.equal(app.service.getBinding("foreign"), null);
  assert.equal(app.service.getBinding("foreign", { instanceId: "remote-node" }, "dsh")?.lastEventName, undefined, "source event does not mutate the separately addressed target");
  assert.equal(app.service.getBinding("another-target", { instanceId: "remote-node" }, "dsh")?.lastEventName, undefined);

  const started = new Promise<void>(resolve => { observed = resolve; });
  let writer!: http.ClientRequest;
  const result = new Promise<number | undefined>((resolve, reject) => {
    writer = http.request(`${app.baseUrl}/api/codex-hook/sessions/revoked-target`, { method: "PUT", headers }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    writer.on("error", reject); writer.write('{"roleId":');
  });
  await started;
  authority.revokeNode("remote-node");
  writer.end('"YeYu"}');
  assert.equal(await result, 403);
  assert.equal(app.service.getBinding("revoked-target"), null);
  assert.equal(app.service.getBinding("revoked-target", { instanceId: "remote-node" }, "dsh"), null);
});

test("a persona-bound DSH Stop succeeds over HTTP during unrelated recovery failure", async t => {
  const app = await fixture();
  t.after(async () => { await app.close(); fs.rmSync(app.root, { recursive: true, force: true }); });
  app.service.bindSession("dsh-session", "YeYu");
  app.service.listRoles = () => { throw new Error("Unrecovered global catalog"); };
  const response = await fetch(`${app.baseUrl}/api/codex-hook/context`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "Stop",
      session_id: "dsh-session", agentType: "dsh", turn_id: "dsh-turn", last_assistant_message: "Done" }) });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.code, 0);
  assert.equal(reply.data.planTaskCompletion.status, "ignored");
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
  const app = await fixture((request, response) => {
    if (request.url !== "/meta") return true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ applicationGenerationId: "hook-fixture-generation", managerInstanceId: "hook-fixture-manager",
      health: { live: true, state: "healthy", requiredReady: true } }));
    return false;
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  });
  const pluginRoot = fileURLToPath(new URL("../../../rabi-codex-context/", import.meta.url));
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command as string;
  const result = await runHookCommand(command, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-plugin-e2e",
    prompt: "[rabi:use YeYu]"
  }, { ...process.env, PLUGIN_ROOT: pluginRoot, RABIROUTE_MANAGER_URL: app.baseUrl, RABI_MANAGER_URL: app.baseUrl });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /由 Rabi Manager 管理/);
});
